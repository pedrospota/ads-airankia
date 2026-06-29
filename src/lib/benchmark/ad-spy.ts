// ============================================================================
// Ad-spy dispatcher — routes between SerpApi (Pedro's n8n provider) and the
// existing SearchApi.io integration, with the same hard gate contract.
//
// Provider priority for transparency-center creatives:
//   1. SerpApi (SERPAPI_KEY)  — Pedro's n8n workflow uses this; preferred.
//   2. SearchApi (SEARCHAPI_API_KEY) — existing integration, fallback.
//
// Provider for keyword → advertiser discovery:
//   Oxylabs (OXYLABS_USERNAME/PASSWORD) — real Google Ads SERP; this is the
//   n8n "google ads by keyword" node. Falls back to SearchApi SERP if only
//   SearchApi is configured.
//
// GATE: adSpyAllowedForRun() is called FIRST in every exported function.
// No network call can happen without explicit per-run user opt-in or admin gate.
// ============================================================================

import { adSpyAllowedForRun } from "./config";
import { findCountry } from "./countries";
import { oxylabsKeywordAds, oxylabsConfigured } from "./oxylabs";
import { serpApiTransparency, serpApiConfigured } from "./serpapi-transparency";
import {
  fetchCompetitorAds as searchApiFetchAds,
  discoverKeywordAdvertisers as searchApiDiscover,
} from "./searchapi";
import type { AdsStatus, BenchmarkCostContext, CompetitorAd } from "./types";

export interface AdSpyResult {
  status: AdsStatus;
  ads: CompetitorAd[] | null;
}

export interface DiscoveryResult {
  status: AdsStatus;
  domains: string[];
}

/**
 * Pull a competitor's running ad creatives.
 * Tries SerpApi first (n8n parity), then SearchApi as fallback.
 */
export async function fetchAds(
  domain: string,
  countryCode: string,
  cost: BenchmarkCostContext,
  opts?: { optIn?: boolean; maxAds?: number }
): Promise<AdSpyResult> {
  if (!(await adSpyAllowedForRun(opts?.optIn ?? false))) {
    return { status: "off", ads: null };
  }

  // SerpApi — primary (n8n provider). No region filter by default (global results).
  if (serpApiConfigured()) {
    const result = await serpApiTransparency(
      domain,
      null,   // region omitted by default — only pass when user explicitly requests
      cost,
      opts?.maxAds ?? 12
    );
    if (result.status === "ok" || result.status === "empty") {
      return { status: result.status, ads: result.ads };
    }
    // Fall through to SearchApi on error.
  }

  // SearchApi — fallback.
  return searchApiFetchAds(domain, countryCode, cost, opts);
}

/**
 * Discover which domains are running paid ads on a keyword.
 * Uses Oxylabs (real Google Ads SERP — n8n parity), falls back to SearchApi SERP.
 */
export async function discoverAdvertisers(
  keyword: string,
  countryCode: string,
  cost: BenchmarkCostContext,
  opts?: { optIn?: boolean }
): Promise<DiscoveryResult> {
  if (!(await adSpyAllowedForRun(opts?.optIn ?? false))) {
    return { status: "off", domains: [] };
  }

  // Oxylabs — primary (n8n provider, real google_ads source).
  if (oxylabsConfigured()) {
    const country = findCountry(countryCode);
    const result = await oxylabsKeywordAds(keyword, country.geo, cost);
    if (result.advertisers.length > 0) {
      return { status: "ok", domains: result.advertisers };
    }
    if (result.ads.length === 0 && result.advertisers.length === 0) {
      // Oxylabs returned something but no ads — could be a real empty SERP or an
      // error. Try SearchApi as a second opinion only if it's configured.
    }
  }

  // SearchApi — fallback.
  return searchApiDiscover(keyword, countryCode, cost, opts);
}
