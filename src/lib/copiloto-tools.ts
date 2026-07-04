/**
 * copiloto-tools.ts — tool belt of the Copiloto (AI chat over the user's own
 * Google Ads data, measured by the optimizer engine).
 *
 * ⚠️ SERVER-ONLY. Imports src/lib/sentinel.ts, which reads SENTINEL_API_KEY and
 * talks to the headless engine server-to-server. NEVER import this from a
 * client component ("use client") — only from the /api/copiloto route handler.
 *
 * Exposes:
 *   - copilotoTools: OpenAI-compatible function declarations (works with any
 *     OpenRouter model that supports tool calling).
 *   - CopilotoMode ("lectura" | "dryrun") + toolsForMode(mode): read tools are
 *     always offered; the write-INTENT tools (propose_* / record_proposal)
 *     only in "dryrun".
 *   - executeTool(name, args, mode): dispatcher mapping each tool to its
 *     sentinel fetcher. Always returns a JSON string TRIMMED to a size an LLM
 *     can digest: long arrays sliced to 30 items, huge raw snapshots
 *     (diagnostic / audit_ai > ~15KB) dropped, and every cut noted inside the
 *     payload.
 *
 * 🔒 SACRED CONSTRAINT — this platform NEVER executes against Google Ads.
 * There is NO "write" mode: only "lectura" (blocks write-intent tools) and
 * "dryrun" (write-intent tools SIMULATE — they return a preview of the
 * Google Ads mutation they WOULD be, without calling any mutate, ever).
 * The ONLY side effect in this file is record_proposal → postApprove, the
 * engine's propose-only Approval record (shows up in the account's Acciones
 * tab and the approved-changes CSV; a human applies it via Google Ads
 * Editor). No google-ads write function is imported anywhere here.
 */

import { createHash } from "node:crypto";
import {
  fetchPortfolio,
  fetchAccountFull,
  fetchRecommendations,
  fetchSecurity,
  fetchTriage,
  fetchSimulacion,
  fetchBacktest,
  fetchPlaybook,
  fetchScorecard,
  fetchSalud,
  fetchCosts,
  postApprove,
} from "@/lib/sentinel";

// ---------------------------------------------------------------------------
// Tool declarations (OpenAI Chat Completions `tools` format)
// ---------------------------------------------------------------------------

export interface CopilotoTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = []
): CopilotoTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      },
    },
  };
}

export const copilotoTools: CopilotoTool[] = [
  tool(
    "get_portfolio",
    "Portfolio del workspace: cada cuenta de Google Ads analizada con inversión 30d, ahorro detectado, oportunidad, nº de propuestas, salud (0-100), propuesta top y fecha de análisis. Punto de partida para casi cualquier pregunta y la fuente de los account_id."
  ),
  tool(
    "get_account",
    "Detalle completo de UNA cuenta: KPIs medidos, plan de optimización, recomendaciones con evidencia (USD en juego, confianza), auditoría por categorías, aprobaciones y perfil de negocio. Requiere el account_id tal y como aparece en get_portfolio.",
    {
      account_id: {
        type: "string",
        description: "ID de la cuenta de Google Ads (customer id) según get_portfolio.",
      },
    },
    ["account_id"]
  ),
  tool(
    "get_recommendations",
    "Todas las recomendaciones/propuestas vigentes agrupadas por cuenta, con familia de acción, target, dólares en juego y confianza. Útil para '¿qué movida hago ahora?' o para comparar evidencia entre cuentas."
  ),
  tool(
    "get_security",
    "Eventos de seguridad recientes del MCC: cambios de URL, cambios de presupuesto y hallazgos de reglas de vigilancia (quién, qué, cuándo, valor anterior → nuevo)."
  ),
  tool(
    "get_triage",
    "Auditoría MCC (triage): nota y score de auditoría por cuenta, nº de fallos/avisos y las peores categorías de cada una. Útil para priorizar dónde mirar primero."
  ),
  tool(
    "get_simulacion",
    "Apuestas en modo sombra (shadow bets): qué habría pasado si se hubieran aplicado las propuestas — estado, efecto neto %, confianza y dinero perdido por no actuar (missed_usd). Opcionalmente filtrable por cuenta.",
    {
      account_id: {
        type: "string",
        description: "Opcional: limitar la simulación a una cuenta concreta.",
      },
    }
  ),
  tool(
    "get_backtest",
    "Backtest del motor: rendimiento histórico medido de las recomendaciones (aciertos, efecto neto) que valida la evidencia del sistema."
  ),
  tool(
    "get_playbook",
    "Playbook del portfolio: matriz cuenta × familia de acción con la evidencia medida de qué funciona en cada cuenta. Ideal para '¿qué movida tiene mejor evidencia?'."
  ),
  tool(
    "get_scorecard",
    "Scorecard de resultados por cuenta: cómo han rendido a lo largo del tiempo las propuestas medidas."
  ),
  tool(
    "get_salud",
    "Salud operativa del optimizador: token conectado, minutos desde el último análisis, nº de recomendaciones y hallazgos abiertos, y estado de los colectores. Útil si el usuario duda de si los datos están frescos o si hay cuentas conectadas."
  ),
  tool(
    "get_costs",
    "Costes de IA del propio motor (llamadas LLM por día/modelo, tokens y USD). NO es la inversión de Google Ads — para eso usa get_portfolio.",
    {
      days: {
        type: "number",
        description: "Ventana en días (1-90). Por defecto 30.",
      },
    }
  ),
];

