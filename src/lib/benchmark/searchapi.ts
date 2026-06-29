// ============================================================================
// PAID ad-spy via SearchApi.io (google_ads_transparency_center). This is the
// ONLY paid dependency in the benchmark suite and it is OFF by default.
//
// HARD SAFETY CONTRACT:
//  - fetchCompetitorAds() calls adSpyAllowed() FIRST and returns { status:"off" }
//    immediately unless an admin enabled the gate AND a key is present. So with
//    no key / gate off (the default), this file performs ZERO network calls and
//    spends nothing.
//  - Every real call is metered to the cost ledger as provider "searchapi".
//  - The response shape is parsed defensively: any mismatch yields [] + status,
//    never a throw. The exact field mapping should be re-verified against the
//    SearchApi docs the first time the gate is switched on with a live key.
// ============================================================================

import { recordCost } from "@/lib/cost-ledger";
import { adSpyAllowedForRun, getSearchApiKey, getBenchmarkConfig } from "./config";
import { toDomain } from "./page-fetch";
import type { CompetitorAd, AdsStatus, BenchmarkCostContext } from "./types";

const ENDPOINT = "https://www.searchapi.io/api/v1/search";

export interface AdSpyResult {
  status: AdsStatus;
  ads: CompetitorAd[] | null;
}

interface RawAd {
  format?: string;
  type?: string;
  headline?: string;
  title?: string;
  text?: string;
  body?: string;
  description?: string;
  destination_url?: string;
  link?: string;
  first_shown?: string;
  last_shown?: string;
}

function mapAd(raw: RawAd): CompetitorAd {
  return {
    format: String(raw.format ?? raw.type ?? "text"),
    headline: raw.headline ?? raw.title ?? undefined,
    body: raw.body ?? raw.text ?? raw.description ?? undefined,
    destinationUrl: raw.destination_url ?? raw.link ?? undefined,
    firstShown: raw.first_shown ?? undefined,
    lastShown: raw.last_shown ?? undefined,
  };
}

/**
 * Pull a competitor's running ad creatives from the Google Ads Transparency
 * Center via SearchApi. Returns { status:"off", ads:null } when the paid gate
 * is closed — callers render the rest of the report unchanged.
 *
 * `opts.optIn` is the end user's per-run "live competitor ads" approval; it
 * bypasses the global admin gate but still requires a key (see adSpyAllowedForRun).
 */
export async function fetchCompetitorAds(
  domain: string,
  countryCode: string,
  cost: BenchmarkCostContext,
  opts?: { optIn?: boolean }
): Promise<AdSpyResult> {
  // GATE — the single most important line in this file. No spend without it.
  if (!(await adSpyAllowedForRun(opts?.optIn ?? false)))
    return { status: "off", ads: null };

  const key = await getSearchApiKey();
  if (!key) return { status: "off", ads: null };
  const config = await getBenchmarkConfig();

  try {
    const params = new URLSearchParams({
      engine: "google_ads_transparency_center",
      q: domain,
      region: countryCode || "ES",
      api_key: key,
    });
    const resp = await fetch(`${ENDPOINT}?${params.toString()}`, {
      signal: AbortSignal.timeout(20000),
      headers: { Accept: "application/json" },
    });

    if (!resp.ok) {
      void meter(cost, domain, 1, "http_" + resp.status);
      return { status: "error", ads: null };
    }

    const json = (await resp.json()) as {
      ads?: RawAd[];
      ad_creatives?: RawAd[];
    };
    const rawAds = json.ads ?? json.ad_creatives ?? [];
    const ads = rawAds.slice(0, config.maxAdsPerDomain).map(mapAd);

    void meter(cost, domain, 1, "ok");
    return { status: ads.length ? "ok" : "empty", ads };
  } catch {
    void meter(cost, domain, 1, "exception");
    return { status: "error", ads: null };
  }
}

// ----------------------------------------------------------------------------
// Keyword → real advertisers. Reads a live Google SERP via SearchApi and pulls
// the domains running PAID ads on the term — i.e. who actually competes for that
// keyword right now. Same paid gate as ad-spy (the user's per-run opt-in is the
// spend approval; a key is still required). Returns { status:"off", domains:[] }
// when the gate is closed → the caller just uses the saved competitor list.
// ----------------------------------------------------------------------------
export interface KeywordAdvertisersResult {
  status: AdsStatus;
  domains: string[];
}

interface RawSerpAd {
  link?: string;
  tracking_link?: string;
  displayed_link?: string;
  source?: string;
}

export async function discoverKeywordAdvertisers(
  keyword: string,
  countryCode: string,
  cost: BenchmarkCostContext,
  opts?: { optIn?: boolean }
): Promise<KeywordAdvertisersResult> {
  // GATE — identical contract to fetchCompetitorAds. No spend without it.
  if (!(await adSpyAllowedForRun(opts?.optIn ?? false)))
    return { status: "off", domains: [] };

  const key = await getSearchApiKey();
  if (!key) return { status: "off", domains: [] };

  const q = keyword.trim();
  if (!q) return { status: "empty", domains: [] };

  try {
    const params = new URLSearchParams({
      engine: "google",
      q,
      gl: (countryCode || "ES").toLowerCase(),
      api_key: key,
    });
    const resp = await fetch(`${ENDPOINT}?${params.toString()}`, {
      signal: AbortSignal.timeout(20000),
      headers: { Accept: "application/json" },
    });

    if (!resp.ok) {
      void meterDiscovery(cost, q, "http_" + resp.status);
      return { status: "error", domains: [] };
    }

    const json = (await resp.json()) as { ads?: RawSerpAd[] };
    const rawAds = json.ads ?? [];
    const domains: string[] = [];
    for (const ad of rawAds) {
      const candidate =
        ad.link || ad.displayed_link || ad.source || ad.tracking_link || "";
      const d = toDomain(candidate);
      if (d && !domains.includes(d)) domains.push(d);
    }

    void meterDiscovery(cost, q, "ok");
    return { status: domains.length ? "ok" : "empty", domains };
  } catch {
    void meterDiscovery(cost, q, "exception");
    return { status: "error", domains: [] };
  }
}

// One metered row per SERP advertiser-discovery search (provider "searchapi").
function meterDiscovery(
  cost: BenchmarkCostContext,
  keyword: string,
  outcome: string
): Promise<void> {
  return recordCost({
    category: "external_api",
    provider: "searchapi",
    resource: "google_serp_ads",
    units: 1,
    costMicros: 0,
    userId: cost.userId ?? null,
    brandId: cost.brandId ?? null,
    workspaceId: cost.workspaceId ?? null,
    runId: cost.runId ?? null,
    meta: { module: "benchmark", stage: "discover_advertisers", keyword, outcome },
  });
}

// One metered row per SearchApi search. We record the call VOLUME (units); the
// exact $/search depends on the plan, so costMicros stays 0 here and the spend
// is tracked as call count until a precise price is wired in.
function meter(
  cost: BenchmarkCostContext,
  domain: string,
  searches: number,
  outcome: string
): Promise<void> {
  return recordCost({
    category: "external_api",
    provider: "searchapi",
    resource: "google_ads_transparency_center",
    units: searches,
    costMicros: 0,
    userId: cost.userId ?? null,
    brandId: cost.brandId ?? null,
    workspaceId: cost.workspaceId ?? null,
    runId: cost.runId ?? null,
    meta: { module: "benchmark", stage: "ad_spy", domain, outcome },
  });
}
