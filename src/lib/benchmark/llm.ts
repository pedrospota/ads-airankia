// ============================================================================
// Benchmark LLM helper — thin wrapper over the unified LLM layer (the same one
// the search agents use), so the benchmark inherits provider routing (Anthropic
// or OpenRouter, per /admin), the structured-output contract, the deadline, and
// the friendly error messages, with zero duplication.
//
// callStructured() requires an AgentId (it picks the model tier / per-agent
// OpenRouter override). The benchmark isn't one of the pipeline agents, so we
// map a coarse tier → a representative agent id purely for model selection:
//   - "opus"   → strategy-grade reasoning (synthesis)
//   - "sonnet" → high-volume extraction (per-domain landing teardown)
// Cost is metered here (callStructured itself doesn't record) with a benchmark
// tag so the /admin Costs panel attributes it per user/brand.
// ============================================================================

import { callStructured } from "@/lib/llm";
import { getLlmConfig, getOpenRouterKey } from "@/lib/llm/settings";
import { recordCost } from "@/lib/cost-ledger";
import type { AgentId } from "@/lib/engine/types";
import type { BenchmarkCostContext } from "./types";

/**
 * Plain-text (NON-structured) completion for the benchmark's narrative section.
 * The structured/tool path fails on models weak at function-calling (the /admin
 * model moonshotai/kimi-latest "didn't return a valid structured object"), but
 * those models write Markdown fine — so for free-form prose we skip the schema.
 * OpenRouter only; returns null on the Anthropic provider or any failure (the
 * deterministic report still stands). Never throws.
 */
export async function benchmarkNarrative(opts: {
  system: string;
  prompt: string;
  cost: BenchmarkCostContext;
  maxTokens?: number;
}): Promise<string | null> {
  try {
    const config = await getLlmConfig();
    const key = await getOpenRouterKey();
    if (config.provider !== "openrouter" || !key || !config.defaultModel) return null;

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: config.defaultModel,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.prompt },
        ],
        max_tokens: opts.maxTokens ?? 2500,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(70_000),
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = j?.choices?.[0]?.message?.content?.trim() ?? "";
    void recordCost({
      category: "llm",
      provider: "openrouter",
      resource: config.defaultModel,
      tokensIn: j?.usage?.prompt_tokens ?? 0,
      tokensOut: j?.usage?.completion_tokens ?? 0,
      costMicros: 0,
      userId: opts.cost.userId ?? null,
      brandId: opts.cost.brandId ?? null,
      workspaceId: opts.cost.workspaceId ?? null,
      runId: opts.cost.runId ?? null,
      meta: { module: "benchmark", stage: "narrative" },
    });
    return text || null;
  } catch {
    return null;
  }
}

const TIER_AGENT: Record<"opus" | "sonnet", AgentId> = {
  opus: "structure_architect",
  sonnet: "keyword_researcher",
};

export async function benchmarkLlm<T>(opts: {
  tier: "opus" | "sonnet";
  system?: string;
  prompt: string;
  schema: Record<string, unknown>;
  toolName: string;
  toolDescription?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Stage label for cost-ledger meta (e.g. "landing_teardown", "strategy"). */
  stage: string;
  cost: BenchmarkCostContext;
}): Promise<T> {
  const r = await callStructured<T>({
    agentId: TIER_AGENT[opts.tier],
    system: opts.system,
    prompt: opts.prompt,
    schema: opts.schema,
    toolName: opts.toolName,
    toolDescription: opts.toolDescription,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    signal: opts.signal,
  });

  void recordCost({
    category: "llm",
    provider: r.provider,
    resource: r.model,
    tokensIn: r.usage.inputTokens,
    tokensOut: r.usage.outputTokens,
    costMicros: r.costMicros,
    userId: opts.cost.userId ?? null,
    brandId: opts.cost.brandId ?? null,
    workspaceId: opts.cost.workspaceId ?? null,
    runId: opts.cost.runId ?? null,
    meta: { module: "benchmark", stage: opts.stage },
  });

  return r.data;
}
