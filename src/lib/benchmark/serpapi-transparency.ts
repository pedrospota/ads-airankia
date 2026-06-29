// ============================================================================
// SerpApi — Google Ads Transparency Center (competitor creatives + age).
//
// Port of windmill/f/benchmark/serpapi_transparency.ts without the windmill-client
// dependency. Reads SERPAPI_KEY from process.env.
//
// Returns the domain's running ad creatives with first/last shown dates and
// days_active — this is what lets the benchmark dashboard show "oldest ads"
// and the share-of-voice timeline. Sorts by days_active desc (oldest first) so
// the top-5 are the most battle-tested creatives, as Pedro's n8n workflow does.
//
// NOTE: the existing searchapi.ts uses SearchApi.io's transparency endpoint.
// This file uses SerpApi's equivalent (Pedro has both keys, and his n8n workflow
// specifically uses SerpApi for transparency). The engine's ad-spy dispatcher
// (ad-spy.ts) picks whichever is configured, preferring SerpApi.
// ============================================================================

import { recordCost } from "@/lib/cost-ledger";
import type { CompetitorAd, AdsStatus, BenchmarkCostContext } from "./types";

function serpApiKey(): string | null {
  return process.env.SERPAPI_KEY?.trim() || process.env.SERPAPI_API_KEY?.trim() || null;
}

export function serpApiConfigured(): boolean {
  return serpApiKey() !== null;
}

export interface SerpApiTransparencyResult {
  status: AdsStatus;
  domain: string;
  region: string; // "global" when no region filter applied
  totalAds: number;
  ads: CompetitorAd[];
  /** Unprocessed API response items — includes image URL, days_active, legal names, etc. */
  rawCreatives: RawCreative[];
}

interface RawCreative {
  advertiser?: string | null;
  advertiser_name?: string | null;
  advertiser_id?: string | null;
  advertiser_legal_name?: string | null;
  legal_name?: string | null;
  target_domain?: string | null;
  format?: string | null;
  first_shown?: string | null;
  first_shown_date?: string | null;
  last_shown?: string | null;
  last_shown_date?: string | null;
  total_days_shown?: number | null;
  days?: number | null;
  image?: string | null;
  thumbnail?: string | null;
  preview?: string | null;
  details_link?: string | null;
  link?: string | null;
  headline?: string | null;
  description?: string | null;
  body?: string | null;
}

function mapCreative(c: RawCreative, domain: string): CompetitorAd {
  return {
    format: c.format ?? "text",
    headline: c.headline ?? undefined,
    body: c.body ?? c.description ?? undefined,
    destinationUrl: c.target_domain
      ? `https://${c.target_domain}`
      : undefined,
    firstShown: c.first_shown ?? c.first_shown_date ?? undefined,
    lastShown: c.last_shown ?? c.last_shown_date ?? undefined,
  };
}

/**
 * Fetch a competitor domain's active ad creatives from Google Ads Transparency
 * Center via SerpApi. Returns up to maxAds creatives sorted oldest-first.
 *
 * IMPORTANT: region is NOT sent by default — Google Transparency returns global
 * results without it, which is the correct default. Only pass region when the
 * user explicitly requests a specific country.
 * Never throws — any failure yields { status:"error", ads:[] }.
 */
export async function serpApiTransparency(
  domain: string,
  region: string | null,   // null = don't filter by region (global)
  cost: BenchmarkCostContext,
  maxAds = 12
): Promise<SerpApiTransparencyResult> {
  const key = serpApiKey();
  if (!key) {
    return { status: "off", domain, region: region ?? "global", totalAds: 0, ads: [], rawCreatives: [] };
  }

  const qs = new URLSearchParams({
    engine: "google_ads_transparency_center",
    text: domain,
    api_key: key,
    num: "100",
  });
  // Only send region when explicitly requested — omitting it returns global results.
  if (region) qs.set("region", region);

  let data: { ad_creatives?: RawCreative[]; ads?: RawCreative[] } | undefined;
  try {
    const resp = await fetch(`https://serpapi.com/search?${qs.toString()}`, {
      signal: AbortSignal.timeout(25000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      meter(cost, domain, 1, "http_" + resp.status);
      return { status: "error", domain, region: region ?? "global", totalAds: 0, ads: [], rawCreatives: [] };
    }
    data = await resp.json();
  } catch {
    meter(cost, domain, 1, "exception");
    return { status: "error", domain, region: region ?? "global", totalAds: 0, ads: [], rawCreatives: [] };
  }

  const creatives: RawCreative[] = data?.ad_creatives ?? data?.ads ?? [];
  // Sort oldest-first (most days_active at top) — mirrors n8n workflow.
  creatives.sort(
    (a, b) =>
      (Number(b.total_days_shown ?? b.days ?? 0)) -
      (Number(a.total_days_shown ?? a.days ?? 0))
  );

  const ads = creatives.slice(0, maxAds).map((c) => mapCreative(c, domain));
  meter(cost, domain, 1, "ok");

  return {
    status: ads.length ? "ok" : "empty",
    domain,
    region: region ?? "global",
    totalAds: creatives.length,
    ads,
    rawCreatives: creatives,
  };
}

function meter(
  cost: BenchmarkCostContext,
  domain: string,
  units: number,
  outcome: string
): void {
  void recordCost({
    category: "external_api",
    provider: "serpapi",
    resource: "google_ads_transparency_center",
    units,
    costMicros: 0,
    userId: cost.userId ?? null,
    brandId: cost.brandId ?? null,
    workspaceId: cost.workspaceId ?? null,
    runId: cost.runId ?? null,
    meta: { module: "benchmark", stage: "ad_spy", domain, outcome },
  });
}
