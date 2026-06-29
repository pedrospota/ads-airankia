// ============================================================================
// DataForSEO — keyword-data provider (search volume, CPC, competition, forecast).
//
// WHY THIS EXISTS
// The whole app reads real keyword metrics through google-ads.ts'
// generateKeywordIdeas / generateKeywordForecast (KeywordPlanIdeaService). That
// service is FREE but requires Google Ads *Basic* access; our developer token is
// still on Test/Explorer access, so every Keyword Planner call returns
// 403 DEVELOPER_TOKEN_NOT_APPROVED. Until Basic access is granted, this module is
// the working substitute: DataForSEO's Google Ads endpoints return the SAME
// underlying Google data (volumes, top-of-page bids, competition, traffic
// forecast) over a paid HTTP API.
//
// HOW IT'S WIRED
// google-ads.ts calls into here ONLY as a fallback — Google first (free), then
// DataForSEO when Google is access/quota-blocked or empty. So the day Basic
// access lands, Google answers first and these paid calls stop automatically.
// This file deliberately mirrors the google-ads.ts contracts (KeywordPlanIdea /
// KeywordForecast) so the fallback is a straight swap with no caller changes.
//
// SECURITY: credentials are read from process.env only (DATAFORSEO_LOGIN /
// DATAFORSEO_PASSWORD, with *_USER/*_PASS as cross-app fallbacks). Never logged,
// never returned to the client.
//
// COST: every call is metered to the cost ledger as provider "dataforseo" with
// the REAL dollar cost DataForSEO reports per request, so spend is fully
// observable in the existing cost dashboard. No call is made unless configured.
// ============================================================================

import { recordCost } from "@/lib/cost-ledger";
import type {
  KeywordPlanIdea,
  KeywordForecast,
  KeywordPlannerError,
} from "@/lib/google-ads";

const BASE = "https://api.dataforseo.com/v3";

// DataForSEO Google Ads endpoints use Google's own country geo-target ids as
// `location_code` — the same numbers as google-ads.ts GEO_TARGET_CONSTANTS.
const LOCATION_CODES: Record<string, number> = {
  ES: 2724, MX: 2484, AR: 2032, CO: 2170, CL: 2152, PE: 2604,
  US: 2840, GB: 2826, FR: 2250, DE: 2276, IT: 2380, PT: 2620,
  NL: 2528, CA: 2124, AU: 2036, BR: 2076,
};

// Languages DataForSEO accepts as ISO `language_code` for Google Ads data.
const LANGUAGE_CODES = new Set(["en", "es", "fr", "de", "it", "pt", "nl"]);

interface CostContext {
  userId?: string | null;
  brandId?: string | null;
  workspaceId?: string | null;
  runId?: string | null;
  stepId?: string | null;
}

function creds(): { login: string; password: string } | null {
  const login =
    process.env.DATAFORSEO_LOGIN?.trim() || process.env.DATAFORSEO_USER?.trim();
  const password =
    process.env.DATAFORSEO_PASSWORD?.trim() ||
    process.env.DATAFORSEO_PASS?.trim();
  if (!login || !password) return null;
  return { login, password };
}

/** True when DataForSEO credentials are present (i.e. the fallback can run). */
export function dataForSeoConfigured(): boolean {
  return creds() !== null;
}

function authHeader(c: { login: string; password: string }): string {
  return "Basic " + Buffer.from(`${c.login}:${c.password}`).toString("base64");
}

function locationCode(countryCodes: string[]): number {
  for (const c of countryCodes) {
    const hit = LOCATION_CODES[(c ?? "").toUpperCase()];
    if (hit) return hit;
  }
  return LOCATION_CODES.ES;
}

function languageCode(code: string | undefined): string {
  const v = (code ?? "").toLowerCase();
  return LANGUAGE_CODES.has(v) ? v : "en";
}

function competitionFrom(raw: unknown): KeywordPlanIdea["competition"] {
  const v = String(raw ?? "").toUpperCase();
  if (v === "LOW" || v === "MEDIUM" || v === "HIGH") return v;
  return "UNSPECIFIED";
}

// Bids/CPC come back in whole currency units (USD on the DataForSEO side); the
// app speaks micros everywhere, so scale up. Null/0 → undefined (no signal).
function toMicros(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1_000_000);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function hostnameOf(urlOrDomain: string): string {
  const s = urlOrDomain.trim();
  try {
    return new URL(s.startsWith("http") ? s : `https://${s}`).hostname.replace(
      /^www\./,
      ""
    );
  } catch {
    return s.replace(/^www\./, "").replace(/\/.*$/, "");
  }
}

interface DfsEnvelope<T> {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: {
    status_code?: number;
    status_message?: string;
    result?: T[] | null;
  }[];
}