// ---------------------------------------------------------------------------
// Modes + write-INTENT tools (dry-run layer).
//
// "lectura"  → only the read tools above; any propose_*/record_proposal call
//              is blocked (defense in depth: they aren't even offered).
// "dryrun"   → propose_* tools SIMULATE: they validate against the measured
//              account data and return {dryRun, wouldDo, current,
//              mutation_preview, note} — NEVER a Google Ads mutate.
//              record_proposal is the ONLY tool with a side effect: it records
//              a propose-only Approval in the engine (postApprove).
// There is deliberately NO "write" mode in this codebase.
// ---------------------------------------------------------------------------

export type CopilotoMode = "lectura" | "dryrun";

const BLOCKED_NOTE =
  "Modo solo-lectura: cambia a Dry-run para simular cambios.";
const DRYRUN_NOTE =
  "SIMULACIÓN (dry-run): NO se modificó nada en Google Ads.";

const WRITE_TOOL_NAMES = new Set([
  "propose_budget_change",
  "propose_pause_campaign",
  "propose_negative_keyword",
  "propose_bid_modifier",
  "record_proposal",
]);

export const copilotoWriteTools: CopilotoTool[] = [
  tool(
    "propose_budget_change",
    "SIMULA (dry-run) un cambio de presupuesto diario de una campaña. NUNCA toca Google Ads: valida la campaña contra los datos medidos de la cuenta y devuelve el estado actual + un preview de la mutación que HARÍA.",
    {
      account_id: {
        type: "string",
        description: "ID de la cuenta de Google Ads (customer id) según get_portfolio.",
      },
      campaign: {
        type: "string",
        description: "Nombre o id de la campaña tal y como aparece en los datos medidos.",
      },
      new_daily_budget: {
        type: "number",
        description: "Nuevo presupuesto diario propuesto (moneda de la cuenta), > 0.",
      },
    },
    ["account_id", "campaign", "new_daily_budget"]
  ),
  tool(
    "propose_pause_campaign",
    "SIMULA (dry-run) pausar una campaña. NUNCA toca Google Ads: valida la campaña contra los datos medidos y devuelve un preview de la mutación que HARÍA.",
    {
      account_id: {
        type: "string",
        description: "ID de la cuenta de Google Ads (customer id) según get_portfolio.",
      },
      campaign: {
        type: "string",
        description: "Nombre o id de la campaña a pausar.",
      },
      reason: {
        type: "string",
        description: "Opcional: motivo de la pausa (para el registro).",
      },
    },
    ["account_id", "campaign"]
  ),
  tool(
    "propose_negative_keyword",
    "SIMULA (dry-run) añadir una keyword negativa. NUNCA toca Google Ads: devuelve un preview de la mutación que HARÍA.",
    {
      account_id: {
        type: "string",
        description: "ID de la cuenta de Google Ads (customer id) según get_portfolio.",
      },
      keyword: {
        type: "string",
        description: "Texto de la keyword negativa.",
      },
      match_type: {
        type: "string",
        enum: ["EXACT", "PHRASE", "BROAD"],
        description: "Tipo de concordancia de la negativa.",
      },
      scope: {
        type: "string",
        enum: ["campaign", "account"],
        description: "Ámbito de la negativa. Por defecto, account.",
      },
    },
    ["account_id", "keyword", "match_type"]
  ),
  tool(
    "propose_bid_modifier",
    "SIMULA (dry-run) un ajuste de puja por dispositivo, geografía u horario. NUNCA toca Google Ads: devuelve un preview de la mutación que HARÍA.",
    {
      account_id: {
        type: "string",
        description: "ID de la cuenta de Google Ads (customer id) según get_portfolio.",
      },
      dimension: {
        type: "string",
        enum: ["device", "geo", "schedule"],
        description: "Dimensión del ajuste de puja.",
      },
      segment: {
        type: "string",
        description: "Segmento concreto (p. ej. 'mobile', 'Ciudad de México', 'lun-vie 9-18h').",
      },
      modifier_pct: {
        type: "number",
        description: "Ajuste en % (-90 a 900). Ej.: -20 baja la puja un 20%.",
      },
    },
    ["account_id", "dimension", "segment", "modifier_pct"]
  ),
  tool(
    "record_proposal",
    "Registra una PROPUESTA (propose-only) en el motor tras confirmación EXPLÍCITA del usuario. Es el único paso con efecto: crea una aprobación que aparece en la pestaña Acciones y en el export CSV para que un humano la aplique vía Google Ads Editor. NO ejecuta nada en Google Ads.",
    {
      account_id: {
        type: "string",
        description: "ID de la cuenta de Google Ads (customer id) según get_portfolio.",
      },
      title: {
        type: "string",
        description: "Título corto y accionable de la propuesta (máx. 180 caracteres).",
      },
      detail_json: {
        type: "string",
        description: "Opcional: detalle de la propuesta como JSON (objeto) serializado, p. ej. el wouldDo del dry-run.",
      },
    },
    ["account_id", "title"]
  ),
];

