// ============================================================================
// POST /api/command/copiloto — the propose-only Copiloto for the Google
// create builder AND the Google edit workbench (Command Center v2.4, spec §c).
//
// Body: { messages: [{role:"user"|"assistant", content: string}], docKind:
//         "google_create" | "google_edit", blueprintId: string, doc: unknown }
// Reply: { reply: string, proposals: Proposal[], toolsUsed: string[] }
//        | { error: string }
//
// THE COVENANT (enforced by construction, not just prompted): this route's
// ONLY effect channel is `propose_patch`, whose only output is an in-memory
// proposal accumulator returned to the caller — no DB write, no cc_actions
// row, no import of executor.ts/gates.ts/actions-repo.ts. The AI never
// executes; a human Accept (client-side, existing code paths) re-runs the
// SAME applyBlueprintPatch against the live doc before anything is saved.
//
// Grounding: for an edit doc, `mergeEditDoc(stored, body.doc)` runs BEFORE
// the model ever sees the doc, so a client can never spoof server-owned
// baselines (base*/resourceName/loadedAt) into what the model is shown or
// what propose_patch dry-runs against. For a create doc, `parseBlueprint`
// rejects garbage before it reaches the model.
//
// Auth: getCommandAccess() (session + COMMAND_CENTER_BETA + admin allowlist +
// workspace scoping) — same gate as every other /api/command/* route, NOT
// the raw-session gate /api/copiloto uses. Model policy, history trimming,
// and the tool belt are OWNED here (never-Anthropic guard mirrors
// /api/copiloto's local resolveModel — src/app/api/copiloto/route.ts); only
// the OpenRouter wire mechanics come from the shared runToolLoop
// (src/lib/llm/tool-loop.ts).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getBlueprint, type CcBlueprintRow } from "@/lib/command/blueprint/repo";
import { parseBlueprint, type CcBlueprintDoc } from "@/lib/command/blueprint/schema";
import { mergeEditDoc, parseEditDoc, type GoogleSearchEditDoc } from "@/lib/command/edit/schema";
import { MICROS_PER_UNIT } from "@/lib/command/types";
import { RSA_SPEC, GOOGLE_THRESHOLDS } from "@/lib/command/knowledge";
import { MAX_PATCH_OPS, WRITABLE_FIELDS, type DocKind, type NodeKind } from "@/lib/command/patch/schema";
import type { PatchTarget } from "@/lib/command/patch/apply";
import {
  trimDocForTool,
  executeProposePatch,
  MAX_PROPOSALS,
  type Proposal,
} from "@/lib/command/patch/tool-executors";
import { getOpenRouterKey } from "@/lib/llm/settings";
import { runToolLoop, isAbort, type ChatTool } from "@/lib/llm/tool-loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Bounds (spec §adjudication 4 / Global Constraints)
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 6;
const OVERALL_BUDGET_MS = 30_000;
const PER_CALL_TIMEOUT_MS = 25_000;
const MAX_TOKENS = 2048;
const TEMPERATURE = 0.3;
const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_BODY_BYTES = 256 * 1024;
const FALLBACK_MODEL = "z-ai/glm-5.2";

/** Model comes from env; NEVER an Anthropic/Claude model on this endpoint. Mirrors
 * /api/copiloto's local resolveModel() verbatim — model policy is deliberately NOT owned by
 * runToolLoop (each route keeps its own never-Anthropic guard, per spec §c). */
function resolveModel(): string {
  const fromEnv = process.env.LLM_DEFAULT_MODEL?.trim();
  const model = fromEnv || FALLBACK_MODEL;
  if (/anthropic|claude/i.test(model)) return FALLBACK_MODEL;
  return model;
}

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------

const GET_DOC_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "get_doc",
    description:
      "Devuelve el árbol COMPLETO del borrador actual (incluidos cambios sin guardar), recortado " +
      "(arreglos a 30 elementos, con notas de recorte). Úsalo cuando el resumen del sistema no baste " +
      "— p. ej. para ver todas las keywords, anuncios o negativas.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

const PROPOSE_PATCH_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "propose_patch",
    description:
      "Propón un cambio al borrador. NUNCA se aplica automáticamente: genera una tarjeta que el " +
      "operador humano debe Aceptar o Rechazar. Cada operación debe apuntar a un campo editable real " +
      "(ver la lista de campos en el prompt del sistema) y traer un motivo breve.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Resumen breve y accionable de la propuesta completa (máx. 160 caracteres).",
        },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PATCH_OPS,
          description: `Hasta ${MAX_PATCH_OPS} operaciones que forman esta propuesta.`,
          items: {
            type: "object",
            required: ["nodeId", "field", "value", "rationale"],
            additionalProperties: false,
            properties: {
              nodeId: { type: "string", description: "Id del nodo objetivo, tal cual aparece en get_doc." },
              field: { type: "string", description: "Campo editable del nodo (de la lista whitelisted)." },
              value: { description: "Nuevo valor del campo (tipo según el campo: texto, número, booleano, objeto o arreglo)." },
              rationale: { type: "string", description: "Motivo breve de este cambio (máx. 300 caracteres)." },
            },
          },
        },
      },
      required: ["summary", "ops"],
      additionalProperties: false,
    },
  },
};