// One POST to a DataForSEO live endpoint. Body is the single task object (the
// API wants an ARRAY of tasks; we always send exactly one). Returns the first
// task's result rows + the real dollar cost, or a classified error — never throws.
async function dfsPost<T>(
  path: string,
  task: Record<string, unknown>
): Promise<{ rows: T[]; cost: number; error?: KeywordPlannerError }> {
  const c = creds();
  if (!c)
    return {
      rows: [],
      cost: 0,
      error: { kind: "access", message: "DataForSEO credentials are not configured." },
    };

  let json: DfsEnvelope<T>;
  let httpStatus: number | undefined;
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: authHeader(c),
        "Content-Type": "application/json",
      },
      body: JSON.stringify([task]),
      signal: AbortSignal.timeout(30000),
    });
    httpStatus = resp.status;
    json = (await resp.json()) as DfsEnvelope<T>;
  } catch (e) {
    return {
      rows: [],
      cost: 0,
      error: {
        kind: "network",
        message:
          e instanceof Error ? e.message : "DataForSEO request failed/timed out.",
      },
    };
  }

  // Top-level auth/billing problems surface as 401/402 or a non-20000 status.
  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403) {
    return {
      rows: [],
      cost: 0,
      error: {
        kind: "access",
        status: httpStatus,
        message: `DataForSEO access error (${httpStatus}): ${json?.status_message ?? "check credentials/balance"}.`,
      },
    };
  }
  const taskNode = json?.tasks?.[0];
  if (json?.status_code && json.status_code !== 20000 && !taskNode) {
    return {
      rows: [],
      cost: num(json.cost),
      error: {
        kind: "unknown",
        status: httpStatus,
        message: json.status_message || "DataForSEO request failed.",
      },
    };
  }
  if (taskNode && taskNode.status_code && taskNode.status_code !== 20000) {
    // 40402-ish = rate/limit/quota; everything else = generic failure.
    const quota =
      taskNode.status_code === 40402 ||
      /limit|exceed|quota|money|balance/i.test(taskNode.status_message ?? "");
    return {
      rows: [],
      cost: num(json.cost),
      error: {
        kind: quota ? "quota" : "unknown",
        status: httpStatus,
        message: taskNode.status_message || "DataForSEO task failed.",
      },
    };
  }

  return { rows: (taskNode?.result ?? []) as T[], cost: num(json?.cost) };
}

function meter(
  resource: string,
  units: number,
  costDollars: number,
  cc: CostContext | undefined,
  meta: Record<string, unknown>
): void {
  void recordCost({
    category: "external_api",
    provider: "dataforseo",
    resource,
    units,
    costMicros: Math.round(Math.max(0, costDollars) * 1_000_000),
    userId: cc?.userId ?? null,
    brandId: cc?.brandId ?? null,
    workspaceId: cc?.workspaceId ?? null,
    runId: cc?.runId ?? null,
    stepId: cc?.stepId ?? null,
    meta,
  });
}

// ---------------------------------------------------------------------------
// Keyword ideas — the generateKeywordIdeas substitute.
//
//   urlSeed present  → keywords_for_site  (a domain's keyword footprint)
//   else keywordSeeds → keywords_for_keywords (ideas around the seed terms)
//
// Returns the same KeywordPlanIdea[] shape google-ads.ts produces, plus an `ok`
// flag and (on failure) a classified error so the caller can decide whether to
// suppress Google's own onError.
// ---------------------------------------------------------------------------
interface DfsKeywordRow {
  keyword?: string;
  search_volume?: number | null;
  competition?: string | null;
  competition_index?: number | null;
  low_top_of_page_bid?: number | null;
  high_top_of_page_bid?: number | null;
  cpc?: number | null;
}

