import type {
  AdapterCapabilities, CcEntityKind, CcInternalActionType, CcNetwork,
  CcPayload, CcSettingsValues, EntitySnapshot, GateResult,
} from "./types";
import { MICROS_PER_UNIT } from "./types";

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
  const p = input.action.payload as { newDailyBudgetMicros?: unknown; amountMicros?: unknown };
  const v = input.action.actionType === "create_budget" ? p?.amountMicros : p?.newDailyBudgetMicros;
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

const INTERNAL_ACTION_TYPES = new Set(["remove_negatives", "remove_entity"]);

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

const blastRadius: Gate = (i) =>
  gate("BLAST_RADIUS", "blocking", i.executedTodayForAccount < i.settings.maxActionsPerAccountDay,
    `${i.executedTodayForAccount}/${i.settings.maxActionsPerAccountDay} acciones ejecutadas hoy en esta cuenta.`);

const currencySanity: Gate = (i) => {
  const isBudget = i.action.actionType === "budget_update" || i.action.actionType === "create_budget";
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

const validateOnly: Gate = (i) => {
  if (i.network !== "google_ads") return gate("VALIDATE_ONLY", "blocking", true, "No aplica (solo Google).");
  if (!i.validateResult) return gate("VALIDATE_ONLY", "blocking", false, "Falta el ensayo validateOnly de Google.");
  return gate("VALIDATE_ONLY", "blocking", i.validateResult.ok,
    i.validateResult.ok ? "Ensayo validateOnly aprobado por Google." : `Google rechazó el ensayo: ${i.validateResult.detail ?? "error"}.`);
};

const absBudgetCap: Gate = (i) => {
  const isBudget = i.action.actionType === "budget_update" || i.action.actionType === "create_budget";
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
  if (i.action.actionType !== "create_campaign") return gate("PAUSED_ON_CREATE", "blocking", true, "No aplica.");
  const status = (i.action.payload as { status?: string })?.status;
  return gate("PAUSED_ON_CREATE", "blocking", status === "PAUSED",
    status === "PAUSED" ? "Campaña se crea en pausa." : `Campaña de creación debe nacer PAUSED (status=${status ?? "ausente"}).`);
};

const GATES: Gate[] = [
  killSwitch, capability, actionAllowed, drift, budgetDelta,
  blastRadius, currencySanity, learningPhase, trackingSignal, validateOnly,
  absBudgetCap, metaLearningReset, pausedOnCreate,
];

export function runGates(input: GateInput): GateResult[] {
  return GATES.map((g) => g(input));
}

export function blockingFailures(results: GateResult[]): GateResult[] {
  return results.filter((r) => r.severity === "blocking" && r.status === "fail");
}
