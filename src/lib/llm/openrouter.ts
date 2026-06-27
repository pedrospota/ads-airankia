// ============================================================================
// OpenRouter client — zero-dependency (plain fetch, no SDK).
// OpenRouter speaks the OpenAI Chat Completions API, so this is OpenAI-compatible.
//
// Structured output is the hard part: not every model supports forced function
// calling. We degrade gracefully through THREE strategies until one returns a
// schema-valid object:
//   1) tools + tool_choice (force the function)        — best, most models
//   2) response_format json_schema (strict)            — many models
//   3) plain "answer with JSON only" + tolerant parse  — last resort
//
// This keeps GLM / Kimi / DeepSeek / Qwen / etc. working even when their
// tool-calling support is partial.
// ============================================================================

import { MICROS_PER_UNIT } from "@/lib/engine/types";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// Sent so OpenRouter attributes traffic to the app (recommended by their docs).
const REFERER = process.env.OPENROUTER_SITE_URL ?? "https://ads.airankia.com";
const TITLE = process.env.OPENROUTER_APP_NAME ?? "AI Rankia Ads";

export class OpenRouterError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ORStructuredParams {
  apiKey: string;
  model: string;
  system?: string;
  prompt: string;
  schema: Record<string, unknown>;
  toolName: string;
  toolDescription?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ORStructuredResult<T> {
  data: T;
  usage: { inputTokens: number; outputTokens: number };
  costMicros: number;
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number; // USD, present when we ask for usage.include
  };
  error?: { message?: string };
}

/** A model entry from GET /api/v1/models, mapped to what the admin UI needs. */
export interface ORModel {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null; // USD per token
  completionPrice: number | null; // USD per token
  created: number | null; // unix seconds (for "newest first")
  supportsTools: boolean;
  description: string | null;
}

// ----------------------------------------------------------------------------
// Low-level POST with retry on 429 / 5xx
// ----------------------------------------------------------------------------

// A single OpenRouter call should always return well under this for our prompt
// and output sizes. The per-attempt cap turns a stuck connection into a
// retriable error instead of a request that hangs until the reverse proxy gives
// up (which the user only ever sees as a generic 504). The overall budget is
// enforced one layer up, in callStructured (src/lib/llm/index.ts).
const PER_ATTEMPT_TIMEOUT_MS = 45_000;

async function postChat(
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ChatResponse> {
  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Abort this attempt if the caller's signal fires (overall deadline / the
    // user navigating away) OR our own per-attempt timeout trips.
    const attemptSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS)])
      : AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS);
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
        signal: attemptSignal,
      });

      if (!res.ok) {
        const retriable = res.status === 429 || res.status >= 500;
        const errText = await res.text().catch(() => res.statusText);
        if (retriable && attempt < maxAttempts - 1) {
          lastErr = new OpenRouterError(
            `OpenRouter ${res.status}: ${errText}`,
            res.status
          );
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new OpenRouterError(
          `OpenRouter ${res.status}: ${errText}`,
          res.status
        );
      }

      const json = (await res.json()) as ChatResponse;
      // OpenRouter can return HTTP 200 with an embedded error object.
      if (json.error?.message) {
        throw new OpenRouterError(`OpenRouter: ${json.error.message}`);
      }
      return json;
    } catch (e) {
      // The CALLER aborted (overall deadline reached, or the request was
      // cancelled) → stop the whole cascade, don't keep retrying.
      if (signal?.aborted) throw e;
      // Our per-attempt timeout (TimeoutError) or a transient network error is
      // retriable — fall through to the next attempt.
      const isTimeout =
        e instanceof Error &&
        (e.name === "TimeoutError" || e.name === "AbortError");
      lastErr = isTimeout
        ? new OpenRouterError(
            `OpenRouter didn't respond within ${PER_ATTEMPT_TIMEOUT_MS / 1000}s`
          )
        : e;
      if (attempt < maxAttempts - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new OpenRouterError("OpenRouter call failed");
}

// ----------------------------------------------------------------------------
// Parsing helpers
// ----------------------------------------------------------------------------

function makeResult<T>(json: ChatResponse, data: T): ORStructuredResult<T> {
  const u = json.usage ?? {};
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  const costMicros =
    typeof u.cost === "number" ? Math.round(u.cost * MICROS_PER_UNIT) : 0;
  return { data, usage: { inputTokens, outputTokens }, costMicros };
}

function extractToolArgs<T>(json: ChatResponse, toolName: string): T | undefined {
  const calls = json.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return undefined;
  const call = calls.find((c) => c?.function?.name === toolName) ?? calls[0];
  const args = call?.function?.arguments;
  if (typeof args === "string") return parseJsonLoose<T>(args);
  if (args && typeof args === "object") return args as T;
  return undefined;
}

function extractContentJson<T>(json: ChatResponse): T | undefined {
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return undefined;
  return parseJsonLoose<T>(content);
}

/** Tolerant JSON parse: handles ```json fences and leading/trailing prose. */
function parseJsonLoose<T>(text: string): T | undefined {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    // ignore — try to slice the outermost object
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1)) as T;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** Stop trying fallbacks on auth errors — they will all fail the same way. */
function isAuthError(e: unknown): boolean {
  return (
    e instanceof OpenRouterError &&
    (e.status === 401 || e.status === 403)
  );
}

