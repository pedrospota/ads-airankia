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
import { recordCost } from "@/lib/cost-ledger";
import type { AgentId } from "@/lib/engine/types";
import type { BenchmarkCostContext } from "./types";

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