/**
 * Tools offered to the model per mode: read tools always; write-INTENT tools
 * (simulation + propose-only record) only in "dryrun".
 */
export function toolsForMode(mode: CopilotoMode): CopilotoTool[] {
  return mode === "dryrun" ? [...copilotoTools, ...copilotoWriteTools] : copilotoTools;
}

// ---------------------------------------------------------------------------
// Payload trimming — the engine returns raw view payloads that can be huge;
// a tool result for an LLM must stay small. Arrays are sliced, long strings
// cut, and every cut is annotated in `_truncado` so the model knows the data
// is partial.
// ---------------------------------------------------------------------------

const MAX_ARRAY_ITEMS = 30;
const MAX_STRING_CHARS = 1500;
const MAX_PAYLOAD_CHARS = 60_000;
const MAX_SNAPSHOT_CHARS = 15_000;

function deepTrim(
  value: unknown,
  notes: string[],
  path: string,
  arrayCap: number,
  stringCap: number
): unknown {
  if (Array.isArray(value)) {
    let items = value;
    if (value.length > arrayCap) {
      items = value.slice(0, arrayCap);
      notes.push(`${path || "raíz"}: ${value.length} elementos → primeros ${arrayCap}`);
    }
    return items.map((v, i) => deepTrim(v, notes, `${path}[${i}]`, arrayCap, stringCap));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepTrim(v, notes, path ? `${path}.${k}` : k, arrayCap, stringCap);
    }
    return out;
  }
  if (typeof value === "string" && value.length > stringCap) {
    notes.push(`${path || "raíz"}: texto recortado a ${stringCap} caracteres`);
    return `${value.slice(0, stringCap)}…`;
  }
  return value;
}