// ---------------------------------------------------------------------------
// System prompt (es-MX, static per request)
// ---------------------------------------------------------------------------

const COVENANT =
  "Eres el Copiloto del Centro de Mando de AI Rankia Ads. Ayudas a preparar cambios sobre un " +
  "borrador de campaña de Google Ads. SOLO PROPONES: todo cambio que sugieras debe pasar por la " +
  "herramienta propose_patch, que genera una tarjeta que el operador humano revisa y Acepta o " +
  "Rechaza. Jamás afirmes que aplicaste, guardaste o ejecutaste un cambio — no tienes esa " +
  "capacidad; tu único efecto posible es una propuesta pendiente de revisión humana. Responde en " +
  "español (es-MX), conciso y accionable.";

function renderWritableFields(docKind: DocKind): string {
  const registry = WRITABLE_FIELDS[docKind];
  return (Object.entries(registry) as Array<[NodeKind, readonly string[]]>)
    .filter(([, fields]) => fields.length > 0)
    .map(([nodeKind, fields]) => `- ${nodeKind}: ${fields.join(", ")}`)
    .join("\n");
}

function knowledgeBlock(): string {
  return [
    `RSA: titulares ${RSA_SPEC.headline.min}-${RSA_SPEC.headline.max} (máx. ${RSA_SPEC.headline.maxLen} car. c/u), ` +
      `descripciones ${RSA_SPEC.description.min}-${RSA_SPEC.description.max} (máx. ${RSA_SPEC.description.maxLen} car. c/u), ` +
      `path máx. ${RSA_SPEC.path.maxLen} car.`,
    `Umbrales de Google Ads: bidding inteligente (Target CPA/ROAS) requiere ≥${GOOGLE_THRESHOLDS.smartBiddingMinConv30d} ` +
      `conversiones/30d; concordancia amplia solo con smart bidding + ≥${GOOGLE_THRESHOLDS.broadMatchMinConv30d} ` +
      `conversiones/30d + negativas; ajusta tCPA en pasos de ${GOOGLE_THRESHOLDS.tcpaStepPct}%; términos con ` +
      `≥${GOOGLE_THRESHOLDS.wastedSpendClickFloor} clics y 0 conversiones son candidatos a negativa; Quality Score ` +
      `saludable ≥${GOOGLE_THRESHOLDS.qualityScoreFloor}.`,
  ].join("\n");
}

function editBaselineSummary(doc: GoogleSearchEditDoc): string {
  const c = doc.campaign;
  const desiredUnits = (c.desired.dailyBudgetMicros / MICROS_PER_UNIT).toFixed(2);
  const baseUnits = (c.base.dailyBudgetMicros / MICROS_PER_UNIT).toFixed(2);
  const currency = c.base.currency ?? "?";
  return (
    `Campaña: "${c.base.name}" — estado base ${c.base.status}, estado deseado ${c.desired.status}. ` +
    `Presupuesto diario deseado ${desiredUnits} ${currency} (base ${baseUnits} ${currency}). ` +
    `${c.adGroups.length} grupo(s) de anuncios cargado(s).`
  );
}

