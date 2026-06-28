// ============================================================================
// Cost ledger — the single write path into the `cost_events` table.
//
// Every metered unit of spend goes through recordCost(): each LLM agent step
// (tokens + $) and each external API call (Google Ads, SearchApi, …). The
// resulting rows power the /admin Costs panel (per-day / per-user / per-provider
// rollups), so we can answer "what did each user cost us today?" for tokens AND
// APIs in one place.
//
// HARD RULE: recording is best-effort and NEVER throws. A metering failure must
// not break a campaign build or an API call — we log and swallow. All writes go
// to adsDb only (never the original Supabase).
// ============================================================================

import { adsDb } from "@/lib/ads-db";
import { costEvents } from "@/lib/schema";

export type CostCategory = "llm" | "external_api";

export interface RecordCostInput {
  category: CostCategory;
  /** 'anthropic' | 'openrouter' | 'google_ads' | 'searchapi' | … */
  provider?: string | null;
  /** Model id (LLM) or API operation name (external). */
  resource?: string | null;
  costMicros?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** For non-token APIs: number of results/requests billed. */
  units?: number;
  userId?: string | null;
  brandId?: string | null;
  workspaceId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  occurredAt?: Date;
  meta?: Record<string, unknown> | null;
}

/** Infer the LLM provider from a model id (claude* = Anthropic-direct). */
export function inferLlmProvider(model?: string | null): string | null {
  if (!model) return null;
  return model.toLowerCase().startsWith("claude") ? "anthropic" : "openrouter";
}

const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Append one cost event. Fire-and-forget safe — resolves even on DB error.
 * Soft-ref ids are validated as UUIDs and dropped (→ null) when malformed so a
 * bad id can never reject the insert.
 */
export async function recordCost(input: RecordCostInput): Promise<void> {
  try {
    await adsDb.insert(costEvents).values({
      occurredAt: input.occurredAt ?? new Date(),
      userId: isUuid(input.userId) ? input.userId : null,
      brandId: isUuid(input.brandId) ? input.brandId : null,
      workspaceId: isUuid(input.workspaceId) ? input.workspaceId : null,
      runId: isUuid(input.runId) ? input.runId : null,
      stepId: isUuid(input.stepId) ? input.stepId : null,
      category: input.category,
      provider: input.provider ?? null,
      resource: input.resource ?? null,
      tokensIn: Math.max(0, Math.round(input.tokensIn ?? 0)),
      tokensOut: Math.max(0, Math.round(input.tokensOut ?? 0)),
      units: Math.max(0, Math.round(input.units ?? 0)),
      costMicros: Math.max(0, Math.round(input.costMicros ?? 0)),
      meta: input.meta ?? null,
    });
  } catch (e) {
    console.error(
      "[cost-ledger] failed to record cost event:",
      e instanceof Error ? e.message : e
    );
  }
}