/**
 * Serialize a tool result for the LLM. Two passes: a generous one, and — if
 * the payload is still too big — an aggressive one (10 items per list, short
 * strings). Truncations are noted inside the payload itself (`_truncado`).
 */
function toPayload(data: unknown): string {
  const notes: string[] = [];
  let trimmed = deepTrim(data, notes, "", MAX_ARRAY_ITEMS, MAX_STRING_CHARS);
  let body: Record<string, unknown> =
    notes.length > 0 ? { data: trimmed, _truncado: notes.slice(0, 20) } : { data: trimmed };
  let str = JSON.stringify(body);

  if (str.length > MAX_PAYLOAD_CHARS) {
    const notes2: string[] = [
      "payload grande: recorte agresivo aplicado (máx. 10 elementos por lista)",
    ];
    trimmed = deepTrim(data, notes2, "", 10, 400);
    body = { data: trimmed, _truncado: notes2.slice(0, 20) };
    str = JSON.stringify(body);
  }

  if (str.length > MAX_PAYLOAD_CHARS) {
    return JSON.stringify({
      error:
        "La respuesta del optimizador es demasiado grande para procesarla entera. Pide un corte más específico (una cuenta concreta, menos días…).",
    });
  }
  return str;
}

/**
 * Account-full payloads carry raw snapshots (diagnostic / audit_ai) that can
 * weigh far more than everything else combined. If a snapshot alone exceeds
 * ~15KB serialized, drop it and leave a note in its place.
 */
function dropHeavySnapshots(full: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...full };
  for (const key of ["diagnostic", "audit_ai"]) {
    const snap = out[key];
    if (snap == null) continue;
    try {
      const size = JSON.stringify(snap).length;
      if (size > MAX_SNAPSHOT_CHARS) {
        out[key] = {
          _omitido: `snapshot crudo de ~${Math.round(size / 1024)}KB omitido (>15KB); usa el resto de campos (ai_plan, recommendations, audit), que ya lo resumen`,
        };
      }
    } catch {
      out[key] = { _omitido: "snapshot no serializable omitido" };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dry-run helpers — validate a campaign name/id against the MEASURED account
// data (diagnostic.saturation + audit checks) and sketch the Google Ads API
// operation the change WOULD be. All shapes are read defensively: the engine
// returns raw Python-view payloads that may grow.
// ---------------------------------------------------------------------------

/** Scalar keys worth surfacing as "current state" of a matched campaign. */
const CURRENT_STATE_KEYS = [
  "budget",
  "daily_budget",
  "budget_daily",
  "budget_usd",
  "amount",
  "cost",
  "cost_30d",
  "spend",
  "spend_30d",
  "is",
  "lost_budget",
  "verdict",
  "status",
  "id",
  "campaign_id",
] as const;

/** Keys that count as an actual budget/cost reading (not just context). */
const BUDGETISH_KEYS = new Set([
  "budget",
  "daily_budget",
  "budget_daily",
  "budget_usd",
  "amount",
  "cost",
  "cost_30d",
  "spend",
  "spend_30d",
]);

interface CampaignCandidate {
  name: string;
  source: string;
  info: Record<string, unknown>;
}

function pickScalars(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CURRENT_STATE_KEYS) {
    const v = entry[k];
    if (
      v != null &&
      (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    ) {
      out[k] = v;
    }
  }
  return out;
}

/** Collect campaign names seen by the optimizer, from every snapshot we have. */
function collectCampaigns(full: Record<string, unknown>): CampaignCandidate[] {
  const found: CampaignCandidate[] = [];
  const seen = new Set<string>();
  const push = (name: unknown, source: string, entry: Record<string, unknown>) => {
    if (typeof name !== "string" || !name.trim()) return;
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name: name.trim(), source, info: pickScalars(entry) });
  };

  // diagnostic.saturation — entries usually carry name + budget/cost info.
  const diag = full.diagnostic;
  if (diag && typeof diag === "object" && !Array.isArray(diag)) {
    const sat = (diag as Record<string, unknown>).saturation;
    if (Array.isArray(sat)) {
      for (const e of sat) {
        if (e && typeof e === "object" && !Array.isArray(e)) {
          const rec = e as Record<string, unknown>;
          push(rec.name ?? rec.campaign, "diagnostic.saturation", rec);
        }
      }
    }
  }

  // audit checks — campaigns may appear as check.campaign / check.campaigns.
  const audit = full.audit;
  if (audit && typeof audit === "object" && !Array.isArray(audit)) {
    const a = audit as Record<string, unknown>;
    const checkLists: unknown[] = [];
    if (Array.isArray(a.checks)) checkLists.push(...a.checks);
    if (Array.isArray(a.categories)) {
      for (const cat of a.categories) {
        if (cat && typeof cat === "object") {
          const checks = (cat as Record<string, unknown>).checks;
          if (Array.isArray(checks)) checkLists.push(...checks);
        }
      }
    }
    for (const check of checkLists) {
      if (!check || typeof check !== "object" || Array.isArray(check)) continue;
      const c = check as Record<string, unknown>;
      push(c.campaign ?? c.campaign_name, "audit", c);
      if (Array.isArray(c.campaigns)) {
        for (const camp of c.campaigns) {
          if (typeof camp === "string") {
            push(camp, "audit", {});
          } else if (camp && typeof camp === "object" && !Array.isArray(camp)) {
            const cc = camp as Record<string, unknown>;
            push(cc.name ?? cc.campaign ?? cc.campaign_name, "audit", cc);
          }
        }
      }
    }
  }

  return found;
}

