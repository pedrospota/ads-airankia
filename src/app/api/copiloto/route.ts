// ============================================================================
// POST /api/copiloto — the Copiloto chat endpoint.
//
// Body: { messages: [{ role: "user" | "assistant", content: string }] }
// Reply: { reply: string, toolsUsed: string[] }  |  { error: string }
//
// Auth-gated with the Supabase session (401 for anonymous callers). Runs an
// OpenAI-compatible tool-calling loop against OpenRouter: the model decides
// which engine views to consult (src/lib/copiloto-tools.ts), we execute the
// tool calls SERVER-SIDE via the sentinel fetchers (SENTINEL_API_KEY never
// reaches the browser), append the results, and iterate — max 6 rounds under
// a ~30s overall budget (AbortController per call).
//
// The existing OpenRouter helper (src/lib/llm/openrouter.ts) only supports a
// single FORCED structured call, not a multi-turn tool loop, so this route
// talks to https://openrouter.ai/api/v1/chat/completions directly with fetch.
// The API key is resolved with the same env-first helper the rest of the LLM
// layer uses (getOpenRouterKey → OPENROUTER_API_KEY, DB fallback).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { getOpenRouterKey } from "@/lib/llm/settings";
import { copilotoTools, executeTool } from "@/lib/copiloto-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const REFERER = process.env.OPENROUTER_SITE_URL ?? "https://ads.airankia.com";
const TITLE = process.env.OPENROUTER_APP_NAME ?? "AI Rankia Ads";

const MAX_ROUNDS = 6;
const OVERALL_BUDGET_MS = 30_000;
const PER_CALL_TIMEOUT_MS = 25_000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8_000;
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

// ---------------------------------------------------------------------------
// Minimal OpenAI-compatible wire types
// ---------------------------------------------------------------------------

interface ORToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ConvoMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ORToolCall[];
  tool_call_id?: string;
}

interface ORChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ORToolCall[] };
  }>;
  error?: { message?: string };
}

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

async function callOpenRouter(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<ORChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": REFERER,
        "X-Title": TITLE,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 300)}`);
    }
    const json = (await res.json()) as ORChatResponse;
    // OpenRouter can return HTTP 200 with an embedded error object.
    if (json.error?.message) throw new Error(`OpenRouter: ${json.error.message}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function isAbort(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")
  );
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
  let raw: { messages?: unknown };
  try {
    raw = (await request.json()) as { messages?: unknown };
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const history: ConvoMessage[] = (Array.isArray(raw.messages) ? raw.messages : [])
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
  const convo: ConvoMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
  ];
  const toolsUsed: string[] = [];
  const deadline = Date.now() + OVERALL_BUDGET_MS;
  let reply: string | null = null;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const remaining = deadline - Date.now();
      if (remaining < 2_000) break; // out of budget → surface timeout below

      // Last round (or nearly out of budget): no tools → force a text answer.
      const allowTools = round < MAX_ROUNDS - 1 && remaining > 6_000;
      const body: Record<string, unknown> = {
        model,
        messages: convo,
        max_tokens: 2048,
        temperature: 0.3,
      };
      if (allowTools) {
        body.tools = copilotoTools;
        body.tool_choice = "auto";
      }

      const json = await callOpenRouter(
        apiKey,
        body,
        Math.min(remaining, PER_CALL_TIMEOUT_MS)
      );
      const msg = json.choices?.[0]?.message;
      const toolCalls = (Array.isArray(msg?.tool_calls) ? msg.tool_calls : []).filter(
        (tc) => tc?.function?.name
      );

      // No tool calls → this is the final answer.
      if (toolCalls.length === 0) {
        reply = typeof msg?.content === "string" ? msg.content.trim() : "";
        break;
      }

      // Execute every tool call server-side and append the results.
      convo.push({
        role: "assistant",
        content: typeof msg?.content === "string" ? msg.content : null,
        tool_calls: toolCalls,
      });
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const name = tc.function?.name ?? "";
        let args: Record<string, unknown> = {};
        if (tc.function?.arguments) {
          try {
            const parsed = JSON.parse(tc.function.arguments) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            args = {};
          }
        }
        if (!toolsUsed.includes(name)) toolsUsed.push(name);

        let result: string;
        try {
          result = await executeTool(name, args);
        } catch (e) {
          // Engine unreachable / view failed → tell the model, keep going.
          result = JSON.stringify({
            error:
              e instanceof Error ? e.message : "La herramienta falló; inténtalo con otra vista.",
          });
        }
        convo.push({
          role: "tool",
          tool_call_id: tc.id ?? `call_${round}_${i}`,
          content: result,
        });
      }
    }
  } catch (e) {
    const message = isAbort(e)
      ? "La consulta tardó demasiado (límite de 30s). Prueba una pregunta más acotada."
      : e instanceof Error
        ? `El Copiloto no pudo completar la consulta. ${e.message}`
        : "El Copiloto no pudo completar la consulta.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (!reply) {
    return NextResponse.json(
      {
        error:
          "El Copiloto no consiguió formular una respuesta a tiempo. Inténtalo de nuevo con una pregunta más concreta.",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ reply, toolsUsed });
}