export async function dataForSeoKeywordIdeas(params: {
  keywordSeeds?: string[];
  urlSeed?: string;
  languageCode: string;
  countryCodes: string[];
  costContext?: CostContext;
}): Promise<{ ideas: KeywordPlanIdea[]; ok: boolean; error?: KeywordPlannerError }> {
  if (!dataForSeoConfigured())
    return {
      ideas: [],
      ok: false,
      error: { kind: "access", message: "DataForSEO not configured." },
    };

  const seeds = (params.keywordSeeds ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  const url = params.urlSeed?.trim();

  const base = {
    location_code: locationCode(params.countryCodes),
    language_code: languageCode(params.languageCode),
    sort_by: "search_volume",
    include_adult_keywords: false,
    limit: 300,
  };

  let path: string;
  let task: Record<string, unknown>;
  if (url) {
    path = "/keywords_data/google_ads/keywords_for_site/live";
    task = { ...base, target: hostnameOf(url) };
  } else if (seeds.length) {
    path = "/keywords_data/google_ads/keywords_for_keywords/live";
    task = { ...base, keywords: seeds };
  } else {
    return { ideas: [], ok: true };
  }

  const { rows, cost, error } = await dfsPost<DfsKeywordRow>(path, task);
  meter(path.includes("keywords_for_site") ? "keywords_for_site" : "keywords_for_keywords", rows.length, cost, params.costContext, {
    module: "keyword_data",
    seeds: seeds.length,
    hasUrl: Boolean(url),
    languageCode: params.languageCode,
    countries: params.countryCodes,
    outcome: error ? error.kind : "ok",
  });

  if (error) return { ideas: [], ok: false, error };

  const ideas: KeywordPlanIdea[] = rows
    .filter((r) => Boolean(r.keyword))
    .map((r) => ({
      text: String(r.keyword),
      avgMonthlySearches: num(r.search_volume),
      competition: competitionFrom(r.competition),
      topOfPageBidLowMicros: toMicros(r.low_top_of_page_bid),
      topOfPageBidHighMicros: toMicros(r.high_top_of_page_bid),
    }));

  return { ideas, ok: true };
}

// ---------------------------------------------------------------------------
// Forecast — the generateKeywordForecast substitute (ad_traffic_by_keywords).
//
// DataForSEO returns per-keyword impressions/clicks/ctr/avg_cpc/cost for the
// next month at the given max-CPC bid. We aggregate to a single campaign-level
// projection matching KeywordForecast. DataForSEO does NOT model conversions, so
// — exactly like Google's "estimated conversions" when there's no account
// conversion tracking — we apply a conservative typical Search CVR and label it
// directional in the basis string upstream.
// ---------------------------------------------------------------------------
interface DfsTrafficRow {
  keyword?: string;
  search_volume?: number | null;
  impressions?: number | null;
  ctr?: number | null;
  average_cpc?: number | null;
  clicks?: number | null;
  cost?: number | null;
}

// Typical Google Search conversion rate used only to derive a DIRECTIONAL
// conversions estimate (DataForSEO doesn't forecast conversions). Kept
// deliberately conservative; surfaced as an estimate, never as a promise.
const ASSUMED_CVR = 0.03;

export async function dataForSeoForecast(params: {
  keywords: { text: string; matchType?: "BROAD" | "PHRASE" | "EXACT" }[];
  languageCode: string;
  countryCodes: string[];
  maxCpcMicros?: number;
  currencyCode?: string;
  costContext?: CostContext;
}): Promise<KeywordForecast | null> {
  if (!dataForSeoConfigured()) return null;

  const keywords = params.keywords
    .map((k) => k.text?.trim())
    .filter((t): t is string => Boolean(t))
    .slice(0, 1000);
  if (keywords.length === 0) return null;

  const match = (params.keywords[0]?.matchType ?? "PHRASE").toLowerCase(); // exact|phrase|broad
  const bid = Math.max((params.maxCpcMicros ?? 1_500_000) / 1_000_000, 0.01);

  const { rows, cost, error } = await dfsPost<DfsTrafficRow>(
    "/keywords_data/google_ads/ad_traffic_by_keywords/live",
    {
      keywords,
      location_code: locationCode(params.countryCodes),
      language_code: languageCode(params.languageCode),
      bid,
      match,
      date_interval: "next_month",
    }
  );
  meter("ad_traffic_by_keywords", keywords.length, cost, params.costContext, {
    module: "keyword_data",
    keywords: keywords.length,
    languageCode: params.languageCode,
    countries: params.countryCodes,
    bid,
    match,
    outcome: error ? error.kind : "ok",
  });
  if (error || rows.length === 0) return null;

  let impressions = 0;
  let clicks = 0;
  let costTotal = 0;
  for (const r of rows) {
    impressions += num(r.impressions);
    clicks += num(r.clicks);
    costTotal += num(r.cost);
  }
  if (impressions <= 0 && clicks <= 0) return null;

  const costMicros = Math.round(costTotal * 1_000_000);
  const avgCpcMicros = clicks > 0 ? Math.round(costMicros / clicks) : 0;
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const conversions = clicks * ASSUMED_CVR;
  const conversionRate = ASSUMED_CVR;
  const cpaMicros = conversions > 0 ? Math.round(costMicros / conversions) : 0;

  return {
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    ctr,
    avgCpcMicros,
    costMicros,
    conversions: Math.round(conversions),
    conversionRate,
    cpaMicros,
    periodDays: 30,
    currencyCode: params.currencyCode ?? "USD",
    keywordCount: keywords.length,
  };
}