/**
 * Resolve/validate a campaign (by name or id) against fetchAccountFull data.
 * Never throws: if the engine is unreachable or the campaign isn't in the
 * measured snapshots, the simulation still returns with "no validado".
 */
async function resolveCampaignCurrent(
  accountId: string,
  query: string
): Promise<Record<string, unknown>> {
  let candidates: CampaignCandidate[];
  try {
    const full = (await fetchAccountFull(accountId)) as unknown as Record<string, unknown>;
    candidates = collectCampaigns(full);
  } catch {
    return {
      validado: false,
      nota: "no validado: no se pudo consultar la cuenta en el optimizador",
    };
  }

  const q = query.trim().toLowerCase();
  const hit =
    candidates.find((c) => c.name.toLowerCase() === q) ??
    candidates.find(
      (c) =>
        String(c.info.campaign_id ?? "").toLowerCase() === q ||
        String(c.info.id ?? "").toLowerCase() === q
    ) ??
    candidates.find(
      (c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase())
    );

  if (!hit) {
    return {
      validado: false,
      nota: `no validado: "${query}" no aparece en los datos medidos de la cuenta`,
      ...(candidates.length > 0
        ? { campanas_detectadas: candidates.slice(0, 12).map((c) => c.name) }
        : {}),
    };
  }

  const hasBudget = Object.keys(hit.info).some((k) => BUDGETISH_KEYS.has(k));
  return {
    validado: true,
    campaign: hit.name,
    fuente: hit.source,
    ...(Object.keys(hit.info).length > 0 ? { estado_actual: hit.info } : {}),
    ...(hasBudget
      ? {}
      : { nota: "presupuesto actual no validado (el snapshot no trae cifras de presupuesto)" }),
  };
}

/** The guarded dry-run shape every propose_* returns. */
function dryRunResult(
  op: string,
  wouldDo: Record<string, unknown>,
  current: Record<string, unknown>,
  mutationPreview: { resource: string; operation: string; fields: Record<string, unknown> }
): string {
  return JSON.stringify({
    dryRun: true,
    op,
    wouldDo,
    current,
    mutation_preview: mutationPreview,
    note: DRYRUN_NOTE,
  });
}