// ----------------------------------------------------------------------------
// Public: structured call (the function the agents reach through the LLM layer)
// ----------------------------------------------------------------------------

export async function callOpenRouterStructured<T>(
  p: ORStructuredParams
): Promise<ORStructuredResult<T>> {
  const messages: Array<{ role: string; content: string }> = [];
  if (p.system) messages.push({ role: "system", content: p.system });
  messages.push({ role: "user", content: p.prompt });

  const base: Record<string, unknown> = {
    model: p.model,
    messages,
    max_tokens: p.maxTokens ?? 8192,
    usage: { include: true }, // ask OpenRouter to return real cost
  };
  if (p.temperature !== undefined) base.temperature = p.temperature;

  let lastErr: unknown;

  // --- Strategy 1: forced tool call ----------------------------------------
  try {
    const json = await postChat(
      p.apiKey,
      {
        ...base,
        tools: [
          {
            type: "function",
            function: {
              name: p.toolName,
              description:
                p.toolDescription ?? "Return the result as a structured object.",
              parameters: p.schema,
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: p.toolName },
        },
      },
      p.signal
    );
    const data = extractToolArgs<T>(json, p.toolName);
    if (data !== undefined) return makeResult(json, data);
  } catch (e) {
    if (isAbort(e)) throw e;
    if (isAuthError(e)) throw e;
    lastErr = e;
  }

  // --- Strategy 2: response_format json_schema (strict) --------------------
  try {
    const json = await postChat(
      p.apiKey,
      {
        ...base,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: p.toolName,
            strict: true,
            schema: p.schema,
          },
        },
      },
      p.signal
    );
    const data = extractContentJson<T>(json);
    if (data !== undefined) return makeResult(json, data);
  } catch (e) {
    if (isAbort(e)) throw e;
    if (isAuthError(e)) throw e;
    lastErr = e;
  }

  // --- Strategy 3: plain prompt, parse JSON from the content ----------------
  try {
    const messages3 = [...messages];
    const lastIdx = messages3.length - 1;
    messages3[lastIdx] = {
      role: "user",
      content:
        messages3[lastIdx].content +
        "\n\nRespond ONLY with a valid JSON object that matches the requested " +
        "schema. Do not include any extra text, explanations, or code fences.",
    };
    const json = await postChat(
      p.apiKey,
      { ...base, messages: messages3 },
      p.signal
    );
    const data = extractContentJson<T>(json);
    if (data !== undefined) return makeResult(json, data);
  } catch (e) {
    if (isAbort(e)) throw e;
    lastErr = e;
  }

  throw lastErr instanceof Error
    ? new OpenRouterError(
        `Model ${p.model} didn't return a valid object. ${lastErr.message}`
      )
    : new OpenRouterError(
        `Model ${p.model} didn't return a valid structured object.`
      );
}

// ----------------------------------------------------------------------------
// Public: live model catalogue (powers the admin dropdown)
// ----------------------------------------------------------------------------

export async function fetchOpenRouterModels(
  apiKey?: string,
  signal?: AbortSignal
): Promise<ORModel[]> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(OPENROUTER_MODELS_URL, { headers, signal });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new OpenRouterError(
      `OpenRouter models ${res.status}: ${errText}`,
      res.status
    );
  }
  const json = (await res.json()) as {
    data?: Array<{
      id: string;
      name?: string;
      created?: number;
      description?: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
      supported_parameters?: string[];
    }>;
  };
  const list = Array.isArray(json.data) ? json.data : [];
  return list.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    contextLength: typeof m.context_length === "number" ? m.context_length : null,
    promptPrice: m.pricing?.prompt != null ? Number(m.pricing.prompt) : null,
    completionPrice:
      m.pricing?.completion != null ? Number(m.pricing.completion) : null,
    created: typeof m.created === "number" ? m.created : null,
    supportsTools:
      Array.isArray(m.supported_parameters) &&
      m.supported_parameters.includes("tools"),
    description: typeof m.description === "string" ? m.description : null,
  }));
}

// ----------------------------------------------------------------------------
// Backoff
// ----------------------------------------------------------------------------

function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt; // 0.5s, 1s, 2s
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