function buildSystemPrompt(docKind: DocKind, blueprint: CcBlueprintRow, groundedDoc: PatchTarget["doc"]): string {
  const accountLabel = blueprint.network === "google_ads" ? "Google Ads" : blueprint.network;
  const parts = [
    COVENANT,
    `Documento: ${docKind}. Cuenta: ${blueprint.accountRef} (${accountLabel}).`,
    `Campos editables por tipo de nodo — cualquier otro campo se rechaza:\n${renderWritableFields(docKind)}`,
    docKind === "google_create"
      ? "nodeId: usa el nodeId de cada nodo tal cual aparece en get_doc (campaign.nodeId, campaign.budget.nodeId, cada adGroup.nodeId, cada ad.nodeId)."
      : 'nodeId: usa el literal "campaign" para la campaña, o el resourceName exacto (grupo de anuncios / keyword / anuncio) tal cual aparece en get_doc.',
    knowledgeBlock(),
    docKind === "google_edit" ? editBaselineSummary(groundedDoc as GoogleSearchEditDoc) : null,
    "El árbol completo (todas las keywords, anuncios y negativas) solo está disponible vía get_doc — el resumen de arriba es parcial.",
    `Límites de esta conversación: máx. ${MAX_PATCH_OPS} operaciones por propose_patch, máx. ${MAX_PROPOSALS} propuestas por turno, resumen ≤160 caracteres, motivo ≤300 caracteres por operación.`,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

interface CopilotoCommandBody {
  messages?: unknown;
  docKind?: unknown;
  blueprintId?: unknown;
  doc?: unknown;
}

function isDocKind(v: unknown): v is DocKind {
  return v === "google_create" || v === "google_edit";
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();

  // ---- Body size guard (spec bound: ≤256KB) --------------------------------
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Cuerpo de la solicitud demasiado grande (máx. 256KB)." }, { status: 413 });
  }
  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }
  if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Cuerpo de la solicitud demasiado grande (máx. 256KB)." }, { status: 413 });
  }

  let raw: CopilotoCommandBody;
  try {
    raw = JSON.parse(rawText) as CopilotoCommandBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  if (!isDocKind(raw.docKind)) {
    return NextResponse.json({ error: "docKind inválido: debe ser google_create o google_edit." }, { status: 400 });
  }
  const docKind: DocKind = raw.docKind;

  const blueprintId = typeof raw.blueprintId === "string" ? raw.blueprintId.trim() : "";
  if (!blueprintId) {
    return NextResponse.json({ error: "blueprintId es obligatorio." }, { status: 400 });
  }

  // ---- History: trim to 12 messages / 8k chars each (mirrors /api/copiloto) ----
  const history: Array<{ role: "user" | "assistant"; content: string }> = (
    Array.isArray(raw.messages) ? raw.messages : []
  )
    .filter(
      (m): m is { role: string; content: string } =>
        m != null &&
        typeof m === "object" &&
        ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") &&
        typeof (m as { content?: unknown }).content === "string" &&
        (m as { content: string }).content.trim().length > 0
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return NextResponse.json({ error: "Falta el mensaje del usuario." }, { status: 400 });
  }

  // ---- Load blueprint, workspace-scoped ------------------------------------
  let blueprint: CcBlueprintRow | null;
  try {
    blueprint = await getBlueprint(blueprintId, access.workspaceIds);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
  if (!blueprint) return NextResponse.json({ error: "no encontrado" }, { status: 404 });

  const storedIsEdit = (blueprint.doc as { docType?: unknown } | null)?.docType === "google_search_edit_v1";
  if (docKind === "google_edit" && !storedIsEdit) {
    return NextResponse.json(
      { error: "docKind no coincide con el blueprint (se esperaba google_edit)." },
      { status: 400 }
    );
  }
  if (docKind === "google_create" && (storedIsEdit || blueprint.network !== "google_ads")) {
    return NextResponse.json(
      { error: "docKind no coincide con el blueprint (se esperaba google_create)." },
      { status: 400 }
    );
  }

  // ---- Ground truth: the model can NEVER see a spoofed baseline -----------
  let target: PatchTarget;
  if (docKind === "google_edit") {
    let merged: GoogleSearchEditDoc;
    try {
      merged = mergeEditDoc(parseEditDoc(blueprint.doc), raw.doc);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "doc de edición inválido" }, { status: 400 });
    }
    target = { docKind: "google_edit", doc: merged };
  } else {
    let created: CcBlueprintDoc;
    try {
      created = parseBlueprint(raw.doc);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "doc de blueprint inválido" }, { status: 400 });
    }
    target = { docKind: "google_create", doc: created };
  }

  const apiKey = await getOpenRouterKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "El Copiloto no está configurado (falta OPENROUTER_API_KEY en el servidor)." },
      { status: 500 }
    );
  }

  // ---- Tools: get_doc (no args) + propose_patch (server dry run) ----------
  const proposals: Proposal[] = [];

  const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case "get_doc":
        return JSON.stringify(trimDocForTool(target.doc));

      case "propose_patch": {
        const outcome = executeProposePatch(target, docKind, args, proposals.length);
        if (outcome.status === "limit") {
          return JSON.stringify({ ok: false, error: "límite de propuestas alcanzado" });
        }
        if (outcome.status === "invalid") {
          return JSON.stringify({ ok: false, errors: outcome.errors });
        }
        proposals.push({ id: randomUUID(), ...outcome.proposal });
        return JSON.stringify({ ok: true });
      }

      default:
        return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
    }
  };

  let result: { reply: string; toolsUsed: string[] };
  try {
    result = await runToolLoop({
      apiKey,
      model: resolveModel(),
      system: buildSystemPrompt(docKind, blueprint, target.doc),
      history,
      tools: [GET_DOC_TOOL, PROPOSE_PATCH_TOOL],
      execute,
      maxRounds: MAX_ROUNDS,
      budgetMs: OVERALL_BUDGET_MS,
      perCallMs: PER_CALL_TIMEOUT_MS,
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });
  } catch (e) {
    const message = isAbort(e)
      ? "La consulta tardó demasiado (límite de 30s). Prueba una petición más acotada."
      : e instanceof Error
        ? `El Copiloto no pudo completar la consulta. ${e.message}`
        : "El Copiloto no pudo completar la consulta.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // A propose-only turn is useful even without closing text, as long as it produced at least
  // one proposal (unlike /api/copiloto, dropping proposals on an empty final reply would be a
  // worse failure mode than returning them without prose).
  if (!result.reply && proposals.length === 0) {
    return NextResponse.json(
      {
        error:
          "El Copiloto no consiguió formular una respuesta a tiempo. Inténtalo de nuevo con una petición más concreta.",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ reply: result.reply, proposals, toolsUsed: result.toolsUsed });
}
