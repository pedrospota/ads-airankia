// ============================================================================
// Unified LLM layer — the single entrypoint every llm agent (A1..A5) calls.
//
// It resolves provider + model from admin settings at call time, then routes to
// either the Anthropic client (frozen, src/lib/anthropic.ts) or the OpenRouter
// client (src/lib/llm/openrouter.ts). The agent code stays provider-agnostic:
// it passes `agentId` instead of a hardcoded model.
//
// Resolution:
//   provider === 'openrouter' → model = perAgent[agentId] ?? defaultModel
//                               (errors clearly if neither is set / no key)
//   provider === 'anthropic'  → model = tier default (Opus for thinking agents,
//                               Sonnet for high-volume agents)
// ============================================================================

import {
  callStructured as callAnthropicStructured,
  MODELS,
  AnthropicError,
} from "@/lib/anthropic";
import { callOpenRouterStructured } from "./openrouter";
import { getLlmConfig, getOpenRouterKey, type LlmProvider } from "./settings";
import type { AgentId } from "@/lib/engine/types";

export { type LlmProvider, type LlmConfig } from "./settings";

/** Friendly, user-facing error (Spanish) surfaced in the run UI. */
export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

export interface UnifiedStructuredParams {
  agentId: AgentId;
  system?: string;
  prompt: string;
  schema: Record<string, unknown>;
  toolName: string;
  toolDescription?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface UnifiedStructuredResult<T> {
  data: T;
  usage: { inputTokens: number; outputTokens: number };
  costMicros: number;
  /** The model actually used (for accounting / the step record). */
  model: string;
  provider: LlmProvider;
}

// Tier per agent — decides the Anthropic default when provider is Anthropic.
const TIER: Record<AgentId, "opus" | "sonnet"> = {
  planner: "opus",
  keyword_researcher: "sonnet",
  structure_architect: "opus",
  rsa_copywriter: "sonnet",
  policy_qa: "opus",
  activator: "sonnet", // never used — A6 is code-only
};

/** The default Anthropic model id for an agent (used for the cosmetic def field). */
export function defaultAnthropicModel(agentId: AgentId): string {
  return TIER[agentId] === "opus" ? MODELS.opus : MODELS.sonnet;
}

// Bound the WHOLE structured call (all fallback strategies + their retries).
// The /advance and /suggest requests run behind a reverse proxy that gives up
// around ~100s; a slow or looping provider must fail fast and cleanly — with a
// real Spanish message — well before that, instead of letting the request hang
// into a generic 504 the user can do nothing about. Leaves headroom for the
// surrounding work in a step (e.g. the Google Ads keyword call in A2).
const LLM_DEADLINE_MS = 70_000;

export async function callStructured<T>(
  p: UnifiedStructuredParams
): Promise<UnifiedStructuredResult<T>> {
  const config = await getLlmConfig();

  // Abort on whichever fires first: our overall deadline, or a caller signal
  // (component unmount / cancel). `deadline.aborted` lets us tell the two apart
  // so a timeout reads as a friendly "tardó demasiado", not a raw AbortError.
  const deadline = AbortSignal.timeout(LLM_DEADLINE_MS);
  const signal = p.signal ? AbortSignal.any([p.signal, deadline]) : deadline;

  if (config.provider === "openrouter") {
    const model = config.perAgent?.[p.agentId] ?? config.defaultModel;
    if (!model) {
      throw new LLMError(
        "No hay un modelo de OpenRouter configurado. Entra en /admin y elige un modelo."
      );
    }
    const apiKey = await getOpenRouterKey();
    if (!apiKey) {
      throw new LLMError(
        "Falta la clave de OpenRouter. Añádela en /admin para que los agentes puedan pensar."
      );
    }
    try {
      const r = await callOpenRouterStructured<T>({
        apiKey,
        model,
        system: p.system,
        prompt: p.prompt,
        schema: p.schema,
        toolName: p.toolName,
        toolDescription: p.toolDescription,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
        signal,
      });
      return { ...r, model, provider: "openrouter" };
    } catch (e) {
      if (deadline.aborted) {
        throw new LLMError(
          "La IA tardó demasiado en responder. Espera unos segundos y vuelve a intentarlo."
        );
      }
      if (e instanceof Error && e.name === "AbortError") throw e;
      throw new LLMError(
        e instanceof Error ? e.message : "Fallo llamando a OpenRouter"
      );
    }
  }

  // provider === 'anthropic'
  const model = defaultAnthropicModel(p.agentId);
  try {
    const r = await callAnthropicStructured<T>({
      model,
      system: p.system,
      prompt: p.prompt,
      schema: p.schema,
      toolName: p.toolName,
      toolDescription: p.toolDescription,
      maxTokens: p.maxTokens,
      temperature: p.temperature,
      signal,
    });
    return { ...r, model, provider: "anthropic" };
  } catch (e) {
    if (deadline.aborted) {
      throw new LLMError(
        "La IA tardó demasiado en responder. Espera unos segundos y vuelve a intentarlo."
      );
    }
    if (e instanceof Error && e.name === "AbortError") throw e;
    if (e instanceof AnthropicError) throw new LLMError(e.message);
    throw e;
  }
}
