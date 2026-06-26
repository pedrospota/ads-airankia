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

export async function callStructured<T>(
  p: UnifiedStructuredParams
): Promise<UnifiedStructuredResult<T>> {
  const config = await getLlmConfig();

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
        signal: p.signal,
      });
      return { ...r, model, provider: "openrouter" };
    } catch (e) {
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
      signal: p.signal,
    });
    return { ...r, model, provider: "anthropic" };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    if (e instanceof AnthropicError) throw new LLMError(e.message);
    throw e;
  }
}
