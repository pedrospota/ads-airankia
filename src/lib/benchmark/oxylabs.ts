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
  // url_shown comes back as "https://www.semrush.com › ai_search › seo_toolkit"
  // (breadcrumb with spaces) — strip everything after the first space/breadcrumb
  // so the URL parser doesn't choke and return null.
  const clean = u.split(/[\s›|]/)[0]?.trim();
  if (!clean) return null;
  try {
    const h = new URL(clean.startsWith("http") ? clean : `https://${clean}`).hostname;
    return h.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Pull campaign intelligence out of the Google `aclk` tracking URL (data_rw).
 * The real value (campaign name, the keyword Google matched, match type) lives
 * either on the outer aclk query string or, more often, inside the `adurl`
 * param which is itself a full URL with its own query string. We read both.
 * Never throws.
 */
function extractAclkMeta(dataRw?: string | null): {
  campaign: string | null;
  campaignLabel: string | null;
  targetedKeyword: string | null;
  matchType: string | null;
} {
  const empty = { campaign: null, campaignLabel: null, targetedKeyword: null, matchType: null };
  if (!dataRw) return empty;
  try {
    const outer = new URL(dataRw);
    const outerParams = outer.searchParams;
    let innerParams: URLSearchParams | null = null;
    const adurl = outerParams.get("adurl");
    if (adurl) {
      try {
        innerParams = new URL(adurl).searchParams;
      } catch {
        // adurl can be partially encoded — pull the query part manually.
        const q = adurl.split("?")[1];
        if (q) innerParams = new URLSearchParams(q);
      }
    }
    const pick = (keys: string[]): string | null => {
      for (const k of keys) {
        const v = innerParams?.get(k) ?? outerParams.get(k);
        if (v && v.trim()) return decodeURIComponent(v.trim());
      }
      return null;
    };
    return {
      campaign: pick(["g_campaign", "cmp", "utm_campaign", "hsa_cam"]),
      campaignLabel: pick(["label", "g_acctid"]),
      targetedKeyword: pick(["g_keyword", "kw", "utm_term", "hsa_kw"]),
      matchType: pick(["matchtype", "hsa_mt"]),
    };
  } catch {
    return empty;
  }
}

export interface OxylabsSitelink {
  title: string | null;
  url: string | null;
}

export interface OxylabsAd {
  position: number | null;
  positionOverall: number | null;
  title: string | null;
  description: string | null;
  displayedUrl: string | null;
  /** The ad's actual landing page. */
  url: string | null;
  /** The advertiser's root destination (from data_pcu). */
  destinationUrl: string | null;
  /** The raw Google aclk tracking URL (data_rw). */
  trackingUrl: string | null;
  domain: string | null;
  /** Campaign name decoded from the aclk URL (e.g. US_SRCH_AI_Toolkit_EN). */
  campaign: string | null;
  /** Campaign label decoded from the aclk URL (e.g. ai_toolkit). */
  campaignLabel: string | null;
  /** The keyword Google actually matched this ad to (from the aclk URL). */
  targetedKeyword: string | null;
  /** Match type (e = exact, p = phrase, b = broad). */
  matchType: string | null;
  /** Ad extensions (inline + expanded sitelinks). */
  sitelinks: OxylabsSitelink[];
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
      null;
    const pcu = a.data_pcu;
    const destinationUrl =
      Array.isArray(pcu) && typeof pcu[0] === "string" ? (pcu[0] as string) : null;
    const trackingUrl = (a.data_rw as string | null) ?? null;
    const meta = extractAclkMeta(trackingUrl);

    // Sitelinks come as { inline:[{title,url}], expanded:[{title,url}] }.
    const sl = a.sitelinks as
      | { inline?: { title?: string; url?: string }[]; expanded?: { title?: string; url?: string }[] }
      | undefined;
    const sitelinks: OxylabsSitelink[] = [
      ...(sl?.inline ?? []),
      ...(sl?.expanded ?? []),
    ].map((s) => ({ title: s.title ?? null, url: s.url ?? null }));

    return {
      position:
        typeof a.pos === "number"
          ? a.pos
          : typeof a.position === "number"
            ? a.position
            : null,
      positionOverall: typeof a.pos_overall === "number" ? a.pos_overall : null,
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
      destinationUrl,
      trackingUrl,
      // Prefer the clean destination root / landing page over the breadcrumb url_shown.
      domain: toDomain(destinationUrl ?? url ?? (a.url_shown as string | null)),
      campaign: meta.campaign,
      campaignLabel: meta.campaignLabel,
      targetedKeyword: meta.targetedKeyword,
      matchType: meta.matchType,
      sitelinks,
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
