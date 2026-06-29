// ============================================================================
// Oxylabs — keyword → Google Search advertisers (real paid-ad discovery).
//
// Port of windmill/f/benchmark/oxylabs_keyword_ads.ts without the windmill-client
// dependency. Reads credentials from process.env: OXYLABS_USERNAME / OXYLABS_PASSWORD
// (with OXYLABS_USER / OXYLABS_PASS as aliases for compatibility).
//
// Calls POST https://realtime.oxylabs.io/v1/queries with source "google_ads" —
// this is what Pedro's n8n workflow does ("detect who's doing ads on that keyword,
// like REAL data"). Returns discovered advertiser domains + the raw ad rows.
//
// Cost: metered to the cost ledger as provider "oxylabs". Every call is gated by
// the same adSpyAllowedForRun() contract used by the existing SearchApi spy, so
// no spend can happen without the user's explicit per-run opt-in or the admin gate.
// ============================================================================

import { recordCost } from "@/lib/cost-ledger";
import type { BenchmarkCostContext } from "./types";

function creds(): { username: string; password: string } | null {
  const username =
    process.env.OXYLABS_USERNAME?.trim() ||
    process.env.OXYLABS_USER?.trim();
  const password =
    process.env.OXYLABS_PASSWORD?.trim() ||
    process.env.OXYLABS_PASS?.trim();
  if (!username || !password) return null;
  return { username, password };
}

export function oxylabsConfigured(): boolean {
  return creds() !== null;
}

function toDomain(u?: string | null): string | null {
  if (!u) return null;
  try {
    const h = new URL(u.startsWith("http") ? u : `https://${u}`).hostname;
    return h.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export interface OxylabsAd {
  position: number | null;
  title: string | null;
  description: string | null;
  displayedUrl: string | null;
  url: string | null;
  domain: string | null;
}

export interface OxylabsResult {
  keyword: string;
  geoLocation: string;
  advertisers: string[];
  ads: OxylabsAd[];
}

/**
 * Real-time Google Ads SERP for one keyword via Oxylabs.
 * Returns the unique advertiser domains + every ad row found.
 * Never throws — on any failure returns { advertisers:[], ads:[] }.
 */
export async function oxylabsKeywordAds(
  keyword: string,
  geoLocation: string,
  cost: BenchmarkCostContext
): Promise<OxylabsResult> {
  const c = creds();
  if (!c) {
    return { keyword, geoLocation, advertisers: [], ads: [] };
  }

  const auth =
    "Basic " +
    Buffer.from(`${c.username}:${c.password}`).toString("base64");

  let data: unknown;
  try {
    const resp = await fetch("https://realtime.oxylabs.io/v1/queries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        source: "google_ads",
        query: keyword,
        geo_location: geoLocation,
        parse: true,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      meter(cost, keyword, "http_" + resp.status);
      return { keyword, geoLocation, advertisers: [], ads: [] };
    }
    data = await resp.json();
  } catch {
    meter(cost, keyword, "exception");
    return { keyword, geoLocation, advertisers: [], ads: [] };
  }

  // Oxylabs parsed google_ads: ads live under results[0].content.results.
  // Different Oxylabs parser versions put them in different buckets — be defensive.
  const raw = data as { results?: { content?: Record<string, unknown> }[] };
  const content: Record<string, unknown> = raw?.results?.[0]?.content ?? {};
  const buckets: Record<string, unknown> =
    (content.results as Record<string, unknown> | undefined) ?? content;
  const rawAds: Record<string, unknown>[] = [];
  for (const key of ["paid", "ads", "top_ads", "bottom_ads", "shopping"]) {
    const arr = (buckets as Record<string, unknown>)?.[key];
    if (Array.isArray(arr)) rawAds.push(...arr);
  }

  const ads: OxylabsAd[] = rawAds.map((a) => {
    const url =
      (a.url as string | null) ??
      (a.link as string | null) ??
      (a.url_shown as string | null) ??
      null;
    return {
      position:
        typeof a.pos === "number"
          ? a.pos
          : typeof a.position === "number"
            ? a.position
            : null,
      title:
        (a.title as string | null) ?? (a.headline as string | null) ?? null,
      description:
        (a.desc as string | null) ??
        (a.description as string | null) ??
        null,
      displayedUrl:
        (a.url_shown as string | null) ??
        (a.displayed_url as string | null) ??
        null,
      url,
      domain: toDomain((a.url_shown as string | null) ?? url),
    };
  });

  const advertisers = [
    ...new Set(ads.map((x) => x.domain).filter((d): d is string => Boolean(d))),
  ];

  meter(cost, keyword, "ok");
  return { keyword, geoLocation, advertisers, ads };
}

function meter(cost: BenchmarkCostContext, keyword: string, outcome: string): void {
  void recordCost({
    category: "external_api",
    provider: "oxylabs",
    resource: "google_ads",
    units: 1,
    costMicros: 0, // Oxylabs charges per 1k queries; tracked as call volume for now
    userId: cost.userId ?? null,
    brandId: cost.brandId ?? null,
    workspaceId: cost.workspaceId ?? null,
    runId: cost.runId ?? null,
    meta: { module: "benchmark", stage: "discover_advertisers", keyword, outcome },
  });
}
