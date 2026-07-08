// ============================================================================
// POST /api/copiloto — the Copiloto chat endpoint.
//
// Body: { messages: [{ role: "user" | "assistant", content: string }],
//         mode?: "lectura" | "dryrun" }        (invalid/missing → "lectura")
// Reply: { reply: string, toolsUsed: string[], mode: CopilotoMode }
//        | { error: string }
//
// Auth-gated with the Supabase session (401 for anonymous callers). Runs an
// OpenAI-compatible tool-calling loop against OpenRouter via the shared
// runToolLoop (src/lib/llm/tool-loop.ts): the model decides which engine
// views to consult (src/lib/copiloto-tools.ts), we execute the tool calls
// SERVER-SIDE via the sentinel fetchers (SENTINEL_API_KEY never reaches the
// browser), append the results, and iterate — max 6 rounds under a ~30s
// overall budget (AbortController per call). This route owns auth, the
// never-Anthropic model policy, history/payload trimming, the system
// prompt, and the tool belt; runToolLoop owns only the wire mechanics.
//
// Modes (there is NO "write" mode — this platform never executes against
// Google Ads): "lectura" offers only read tools and executeTool blocks any
// write-intent call; "dryrun" adds the propose_* SIMULATION tools plus
// record_proposal, whose only effect is a propose-only engine Approval that
// a human applies via Google Ads Editor.
//
// The existing OpenRouter helper (src/lib/llm/openrouter.ts) only supports a
// single FORCED structured call, not a multi-turn tool loop, so this route
// (via runToolLoop) talks to https://openrouter.ai/api/v1/chat/completions
// directly with fetch. The API key is resolved with the same env-first
// helper the rest of the LLM layer uses (getOpenRouterKey →
// OPENROUTER_API_KEY, DB fallback).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { getOpenRouterKey } from "@/lib/llm/settings";
import { executeTool, toolsForMode, type CopilotoMode } from "@/lib/copiloto-tools";
import { runToolLoop, isAbort } from "@/lib/llm/tool-loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ROUNDS = 6;
const OVERALL_BUDGET_MS = 30_000;
const PER_CALL_TIMEOUT_MS = 25_000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOKENS = 2048;
const TEMPERATURE = 0.3;
const FALLBACK_MODEL = "z-ai/glm-5.2";

const SYSTEM_PROMPT =
  "Eres el Copiloto de AI Rankia Ads: un estratega senior de Google Ads con " +
  "acceso a los datos MEDIDOS del workspace del usuario vía herramientas. " +
  "Responde en español, conciso y accionable, SIEMPRE fundamentado en los " +
  "datos de las herramientas (di qué consultaste). Todo es propose-only: " +
  "nunca afirmes que ejecutaste cambios. Si no hay datos (cuentas sin " +
  "conectar), guía al usuario a Conexiones.\n\n" +
  "Cita números concretos de los datos (gasto, USD en juego, notas de " +
  "auditoría, efecto %); si un dato no aparece en las herramientas, dilo — " +
  "nunca lo inventes. Formatea con **negritas** para lo importante y listas " +
  'con "- " cuando enumeres; sin tablas.';

/** Appended to the system prompt per mode. */
const MODE_NOTES: Record<CopilotoMode, string> = {
  lectura:
    "MODO SOLO LECTURA: si piden cambios, explica que activen el modo Dry-run " +
    "(interruptor junto al campo de texto) para simular.",
  dryrun:
    "MODO DRY-RUN: las herramientas de cambio SIMULAN — nunca tocan Google Ads. " +
    "Muestra el preview claramente marcado como SIMULACIÓN. Solo llama " +
    "record_proposal cuando el usuario CONFIRME explícitamente (sí/hazlo/regístrala); " +
    "registrar crea una propuesta aprobada (propose-only) que el humano aplica vía " +
    "Google Ads Editor.",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Model comes from env; NEVER an Anthropic/Claude model on this endpoint. */
function resolveModel(): string {
  const fromEnv = process.env.LLM_DEFAULT_MODEL?.trim();
  const model = fromEnv || FALLBACK_MODEL;
  if (/anthropic|claude/i.test(model)) return FALLBACK_MODEL;
  return model;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Auth gate — never leak engine data to anonymous callers.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ---- Parse + sanitize the chat history ----------------------------------
  let raw: { messages?: unknown; mode?: unknown };
  try {
    raw = (await request.json()) as { messages?: unknown; mode?: unknown };
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  // Anything that isn't exactly "dryrun" falls back to the safe default.
  const mode: CopilotoMode = raw.mode === "dryrun" ? "dryrun" : "lectura";

  const history: Array<{ role: "user" | "assistant"; content: string }> = (
    Array.isArray(raw.messages) ? raw.messages : []
  )
    .filter(
      (m): m is { role: string; content: string } =>
        m != null &&
        typeof m === "object" &&
        ((m as { role?: unknown }).role === "user" ||
          (m as { role?: unknown }).role === "assistant") &&
        typeof (m as { content?: unknown }).content === "string" &&
        ((m as { content: string }).content.trim().length > 0)
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content.slice(0, MAX_MESSAGE_CHARS),
    }));

  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return NextResponse.json(
      { error: "Falta el mensaje del usuario." },
      { status: 400 }
    );
  }

  const apiKey = await getOpenRouterKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "El Copiloto no está configurado (falta OPENROUTER_API_KEY en el servidor)." },
      { status: 500 }
    );
  }

  const model = resolveModel();
  const tools = toolsForMode(mode);

  let result: { reply: string; toolsUsed: string[] };
  try {
    result = await runToolLoop({
      apiKey,
      model,
      system: `${SYSTEM_PROMPT}\n\n${MODE_NOTES[mode]}`,
      history,
      tools,
      execute: (name, args) => executeTool(name, args, mode),
      maxRounds: MAX_ROUNDS,
      budgetMs: OVERALL_BUDGET_MS,
      perCallMs: PER_CALL_TIMEOUT_MS,
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });
  } catch (e) {
    const message = isAbort(e)
      ? "La consulta tardó demasiado (límite de 30s). Prueba una pregunta más acotada."
      : e instanceof Error
        ? `El Copiloto no pudo completar la consulta. ${e.message}`
        : "El Copiloto no pudo completar la consulta.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (!result.reply) {
    return NextResponse.json(
      {
        error:
          "El Copiloto no consiguió formular una respuesta a tiempo. Inténtalo de nuevo con una pregunta más concreta.",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ reply: result.reply, toolsUsed: result.toolsUsed, mode });
}