function strArg(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function clampDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.min(90, Math.max(1, Math.round(n)));
}

/**
 * Run one tool call. Argument problems resolve to a JSON `{error}` string so
 * the model can self-correct; engine/network failures DO throw so the route
 * decides how to surface them.
 *
 * `mode` is the write candado: in "lectura" every propose_* or
 * record_proposal call returns the blocked shape (defense in depth — those
 * tools aren't even offered in lectura). In "dryrun" the propose_* tools
 * simulate and ONLY record_proposal has a side effect (a propose-only engine
 * Approval).
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  mode: CopilotoMode = "lectura"
): Promise<string> {
  // Candado de escritura: read mode blocks every write-intent tool.
  if (WRITE_TOOL_NAMES.has(name) && mode !== "dryrun") {
    return JSON.stringify({ blocked: true, op: name, note: BLOCKED_NOTE });
  }

  switch (name) {
    case "get_portfolio":
      return toPayload(await fetchPortfolio());

    case "get_account": {
      const id = typeof args.account_id === "string" ? args.account_id.trim() : "";
      if (!id) {
        return JSON.stringify({
          error: "account_id es obligatorio; consíguelo primero con get_portfolio",
        });
      }
      const full = await fetchAccountFull(id);
      return toPayload(dropHeavySnapshots(full as Record<string, unknown>));
    }

    case "get_recommendations":
      return toPayload(await fetchRecommendations());

    case "get_security":
      return toPayload(await fetchSecurity());

    case "get_triage":
      return toPayload(await fetchTriage());

    case "get_simulacion": {
      const account =
        typeof args.account_id === "string" && args.account_id.trim()
          ? args.account_id.trim()
          : undefined;
      return toPayload(await fetchSimulacion(account));
    }

    case "get_backtest":
      return toPayload(await fetchBacktest());

    case "get_playbook":
      return toPayload(await fetchPlaybook());

    case "get_scorecard":
      return toPayload(await fetchScorecard());

    case "get_salud":
      return toPayload(await fetchSalud());

    case "get_costs":
      return toPayload(await fetchCosts(clampDays(args.days)));

    // ---- Write-INTENT tools (dry-run only; NEVER touch Google Ads) --------

    case "propose_budget_change": {
      const id = strArg(args.account_id);
      const campaign = strArg(args.campaign);
      const budget = Number(args.new_daily_budget);
      if (!id || !campaign) {
        return JSON.stringify({
          error: "account_id y campaign son obligatorios (usa get_portfolio / get_account).",
        });
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        return JSON.stringify({ error: "new_daily_budget debe ser un número > 0." });
      }
      const current = await resolveCampaignCurrent(id, campaign);
      return dryRunResult(
        "propose_budget_change",
        { account_id: id, campaign, new_daily_budget: budget },
        current,
        {
          resource: "campaignBudgets",
          operation: "CampaignBudgetService.MutateCampaignBudgets (update)",
          fields: {
            campaign,
            "campaign_budget.amount_micros": Math.round(budget * 1_000_000),
          },
        }
      );
    }

    case "propose_pause_campaign": {
      const id = strArg(args.account_id);
      const campaign = strArg(args.campaign);
      const reason = strArg(args.reason);
      if (!id || !campaign) {
        return JSON.stringify({
          error: "account_id y campaign son obligatorios (usa get_portfolio / get_account).",
        });
      }
      const current = await resolveCampaignCurrent(id, campaign);
      return dryRunResult(
        "propose_pause_campaign",
        { account_id: id, campaign, ...(reason ? { reason } : {}) },
        current,
        {
          resource: "campaigns",
          operation: "CampaignService.MutateCampaigns (update)",
          fields: { campaign, "campaign.status": "PAUSED" },
        }
      );
    }

    case "propose_negative_keyword": {
      const id = strArg(args.account_id);
      const keyword = strArg(args.keyword);
      const matchType = strArg(args.match_type).toUpperCase();
      const scope = strArg(args.scope).toLowerCase() === "campaign" ? "campaign" : "account";
      if (!id || !keyword) {
        return JSON.stringify({ error: "account_id y keyword son obligatorios." });
      }
      if (!["EXACT", "PHRASE", "BROAD"].includes(matchType)) {
        return JSON.stringify({
          error: "match_type debe ser EXACT, PHRASE o BROAD.",
        });
      }
      return dryRunResult(
        "propose_negative_keyword",
        { account_id: id, keyword, match_type: matchType, scope },
        { nota: "keyword negativa nueva; no requiere validación contra el estado actual" },
        scope === "campaign"
          ? {
              resource: "campaignCriteria",
              operation: "CampaignCriterionService.MutateCampaignCriteria (create)",
              fields: {
                "campaign_criterion.negative": true,
                "campaign_criterion.keyword.text": keyword,
                "campaign_criterion.keyword.match_type": matchType,
              },
            }
          : {
              resource: "customerNegativeCriteria",
              operation:
                "CustomerNegativeCriterionService.MutateCustomerNegativeCriteria (create)",
              fields: {
                "customer_negative_criterion.keyword.text": keyword,
                "customer_negative_criterion.keyword.match_type": matchType,
              },
            }
      );
    }

    case "propose_bid_modifier": {
      const id = strArg(args.account_id);
      const dimension = strArg(args.dimension).toLowerCase();
      const segment = strArg(args.segment);
      const pct = Number(args.modifier_pct);
      if (!id || !segment) {
        return JSON.stringify({ error: "account_id y segment son obligatorios." });
      }
      if (!["device", "geo", "schedule"].includes(dimension)) {
        return JSON.stringify({ error: "dimension debe ser device, geo o schedule." });
      }
      if (!Number.isFinite(pct) || pct < -90 || pct > 900) {
        return JSON.stringify({
          error: "modifier_pct debe ser un número entre -90 y 900 (límites de Google Ads).",
        });
      }
      const criterionType =
        dimension === "device" ? "device" : dimension === "geo" ? "location" : "ad_schedule";
      const factor = Math.round((1 + pct / 100) * 100) / 100;
      return dryRunResult(
        "propose_bid_modifier",
        { account_id: id, dimension, segment, modifier_pct: pct },
        {
          nota: "no validado contra el estado actual (el motor no expone los modificadores vigentes)",
        },
        {
          resource: "campaignCriteria",
          operation: "CampaignCriterionService.MutateCampaignCriteria (update bid_modifier)",
          fields: {
            "campaign_criterion.type": criterionType,
            segment,
            "campaign_criterion.bid_modifier": factor,
          },
        }
      );
    }

    case "record_proposal": {
      // THE ONLY side effect in this file: a propose-only Approval in the
      // engine (postApprove). Nothing executes against Google Ads — a human
      // applies the approved CSV via Google Ads Editor.
      const id = strArg(args.account_id);
      const title = strArg(args.title);
      if (!id || !title) {
        return JSON.stringify({ error: "account_id y title son obligatorios." });
      }
      let detail: Record<string, unknown> = {};
      const rawDetail = args.detail_json;
      if (typeof rawDetail === "string" && rawDetail.trim()) {
        try {
          const parsed = JSON.parse(rawDetail) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            detail = parsed as Record<string, unknown>;
          }
        } catch {
          detail = {};
        }
      } else if (rawDetail && typeof rawDetail === "object" && !Array.isArray(rawDetail)) {
        // Some models pass the object directly instead of a JSON string.
        detail = rawDetail as Record<string, unknown>;
      }
      const recKey = `chat-${createHash("sha256").update(title).digest("hex").slice(0, 14)}`;
      await postApprove(id, {
        rec_key: recKey,
        title: title.slice(0, 180),
        detail,
        approved_by: "copiloto",
      });
      return JSON.stringify({
        recorded: true,
        rec_key: recKey,
        note: "Propuesta registrada — aparece en Acciones y en el export CSV para aplicar en Google Ads Editor.",
      });
    }

    default:
      return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
  }
}
