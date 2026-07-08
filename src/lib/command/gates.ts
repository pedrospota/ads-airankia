import type {
  AdapterCapabilities, CcEntityKind, CcInternalActionType, CcNetwork,
  CcPayload, CcSettingsValues, EntitySnapshot, GateResult,
} from "./types";
import { MICROS_PER_UNIT } from "./types";

/** v2.7: CPC floor is US$0.01 (10_000 micros) — CPCs are legitimately sub-unit, unlike the 1-unit budget floor. */
const CPC_FLOOR_MICROS = 10_000;

function newCpcMicros(input: GateInput): number | null {
  const v = (input.action.payload as { newCpcBidMicros?: unknown })?.newCpcBidMicros;
  return typeof v === "number" ? v : null;
}

export interface GateInput {
  settings: CcSettingsValues;
  network: CcNetwork;
  action: { actionType: CcInternalActionType; entityKind: CcEntityKind; entityRef: string; payload: CcPayload };
  capabilities: AdapterCapabilities;
  before: EntitySnapshot;
  /** Baseline captured at approve time. Only present fields are compared. */
  expected?: Partial<EntitySnapshot> | null;
  executedTodayForAccount: number;
  /** Google validateOnly rehearsal result; null when not applicable. */
  validateResult?: { ok: boolean; detail?: string } | null;
}

type Gate = (input: GateInput) => GateResult;

const gate = (
  id: string, severity: GateResult["severity"], pass: boolean, evidence: string
): GateResult => ({ id, severity, status: pass ? "pass" : "fail", evidence });

function budgetMicros(input: GateInput): number | null {
  const p = input.action.payload as { newDailyBudgetMicros?: unknown; amountMicros?: unknown; dailyBudgetMicros?: unknown };
  const v = input.action.actionType === "create_budget"
    ? p?.amountMicros
    : input.action.actionType === "create_adset"
      ? p?.dailyBudgetMicros
      : p?.newDailyBudgetMicros;
  return typeof v === "number" ? v : null;
}

const killSwitch: Gate = (i) =>
  gate("KILL_SWITCH", "blocking", !i.settings.executionsPaused,
    i.settings.executionsPaused ? "Ejecuciones pausadas (kill switch activo en ajustes)." : "Kill switch inactivo.");

const capability: Gate = (i) => {
  const ok = i.capabilities.write && (i.capabilities.actionTypes ?? []).includes(i.action.actionType);
  return gate("CAPABILITY", "blocking", ok,
    ok ? "El adaptador soporta escritura y este tipo de acción."
       : `Adaptador sin capacidad: ${i.capabilities.reason ?? `no soporta ${i.action.actionType}`}.`);
};

// v2.7: "remove_negatives" is PROMOTED to a normal user-proposable verb — it
// now faces ACTION_ALLOWED like any other verb. "remove_entity" is the sole
// remaining internal-only type. Its rollback-of-add_negatives usage still
// executes even when remove_negatives is un-allow-listed, because the
// executor's rollback path filters blocking gates down to a hard-blocker list
// that EXCLUDES ACTION_ALLOWED (executor.ts) — not because of this set.
const INTERNAL_ACTION_TYPES = new Set(["remove_entity"]);

const actionAllowed: Gate = (i) => {
  // Internal rollback types are always allowed (a rollback restores prior state).
  if (INTERNAL_ACTION_TYPES.has(i.action.actionType)) {
    return gate("ACTION_ALLOWED", "blocking", true, `${i.action.actionType} (rollback interno).`);
  }
  const ok = ((i.settings.allowedActionTypes as string[] | undefined) ?? []).includes(i.action.actionType);
  return gate("ACTION_ALLOWED", "blocking", ok,
    ok ? `${i.action.actionType} permitido por ajustes.` : `${i.action.actionType} no está en allowed_action_types.`);
};

const drift: Gate = (i) => {
  if (!i.expected) return gate("DRIFT", "blocking", true, "Sin baseline registrado (acción sin expected).");
  const problems: string[] = [];
  if (i.expected.status !== undefined && i.expected.status !== i.before.status) {
    problems.push(`status esperado ${i.expected.status}, real ${i.before.status}`);
  }
  if (
    i.expected.dailyBudgetMicros !== undefined && i.expected.dailyBudgetMicros !== null &&
    i.before.dailyBudgetMicros !== undefined && i.before.dailyBudgetMicros !== null &&
    i.expected.dailyBudgetMicros !== i.before.dailyBudgetMicros
  ) {
    problems.push(`presupuesto esperado ${i.expected.dailyBudgetMicros}, real ${i.before.dailyBudgetMicros}`);
  }
  // v2.7: same both-present pattern as dailyBudgetMicros above — a legacy
  // approved row without expected.cpcBidMicros (or a smart-bidding entity with
  // before.cpcBidMicros null) must never false-block here.
  if (
    i.expected.cpcBidMicros !== undefined && i.expected.cpcBidMicros !== null &&
    i.before.cpcBidMicros !== undefined && i.before.cpcBidMicros !== null &&
    i.expected.cpcBidMicros !== i.before.cpcBidMicros
  ) {
    problems.push(`CPC esperado ${i.expected.cpcBidMicros}, real ${i.before.cpcBidMicros}`);
  }
  return gate("DRIFT", "blocking", problems.length === 0,
    problems.length ? `La entidad cambió desde la aprobación: ${problems.join("; ")}.` : "Estado real coincide con el baseline.");
};

