// ============================================================================
// runToolLoop — reusable OpenAI-compatible tool-calling loop against
// OpenRouter's chat/completions endpoint.
//
// Extracted from src/app/api/copiloto/route.ts (behavior-preserving — see
// docs/superpowers/specs/2026-07-08-command-center-v2.4-copiloto-design.md
// §c "Tool-loop extraction"). Owns ONLY the wire mechanics:
//   - the OpenRouter HTTP call (callOpenRouter) incl. embedded-200-error
//     handling (OpenRouter can return HTTP 200 with an `error` body),
//   - the multi-round tool-calling loop: round cap, total-budget
//     AbortController + per-call timeout, starving tools on the last round
//     (or once headroom drops below 6s) to force a final text answer,
//   - tool-call argument JSON parse hardening.
//
// Deliberately does NOT own: auth, model policy (the never-Anthropic guard
// — each route keeps its own resolveModel()), payload/history trimming, the
// system prompt content, the tool belt, or response shaping/error copy.
// Callers wrap runToolLoop() in their own try/catch and use isAbort() to
// distinguish a budget timeout from other failures when building
// user-facing error text.
// ============================================================================

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const REFERER = process.env.OPENROUTER_SITE_URL ?? "https://ads.airankia.com";
const TITLE = process.env.OPENROUTER_APP_NAME ?? "AI Rankia Ads";

const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_BUDGET_MS = 30_000;
const DEFAULT_PER_CALL_MS = 25_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.3;

// ---------------------------------------------------------------------------
// Minimal OpenAI-compatible wire types
// ---------------------------------------------------------------------------

/** OpenAI Chat Completions `tools` function-declaration shape. */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

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
// Public params / result
// ---------------------------------------------------------------------------

export interface ToolLoopParams {
  apiKey: string;
  model: string;
  system: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  tools: ChatTool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxRounds?: number;
  budgetMs?: number;
  perCallMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolLoopResult {
  reply: string;
  toolsUsed: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * True if `e` is an AbortController abort/timeout error. Callers use this to
 * distinguish "ran out of budget mid-call" from other failures when shaping
 * their own user-facing error copy.
 */
export function isAbort(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")
  );
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Runs a multi-round OpenAI-compatible tool-calling loop against OpenRouter.
 *
 * - Caps at `maxRounds` rounds under a `budgetMs` overall budget (per-call
 *   timeout `perCallMs`, further clamped to the remaining budget).
 * - Starves tools on the last round (or once remaining budget dips below
 *   6s) to force the model into a final text answer instead of another
 *   tool call.
 * - Breaks out (without throwing) once remaining budget dips below 2s,
 *   returning whatever reply text was produced so far (`""` if none) — the
 *   caller decides how to surface "no answer in time" (a falsy `reply`).
 * - Tool execution errors are caught per-call and fed back to the model as
 *   a JSON error string, so one failing tool doesn't abort the whole loop;
 *   network/OpenRouter-level errors (including abort/timeout) propagate to
 *   the caller.
 */
export async function runToolLoop(p: ToolLoopParams): Promise<ToolLoopResult> {
  const maxRounds = p.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const budgetMs = p.budgetMs ?? DEFAULT_BUDGET_MS;
  const perCallMs = p.perCallMs ?? DEFAULT_PER_CALL_MS;
  const maxTokens = p.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = p.temperature ?? DEFAULT_TEMPERATURE;

  const convo: ConvoMessage[] = [{ role: "system", content: p.system }, ...p.history];
  const toolsUsed: string[] = [];
  const deadline = Date.now() + budgetMs;
  let reply: string | null = null;

  for (let round = 0; round < maxRounds; round++) {
    const remaining = deadline - Date.now();
    if (remaining < 2_000) break; // out of budget → caller surfaces timeout via falsy reply

    // Last round (or nearly out of budget): no tools → force a text answer.
    const allowTools = round < maxRounds - 1 && remaining > 6_000;
    const body: Record<string, unknown> = {
      model: p.model,
      messages: convo,
      max_tokens: maxTokens,
      temperature,
    };
    if (allowTools) {
      body.tools = p.tools;
      body.tool_choice = "auto";
    }

    const json = await callOpenRouter(p.apiKey, body, Math.min(remaining, perCallMs));
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
        result = await p.execute(name, args);
      } catch (e) {
        // Tool unreachable / failed → tell the model, keep the loop going.
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

  return { reply: reply ?? "", toolsUsed };
}
