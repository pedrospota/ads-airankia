// ============================================================================
// Competitor Discovery — DataForSEO Labs `competitors_domain` client.
//
// Powers the "🔍 Competitor Discovery" tool: feed a brand domain + market and
// get back the domains that compete for the SAME Google keywords, ranked by
// keyword overlap (DataForSEO calls it `intersections`). Surfaces rivals the
// user never listed.
//
// Auth: HTTP Basic base64(login:password) → DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD.
// Endpoint (verified live):
//   POST /v3/dataforseo_labs/google/competitors_domain/live
//        → tasks[0].result[0].items[] of { domain, intersections, avg_position }
//          (items[0] is the target itself → excluded).
//
// Self-contained — does NOT import the shared dataforseo.ts. Never throws.
//
// PAID discovery (discoverPaidCompetitors, below) is the ads-relevant sibling:
// instead of "who ranks for the same organic keywords", it answers "who ACTUALLY
// runs Google Ads on your keywords right now" via a live Oxylabs scrape. Reuses
// dataforseo.ts only to seed the probed keyword set from the brand's own footprint.
// ============================================================================

import { oxylabsKeywordAds } from "@/lib/benchmark/oxylabs";
import { toDomain } from "@/lib/benchmark/page-fetch";
import type { BenchmarkCostContext } from "@/lib/benchmark/types";
import { domainPaidKeywords } from "@/lib/spy/dataforseo";

const BASE = "https://api.dataforseo.com/v3";

function creds(): string | null {
  const login = process.env.DATAFORSEO_LOGIN?.trim();
  const password = process.env.DATAFORSEO_PASSWORD?.trim();
  if (!login || !password) return null;
  return Buffer.from(`${login}:${password}`).toString("base64");
}

export function discoveryConfigured(): boolean {
  return creds() !== null;
}

export interface SuggestedCompetitor {
  domain: string;
  /** Number of keywords this domain ranks for that the target also ranks for. */
  intersections: number;
  /** Average SERP position of the domain across those shared keywords. */
  avgPosition: number | null;
}

export async function discoverCompetitors(
  domain: string,
  locationCode: number,
  languageCode: string,
  limit = 20
): Promise<{ data: SuggestedCompetitor[]; cost: number; error: string | null }> {
  const auth = creds();
  if (!auth) return { data: [], cost: 0, error: "DataForSEO credentials are not set." };
  try {
    const resp = await fetch(`${BASE}/dataforseo_labs/google/competitors_domain/live`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          target: domain,
          location_code: locationCode,
          language_code: languageCode,
          // Rank by keyword overlap so the strongest rivals come first.
          order_by: ["intersections,desc"],
          limit: Math.max(1, Math.min(100, limit + 1)), // +1: items[0] is the target itself
          exclude_top_domains: true, // drop google/youtube/etc. mega-domains
        },
      ]),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) return { data: [], cost: 0, error: `DataForSEO HTTP ${resp.status}` };
    const j = (await resp.json()) as {
      cost?: number;
      tasks?: { status_code?: number; status_message?: string; result?: { items?: unknown[] }[] }[];
    };
    // DataForSEO returns 200 even on task-level failures — surface them instead of
    // letting them masquerade as "no competitors found" (20000 = task ok).
    const task = j?.tasks?.[0];
    if (task && typeof task.status_code === "number" && task.status_code !== 20000) {
      return { data: [], cost: j?.cost ?? 0, error: `DataForSEO: ${task.status_message ?? "task error"}` };
    }
    const items = (task?.result?.[0]?.items ?? []) as {
      domain?: string;
      intersections?: number;
      avg_position?: number;
    }[];
    const self = domain.toLowerCase();
    const data: SuggestedCompetitor[] = items
      .map((it) => ({
        domain: (it.domain ?? "").toLowerCase(),
        intersections: typeof it.intersections === "number" ? it.intersections : 0,
        avgPosition: typeof it.avg_position === "number" ? it.avg_position : null,
      }))
      .filter((c) => c.domain && c.domain !== self)
      .slice(0, limit);
    return { data, cost: j?.cost ?? 0, error: null };
  } catch (e) {
    return {
      data: [],
      cost: 0,
      error: (e as Error)?.name === "TimeoutError" ? "DataForSEO timed out." : "DataForSEO request failed.",
    };
  }
}

// ============================================================================
// PAID competitor discovery — "who actually runs Google Ads on your keywords".
//
// Live: probes each keyword through Oxylabs `google_ads` (real paid SERP) and
// aggregates the advertiser domains that show up — the rivals literally bidding
// against you right now. Seeds the keyword set from either explicit seedKeywords
// or the brand's own paid footprint (DataForSEO). Never throws.
// ============================================================================