const budgetDelta: Gate = (i) => {
  if (i.action.actionType !== "budget_update") return gate("BUDGET_DELTA", "blocking", true, "No aplica (no es cambio de presupuesto).");
  const next = budgetMicros(i);
  const prev = i.before.dailyBudgetMicros ?? null;
  if (next === null || next <= 0) return gate("BUDGET_DELTA", "blocking", false, "Presupuesto nuevo ausente o ≤ 0.");
  if (prev === null || prev <= 0) return gate("BUDGET_DELTA", "blocking", false, "Sin presupuesto base medible para calcular el delta.");
  const deltaPct = Math.abs(next - prev) / prev * 100;
  return gate("BUDGET_DELTA", "blocking", deltaPct <= i.settings.maxBudgetDeltaPct,
    `Delta ${deltaPct.toFixed(1)}% (límite ${i.settings.maxBudgetDeltaPct}%).`);
};

// v2.7: reuses settings.maxBudgetDeltaPct (no new settings column). Null
// before.cpcBidMicros fails OPEN — a smart-bidding ad group legitimately has
// no manual CPC to diff against; validateOnly is the real backstop there, and
// CPC isn't budget so an open-fail here is never over-spend.
const cpcDelta: Gate = (i) => {
  if (i.action.actionType !== "update_cpc") return gate("CPC_DELTA", "blocking", true, "No aplica (no es cambio de CPC).");
  const prev = i.before.cpcBidMicros ?? null;
  if (prev === null) {
    return gate("CPC_DELTA", "blocking", true, "Sin CPC base (puja automática); validateOnly es el respaldo.");
  }
  const next = newCpcMicros(i);
  if (next === null) return gate("CPC_DELTA", "blocking", false, "CPC nuevo ausente.");
  const deltaPct = Math.abs(next - prev) / prev * 100;
  return gate("CPC_DELTA", "blocking", deltaPct <= i.settings.maxBudgetDeltaPct,
    `Delta ${deltaPct.toFixed(1)}% (límite ${i.settings.maxBudgetDeltaPct}%).`);
};

const blastRadius: Gate = (i) =>
  gate("BLAST_RADIUS", "blocking", i.executedTodayForAccount < i.settings.maxActionsPerAccountDay,
    `${i.executedTodayForAccount}/${i.settings.maxActionsPerAccountDay} acciones ejecutadas hoy en esta cuenta.`);

const currencySanity: Gate = (i) => {
  // v2.7: update_cpc is a SEPARATE clause — it is NOT budget, so it never runs
  // through budgetMicros()/the 1-unit floor, and never trips ABS_BUDGET_CAP
  // (that gate's isBudget check below deliberately excludes update_cpc).
  if (i.action.actionType === "update_cpc") {
    const next = newCpcMicros(i);
    const ok = next !== null && Number.isInteger(next) && next >= CPC_FLOOR_MICROS;
    return gate("CURRENCY_SANITY", "blocking", ok,
      ok ? `CPC ${next} micros (≥ ${CPC_FLOOR_MICROS}, entero).` : `CPC inválido: ${next} micros (mínimo ${CPC_FLOOR_MICROS}, entero).`);
  }
  const isBudget = i.action.actionType === "budget_update" || i.action.actionType === "create_budget" || i.action.actionType === "create_adset";
  if (!isBudget) return gate("CURRENCY_SANITY", "blocking", true, "No aplica.");
  const next = budgetMicros(i);
  const ok = next !== null && Number.isInteger(next) && next >= MICROS_PER_UNIT;
  return gate("CURRENCY_SANITY", "blocking", ok,
    ok ? `Presupuesto ${next} micros (≥ 1 unidad, entero).` : `Presupuesto inválido: ${next} micros (mínimo ${MICROS_PER_UNIT}, entero).`);
};

const learningPhase: Gate = (i) => {
  const learning = i.before.learningPhase === "LEARNING" || i.before.learningPhase === "LIMITED";
  const scaling = i.action.actionType === "budget_update" || i.action.actionType === "enable";
  if (!learning) return gate("LEARNING_PHASE", "blocking", true, `Fase: ${i.before.learningPhase ?? "desconocida"}.`);
  if (i.network === "meta_ads" && i.action.entityKind === "adset" && scaling) {
    return gate("LEARNING_PHASE", "blocking", false, "Ad set en fase de aprendizaje: no escalar/activar hasta salir de learning.");
  }
  return gate("LEARNING_PHASE", "warning", false, "Entidad en aprendizaje: cambio desaconsejado (advertencia).");
};

