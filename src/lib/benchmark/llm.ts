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

/** Outcome of an LLM report generation — carries WHY it failed (no silent null)
 *  and the real model + token counts so the report can show them to the user. */
export type BenchmarkReportResult = {
  markdown: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Human-readable reason when markdown is null (shown to the user, not hidden). */
  error: string | null;
};

/**
 * Plain-text LLM report generation for the benchmark — the AI is the PRIMARY
 * writer (deterministic stays as the fallback). Unlike the old silent helper, this
 * NEVER returns a bare null: on any failure it returns a precise reason (no key,
 * wrong provider, no model, HTTP status, timeout, empty) so the report can tell the
 * user exactly why the AI didn't run and what to fix in /admin. Never throws.
 */
export async function benchmarkReport(opts: {
  system: string;
  prompt: string;
  cost: BenchmarkCostContext;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<BenchmarkReportResult> {
  const fail = (error: string, model: string | null = null): BenchmarkReportResult => ({
    markdown: null, model, tokensIn: 0, tokensOut: 0, error,
  });
  let model: string | null = null;
  try {
    const config = await getLlmConfig();
    const key = await getOpenRouterKey();
    model = config.defaultModel;
    if (config.provider !== "openrouter") {
      return fail(`LLM provider is "${config.provider}", not OpenRouter — set provider to OpenRouter in /admin.`);
    }
    if (!key) return fail("No OpenRouter API key is set — add it in /admin.");
    if (!model) return fail("No OpenRouter model is selected — pick one in /admin.");

    // Strip any non-printable/control chars a pasted key might carry — otherwise
    // building the Authorization header can throw a TypeError that echoes the raw
    // header value (the key) into the error path. Never let the key reach an error.
    const safeKey = key.replace(/[^\x20-\x7E]/g, "");

    let resp: Response;
    try {
      resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${safeKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.prompt },
          ],
          max_tokens: opts.maxTokens ?? 4000,
          temperature: 0.5,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 95_000),
      });
    } catch (e) {
      // NEVER interpolate the raw exception message — it can embed the request
      // headers (incl. the key). Branch on the error name only.
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      console.warn("[benchmark] report fetch failed:", (e as Error)?.name);
      return fail(
        timedOut
          ? `Model "${model}" timed out — try a faster model in /admin.`
          : "Network error reaching OpenRouter — check connectivity and try again.",
        model,
      );
    }
    if (!resp.ok) {
      await resp.text().catch(() => ""); // drain body; do NOT surface raw API internals
      const hint = resp.status === 401 ? " (bad or expired key)" : resp.status === 402 ? " (out of credits)" : resp.status === 404 ? " (model id not found)" : "";
      return fail(`The AI model "${model}" couldn't be reached — HTTP ${resp.status}${hint}. Check it in /admin.`, model);
    }
    const j = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    if (j?.error?.message) return fail(`The AI model "${model}" returned an error: ${clipErr(j.error.message)}`, model);
    const text = j?.choices?.[0]?.message?.content?.trim() ?? "";
    const tokensIn = j?.usage?.prompt_tokens ?? 0;
    const tokensOut = j?.usage?.completion_tokens ?? 0;
    void recordCost({
      category: "llm", provider: "openrouter", resource: model,
      tokensIn, tokensOut, costMicros: 0,
      userId: opts.cost.userId ?? null, brandId: opts.cost.brandId ?? null,
      workspaceId: opts.cost.workspaceId ?? null, runId: opts.cost.runId ?? null,
      meta: { module: "benchmark", stage: "report" },
    });
    if (!text) return fail(`Model "${model}" returned an empty response — try another model in /admin.`, model);
    return { markdown: text, model, tokensIn, tokensOut, error: null };
  } catch (e) {
    // Generic message only — never echo a raw exception (key-leak safe).
    console.warn("[benchmark] report generation error:", (e as Error)?.name);
    return fail("Unexpected error generating the AI report — check the model/key in /admin.", model);
  }
}

function clipErr(s: string): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 159) + "…" : t;
}

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