export interface PaidCompetitor {
  domain: string;
  /** How many of the probed keywords this advertiser ran ads on. */
  keywordsBidOn: number;
  /** The distinct probed keywords it appeared on. */
  keywords: string[];
  /** First ad headline seen for this advertiser (for a taste of their copy). */
  sampleHeadline: string | null;
  /** First ad landing URL seen for this advertiser. */
  sampleUrl: string | null;
  /** Best (lowest) ad position seen across all probed keywords. */
  bestPosition: number | null;
}

const cleanKeyword = (s: unknown): string =>
  typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "";

/** Case-insensitive dedupe, preserving first-seen order. */
function dedupeKeywords(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of list) {
    const key = k.toLowerCase();
    if (!k || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

export async function discoverPaidCompetitors(opts: {
  brandDomain: string;
  seedKeywords?: string[];
  locationCode: number;
  languageCode: string;
  geo: string;
  maxKeywords?: number;
  cost: BenchmarkCostContext;
}): Promise<{ data: PaidCompetitor[]; keywordsProbed: string[]; cost: number; error: string | null }> {
  const maxKeywords =
    typeof opts.maxKeywords === "number" && opts.maxKeywords > 0
      ? Math.min(20, Math.round(opts.maxKeywords))
      : 6;
  const brandNorm = toDomain(opts.brandDomain);

  // (a) Resolve the keywords to probe: explicit seeds win; else derive them from
  //     the brand's own paid footprint (top by estimated traffic value).
  let cost = 0;
  let keywordsProbed: string[];
  const seeds = dedupeKeywords((opts.seedKeywords ?? []).map(cleanKeyword).filter(Boolean));
  if (seeds.length) {
    keywordsProbed = seeds.slice(0, maxKeywords);
  } else if (brandNorm) {
    const kw = await domainPaidKeywords(brandNorm, opts.locationCode, opts.languageCode, 25);
    cost += kw.cost;
    const derived = [...kw.data]
      .sort((a, b) => b.etv - a.etv)
      .map((k) => cleanKeyword(k.keyword))
      .filter(Boolean);
    keywordsProbed = dedupeKeywords(derived).slice(0, maxKeywords);
  } else {
    keywordsProbed = [];
  }

  if (!keywordsProbed.length) {
    return { data: [], keywordsProbed: [], cost, error: "No keywords to probe — add a few seed keywords." };
  }

  // (b) Fire one live Google-Ads scrape per keyword, in parallel.
  const results = await Promise.all(
    keywordsProbed.map((kw) => oxylabsKeywordAds(kw, opts.geo, opts.cost))
  );

  // (c) Aggregate the advertiser domains across every probed keyword.
  const agg = new Map<
    string,
    { domain: string; keywords: Set<string>; sampleHeadline: string | null; sampleUrl: string | null; bestPosition: number | null }
  >();
  for (const res of results) {
    for (const ad of res.ads) {
      const dom = ad.domain;
      if (!dom) continue; // skip empty domains
      if (brandNorm && dom === brandNorm) continue; // skip the brand's own ads
      let e = agg.get(dom);
      if (!e) {
        e = { domain: dom, keywords: new Set(), sampleHeadline: null, sampleUrl: null, bestPosition: null };
        agg.set(dom, e);
      }
      e.keywords.add(res.keyword);
      if (e.sampleHeadline == null && ad.title) e.sampleHeadline = ad.title;
      if (e.sampleUrl == null) e.sampleUrl = ad.url ?? ad.displayedUrl ?? null;
      if (typeof ad.position === "number" && (e.bestPosition == null || ad.position < e.bestPosition)) {
        e.bestPosition = ad.position;
      }
    }
  }

  // (d) Rank by breadth (# keywords bid on), then by best position.
  const data: PaidCompetitor[] = [...agg.values()]
    .map((e) => ({
      domain: e.domain,
      keywordsBidOn: e.keywords.size,
      keywords: [...e.keywords],
      sampleHeadline: e.sampleHeadline,
      sampleUrl: e.sampleUrl,
      bestPosition: e.bestPosition,
    }))
    .sort(
      (a, b) =>
        b.keywordsBidOn - a.keywordsBidOn ||
        (a.bestPosition ?? Number.POSITIVE_INFINITY) - (b.bestPosition ?? Number.POSITIVE_INFINITY)
    );

  return { data, keywordsProbed, cost, error: null };
}
