// ============================================================================
// Anthropic Messages API client — zero-dependency (plain fetch, no SDK).
// Used by the search-engine agents (A1..A5). The Activator (A6) is code-only.
//
// Reads ANTHROPIC_API_KEY from the server env. If it is missing we throw a
// clear, user-facing message (surfaced in the run UI) instead of a cryptic 401.
// ============================================================================

import { MICROS_PER_UNIT } from "@/lib/engine/types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Centralised model ids — overridable via env without touching agent code. */
export const MODELS = {
  /** Opus 4.8 — strategy / structure / QA (the "thinking" agents). */
  opus: process.env.ANTHROPIC_MODEL_OPUS ?? "claude-opus-4-8",
  /** Sonnet 4.6 — keyword research / copywriting (high-volume agents). */
  sonnet: process.env.ANTHROPIC_MODEL_SONNET ?? "claude-sonnet-4-6",
} as const;

/** Rough USD-per-million-token prices, for cost accounting only (overridable). */
const PRICES_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
};

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface LLMCallParams {
  model: string;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
  tools?: AnthropicTool[];
  toolChoice?: { type: "tool"; name: string } | { type: "auto" } | { type: "any" };
  signal?: AbortSignal;
}

export interface LLMResult {
  text: string;
  toolCalls: { name: string; input: unknown }[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string | null;
  costMicros: number;
}

export class AnthropicError extends Error {}

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new AnthropicError(
      "ANTHROPIC_API_KEY is missing on the server. Add the key so the agents can think."
    );
  }
  return key;
}

export function estimateCostMicros(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = PRICES_PER_MTOK[model] ?? { in: 0, out: 0 };
  const usd = (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
  return Math.round(usd * MICROS_PER_UNIT);
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/** Low-level call. Retries transient errors (429 / 5xx) with backoff. */
export async function callAnthropic(params: LLMCallParams): Promise<LLMResult> {
  const key = apiKey();
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    messages: params.messages,
  };
  if (params.system) body.system = params.system;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.tools) body.tools = params.tools;
  if (params.toolChoice) body.tool_choice = params.toolChoice;

  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });

      if (!res.ok) {
        const retriable = res.status === 429 || res.status >= 500;
        const errText = await res.text().catch(() => res.statusText);
        if (retriable && attempt < maxAttempts - 1) {
          lastErr = new AnthropicError(`Anthropic ${res.status}: ${errText}`);
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new AnthropicError(`Anthropic ${res.status}: ${errText}`);
      }

      const json = (await res.json()) as {
        content: AnthropicContentBlock[];
        stop_reason: string | null;
        usage: { input_tokens: number; output_tokens: number };
      };

      const blocks = json.content ?? [];
      const text = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text as string)
        .join("");
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ name: b.name as string, input: b.input }));

      const inputTokens = json.usage?.input_tokens ?? 0;
      const outputTokens = json.usage?.output_tokens ?? 0;

      return {
        text,
        toolCalls,
        usage: { inputTokens, outputTokens },
        stopReason: json.stop_reason ?? null,
        costMicros: estimateCostMicros(params.model, inputTokens, outputTokens),
      };
    } catch (e) {
      // Abort = caller cancelled the run; do not retry.
      if (e instanceof Error && e.name === "AbortError") throw e;
      lastErr = e;
      if (attempt < maxAttempts - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new AnthropicError("Anthropic call failed");
}

export interface StructuredCallParams {
  model: string;
  system?: string;
  prompt: string;
  /** JSON schema describing the object we want back. */
  schema: Record<string, unknown>;
  /** Tool name (semantic, e.g. "submit_plan"). */
  toolName: string;
  toolDescription?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  data: T;
  usage: { inputTokens: number; outputTokens: number };
  costMicros: number;
}

/**
 * Force the model to return a single, schema-valid object by exposing exactly
 * one tool and requiring it. This is how every llm agent gets structured output.
 */
export async function callStructured<T>(
  params: StructuredCallParams
): Promise<StructuredResult<T>> {
  const result = await callAnthropic({
    model: params.model,
    system: params.system,
    messages: [{ role: "user", content: params.prompt }],
    maxTokens: params.maxTokens ?? 8192,
    temperature: params.temperature,
    tools: [
      {
        name: params.toolName,
        description:
          params.toolDescription ?? "Return the result as a structured object.",
        input_schema: params.schema,
      },
    ],
    toolChoice: { type: "tool", name: params.toolName },
    signal: params.signal,
  });

  const call = result.toolCalls.find((c) => c.name === params.toolName);
  if (!call) {
    throw new AnthropicError(
      `The model didn't return the ${params.toolName} tool. stop_reason=${result.stopReason}`
    );
  }

  return {
    data: call.input as T,
    usage: result.usage,
    costMicros: result.costMicros,
  };
}

function backoffMs(attempt: number): number {
  // 0.5s, 1s, 2s — deterministic (no jitter; keeps runs reproducible).
  return 500 * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