const trackingSignal: Gate = (i) => {
  const spend = i.before.spend30dMicros ?? 0;
  const conv = i.before.conversions30d;
  const blind = conv === 0 && spend > 0;
  return gate("TRACKING_SIGNAL", "warning", !blind,
    blind ? "Gasto en 30d sin conversiones registradas: revisar medición antes de operar." : "Señal de conversión presente o sin gasto.");
};

const CREATE_FAMILY = new Set(["create_campaign", "create_adset", "create_ad"]);

const validateOnly: Gate = (i) => {
  const requiresRehearsal = i.network === "google_ads" || (i.network === "meta_ads" && CREATE_FAMILY.has(i.action.actionType));
  if (!requiresRehearsal) return gate("VALIDATE_ONLY", "blocking", true, "No aplica.");
  if (i.network === "google_ads") {
    if (!i.validateResult) return gate("VALIDATE_ONLY", "blocking", false, "Falta el ensayo validateOnly de Google.");
    return gate("VALIDATE_ONLY", "blocking", i.validateResult.ok,
      i.validateResult.ok ? "Ensayo validateOnly aprobado por Google." : `Google rechazó el ensayo: ${i.validateResult.detail ?? "error"}.`);
  }
  if (!i.validateResult) return gate("VALIDATE_ONLY", "blocking", false, "Falta el ensayo de validación de Meta.");
  return gate("VALIDATE_ONLY", "blocking", i.validateResult.ok,
    i.validateResult.ok ? "Ensayo de validación de Meta aprobado." : `Meta rechazó el ensayo: ${i.validateResult.detail ?? "error"}.`);
};

const absBudgetCap: Gate = (i) => {
  const isBudget = i.action.actionType === "budget_update" || i.action.actionType === "create_budget" || i.action.actionType === "create_adset";
  if (!isBudget || i.settings.maxDailyBudgetMicros == null) {
    return gate("ABS_BUDGET_CAP", "blocking", true, "No aplica (sin tope absoluto o no es presupuesto).");
  }
  const next = budgetMicros(i);
  const ok = next !== null && next <= i.settings.maxDailyBudgetMicros;
  const evidence = next === null
    ? "Presupuesto ausente para evaluar el tope absoluto."
    : ok
      ? `Presupuesto ${next} ≤ tope ${i.settings.maxDailyBudgetMicros} micros.`
      : `Presupuesto ${next} supera el tope absoluto ${i.settings.maxDailyBudgetMicros} micros.`;
  return gate("ABS_BUDGET_CAP", "blocking", ok, evidence);
};

const metaLearningReset: Gate = (i) => {
  if (i.network !== "meta_ads" || i.action.actionType !== "budget_update") {
    return gate("META_LEARNING_RESET", "warning", true, "No aplica.");
  }
  const next = budgetMicros(i);
  const prev = i.before.dailyBudgetMicros ?? null;
  if (next === null || prev === null || prev <= 0) return gate("META_LEARNING_RESET", "warning", true, "Sin base para evaluar reinicio de aprendizaje.");
  const deltaPct = Math.abs(next - prev) / prev * 100;
  return gate("META_LEARNING_RESET", "warning", deltaPct <= 20,
    deltaPct <= 20 ? `Delta ${deltaPct.toFixed(1)}% ≤ 20% (no reinicia aprendizaje).`
                   : `Delta ${deltaPct.toFixed(1)}% > 20%: reiniciará la fase de aprendizaje de Meta.`);
};

const pausedOnCreate: Gate = (i) => {
  const isCreate = i.action.actionType === "create_campaign" || i.action.actionType === "create_adset";
  if (!isCreate) return gate("PAUSED_ON_CREATE", "blocking", true, "No aplica.");
  const status = (i.action.payload as { status?: string })?.status;
  const label = i.action.actionType === "create_campaign" ? "Campaña" : "Ad set";
  return gate("PAUSED_ON_CREATE", "blocking", status === "PAUSED",
    status === "PAUSED" ? `${label} se crea en pausa.` : `${label} de creación debe nacer PAUSED (status=${status ?? "ausente"}).`);
};

const GATES: Gate[] = [
  killSwitch, capability, actionAllowed, drift, budgetDelta,
  blastRadius, currencySanity, learningPhase, trackingSignal, validateOnly,
  absBudgetCap, metaLearningReset, pausedOnCreate, cpcDelta,
];

export function runGates(input: GateInput): GateResult[] {
  return GATES.map((g) => g(input));
}

export function blockingFailures(results: GateResult[]): GateResult[] {
  return results.filter((r) => r.severity === "blocking" && r.status === "fail");
}
