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
 *   - executeTool(name, args): dispatcher mapping each tool to its sentinel
 *     fetcher. Always returns a JSON string TRIMMED to a size an LLM can
 *     digest: long arrays sliced to 30 items, huge raw snapshots (diagnostic /
 *     audit_ai > ~15KB) dropped, and every cut noted inside the payload.
 */

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
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
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

    default:
      return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
  }
}
