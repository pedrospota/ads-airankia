// Direct Google Ads REST API client — no MCP dependency

import { recordCost } from "@/lib/cost-ledger";

const CUSTOMER_ID = process.env.GOOGLE_ADS_ACCOUNT_ID || "3531706003";
const MCC_ID = process.env.GOOGLE_ADS_MCC_ID || "9539861409";
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET!;
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN!;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN!;

let cachedAccessToken: { token: string; expires: number } | null = null;

// Node's fetch has NO default timeout: a slow/unreachable Google endpoint would
// hang the request indefinitely. Inside the Search pipeline that means the whole
// step blows past the reverse-proxy limit (Cloudflare ~100s) and the user gets a
// generic gateway error. fetchWithTimeout bounds every Google Ads call so a slow
// dependency fails fast instead of hanging the run.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 20000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expires) {
    return cachedAccessToken.token;
  }

  const resp = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  }, 15000);

  if (!resp.ok) throw new Error(`OAuth token refresh failed: ${resp.status}`);
  const data = await resp.json();

  cachedAccessToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
}

function headers(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "developer-token": DEVELOPER_TOKEN,
    "login-customer-id": MCC_ID,
    "Content-Type": "application/json",
  };
}

const BASE = `https://googleads.googleapis.com/v19/customers/${CUSTOMER_ID}`;

// ---------------------------------------------------------------------------
// Keyword Planner credential (OPTIONAL, planner-ONLY).
//
// generateKeywordIdeas + generateKeywordForecast may use a SEPARATE Google Ads
// credential dedicated to the Keyword Planner (KeywordPlanIdeaService) — e.g. a
// developer token that has Basic access while the main account's token is still
// on Test access (Test access can't query the planner). BY DESIGN this
// credential is used ONLY for keyword planning / forecasting and is NEVER used
// for campaign creation or any account mutation — every create/update/status
// function above keeps using the main AI Rankia account creds. When the
// GOOGLE_ADS_PLANNER_* vars are unset, these fall back to the main creds so
// behaviour is identical to before.
// ---------------------------------------------------------------------------
const PLANNER_CLIENT_ID = process.env.GOOGLE_ADS_PLANNER_CLIENT_ID || CLIENT_ID;
const PLANNER_CLIENT_SECRET = process.env.GOOGLE_ADS_PLANNER_CLIENT_SECRET || CLIENT_SECRET;
const PLANNER_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_PLANNER_DEVELOPER_TOKEN || DEVELOPER_TOKEN;
const PLANNER_REFRESH_TOKEN = process.env.GOOGLE_ADS_PLANNER_REFRESH_TOKEN || REFRESH_TOKEN;
const PLANNER_LOGIN_CUSTOMER_ID = process.env.GOOGLE_ADS_PLANNER_LOGIN_CUSTOMER_ID || MCC_ID;
const PLANNER_CUSTOMER_ID = process.env.GOOGLE_ADS_PLANNER_CUSTOMER_ID || CUSTOMER_ID;

/** True when a DISTINCT planner credential (separate dev token + refresh token) is configured. */
export const PLANNER_CREDENTIAL_CONFIGURED = Boolean(
  process.env.GOOGLE_ADS_PLANNER_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_PLANNER_REFRESH_TOKEN
);

let cachedPlannerToken: { token: string; expires: number } | null = null;

// Mint (and cache) an access token for the planner credential. When the planner
// refresh token/client match the main creds we just reuse getAccessToken() so
// there's a single OAuth refresh + cache.
async function getPlannerAccessToken(): Promise<string> {
  if (
    PLANNER_REFRESH_TOKEN === REFRESH_TOKEN &&
    PLANNER_CLIENT_ID === CLIENT_ID &&
    PLANNER_CLIENT_SECRET === CLIENT_SECRET
  ) {
    return getAccessToken();
  }
  if (cachedPlannerToken && Date.now() < cachedPlannerToken.expires) {
    return cachedPlannerToken.token;
  }
  const resp = await fetchWithTimeout(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: PLANNER_CLIENT_ID,
        client_secret: PLANNER_CLIENT_SECRET,
        refresh_token: PLANNER_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    },
    15000
  );
  if (!resp.ok) throw new Error(`Planner OAuth token refresh failed: ${resp.status}`);
  const data = await resp.json();
  cachedPlannerToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

function plannerHeaders(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "developer-token": PLANNER_DEVELOPER_TOKEN,
    "login-customer-id": PLANNER_LOGIN_CUSTOMER_ID,
    "Content-Type": "application/json",
  };
}

const PLANNER_BASE = `https://googleads.googleapis.com/v19/customers/${PLANNER_CUSTOMER_ID}`;

// Create a campaign budget
export async function createBudget(name: string, dailyAmountMicros: number): Promise<string> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/campaignBudgets:mutate`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operations: [{
        create: {
          name,
          amountMicros: String(Math.max(dailyAmountMicros, 1000000)), // min $1
          deliveryMethod: "STANDARD",
        },
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.results[0].resourceName; // customers/XXX/campaignBudgets/YYY
}

// Create a Display campaign (always PAUSED)
export async function createCampaign(name: string, budgetResourceName: string): Promise<{ resourceName: string; id: string }> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/campaigns:mutate`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operations: [{
        create: {
          name,
          status: "PAUSED",
          advertisingChannelType: "DISPLAY",
          campaignBudget: budgetResourceName,
          manualCpc: {},
          networkSettings: {
            targetContentNetwork: true,
            targetGoogleSearch: false,
            targetSearchNetwork: false,
          },
        },
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  const rn = data.results[0].resourceName;
  const id = rn.split("/").pop()!;
  return { resourceName: rn, id };
}

// Create a DISPLAY_STANDARD ad group
export async function createAdGroup(campaignId: string, name: string): Promise<{ resourceName: string; id: string }> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/adGroups:mutate`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operations: [{
        create: {
          name,
          campaign: `customers/${CUSTOMER_ID}/campaigns/${campaignId}`,
          type: "DISPLAY_STANDARD",
          status: "ENABLED",
          cpcBidMicros: "100000", // $0.10 default CPC
        },
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  const rn = data.results[0].resourceName;
  const id = rn.split("/").pop()!;
  return { resourceName: rn, id };
}

// Add managed placements (domains) to an ad group
export async function addPlacements(adGroupId: string, domains: string[]): Promise<{ success: string[]; failed: string[] }> {
  const token = await getAccessToken();
  const uniqueDomains = [...new Set(domains)];
  const success: string[] = [];
  const failed: string[] = [];

  // Batch in groups of 10 to avoid API limits
  for (let i = 0; i < uniqueDomains.length; i += 10) {
    const batch = uniqueDomains.slice(i, i + 10);
    const operations = batch.map((url) => ({
      create: {
        adGroup: `customers/${CUSTOMER_ID}/adGroups/${adGroupId}`,
        status: "ENABLED",
        placement: { url },
      },
    }));

    try {
      const resp = await fetch(`${BASE}/adGroupCriteria:mutate`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({
          operations,
          partialFailure: true,
        }),
      });

      const data = await resp.json();
      if (data.error) {
        failed.push(...batch);
      } else {
        // Check partial failures
        if (data.partialFailureError) {
          // Some succeeded, some failed
          batch.forEach((d, idx) => {
            const result = data.results?.[idx];
            if (result?.resourceName) success.push(d);
            else failed.push(d);
          });
        } else {
          success.push(...batch);
        }
      }
    } catch {
      failed.push(...batch);
    }
  }

  return { success, failed };
}

// Pause, enable, or remove a campaign. REMOVED is a soft-delete in Google Ads:
// the campaign is taken down (it can never spend again) but stays queryable.
export async function setCampaignStatus(campaignId: string, status: "PAUSED" | "ENABLED" | "REMOVED"): Promise<void> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/campaigns:mutate`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operations: [{
        update: {
          resourceName: `customers/${CUSTOMER_ID}/campaigns/${campaignId}`,
          status,
        },
        updateMask: "status",
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
}

// Update daily budget
export async function updateBudget(budgetId: string, dailyAmountMicros: number): Promise<void> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/campaignBudgets:mutate`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operations: [{
        update: {
          resourceName: `customers/${CUSTOMER_ID}/campaignBudgets/${budgetId}`,
          amountMicros: String(Math.max(dailyAmountMicros, 1000000)),
        },
        updateMask: "amountMicros",
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
}

// ---------------------------------------------------------------------------
// Keyword Plan Ideas — real search metrics for A2 (KeywordPlanIdeaService).
// Returns one entry per idea with monthly searches + competition + bid range.
// Returns [] (never throws to the caller's pipeline) when the API can't serve
// metrics; the agent falls back to LLM estimates in that case.
// ---------------------------------------------------------------------------

export interface KeywordPlanIdea {
  text: string;
  avgMonthlySearches: number;
  competition: "LOW" | "MEDIUM" | "HIGH" | "UNSPECIFIED" | "UNKNOWN";
  topOfPageBidLowMicros?: number;
  topOfPageBidHighMicros?: number;
}

// ISO-3166 alpha-2 -> Google Ads geoTargetConstant id (country level).
// Covers the Spanish-speaking + main markets we target; defaults to Spain.
const GEO_TARGET_CONSTANTS: Record<string, string> = {
  ES: "2724", // Spain
  MX: "2484", // Mexico
  AR: "2032", // Argentina
  CO: "2170", // Colombia
  CL: "2152", // Chile
  PE: "2604", // Peru
  US: "2840", // United States
  GB: "2826", // United Kingdom
  FR: "2250", // France
  DE: "2276", // Germany
  IT: "2380", // Italy
  PT: "2620", // Portugal
};

// ISO language code -> Google Ads languageConstant id.
const LANGUAGE_CONSTANTS: Record<string, string> = {
  es: "1003", // Spanish
  en: "1000", // English
  fr: "1002", // French
  de: "1001", // German
  it: "1004", // Italian
  pt: "1014", // Portuguese
};

function competitionFrom(raw: unknown): KeywordPlanIdea["competition"] {
  const v = String(raw ?? "UNSPECIFIED").toUpperCase();
  if (v === "LOW" || v === "MEDIUM" || v === "HIGH" || v === "UNKNOWN") return v;
  return "UNSPECIFIED";
}

// Why a Keyword Planner call returned no data. Surfaced via the optional onError
// callback so callers (e.g. the benchmark) can tell "API access pending" apart
// from "genuinely no data", instead of silently rendering zeros.
export interface KeywordPlannerError {
  kind: "access" | "quota" | "network" | "unknown";
  status?: number;
  message: string;
}

function classifyAdsError(
  status: number | undefined,
  body: unknown
): KeywordPlannerError {
  let text = "";
  try {
    text = JSON.stringify(body).toUpperCase();
  } catch {
    text = String(body).toUpperCase();
  }
  if (
    status === 403 ||
    text.includes("DEVELOPER_TOKEN_NOT_APPROVED") ||
    text.includes("EXPLORER ACCESS") ||
    text.includes("NOT ALLOWED FOR USE WITH") ||
    text.includes("PERMISSION_DENIED")
  ) {
    return {
      kind: "access",
      status,
      message:
        "Google Ads API access pending: the developer token has Test access, which can't query the Keyword Planner. Basic access is required for real search volumes.",
    };
  }
  if (status === 429 || text.includes("RESOURCE_EXHAUSTED")) {
    return {
      kind: "quota",
      status,
      message: "Google Ads API daily quota reached — real keyword data will be available again after the quota resets.",
    };
  }
  return {
    kind: "unknown",
    status,
    message: "The Google Ads Keyword Planner request failed.",
  };
}

export async function generateKeywordIdeas(params: {
  keywordSeeds?: string[];
  urlSeed?: string;
  languageCode: string;
  countryCodes: string[];
  // Optional run linkage so the API usage shows up per-user in the cost ledger.
  costContext?: {
    userId?: string | null;
    brandId?: string | null;
    workspaceId?: string | null;
    runId?: string | null;
    stepId?: string | null;
  };
  // Called (once) when the planner can't serve metrics, so the caller can
  // distinguish an API-access gap from a genuinely empty result.
  onError?: (e: KeywordPlannerError) => void;
}): Promise<KeywordPlanIdea[]> {
  const seeds = (params.keywordSeeds ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20); // KeywordPlanIdeaService caps keyword seeds at 20
  const url = params.urlSeed?.trim() || undefined;
  if (seeds.length === 0 && !url) return [];

  // Keyword Planner uses the planner-only credential (falls back to the main
  // creds when no separate planner credential is configured). Never used for
  // campaign writes.
  let token: string;
  try {
    token = await getPlannerAccessToken();
  } catch (e) {
    params.onError?.({
      kind: "network",
      message: e instanceof Error ? e.message : "Could not authenticate the Keyword Planner credential.",
    });
    return [];
  }

  const language = `languageConstants/${
    LANGUAGE_CONSTANTS[params.languageCode?.toLowerCase()] ?? LANGUAGE_CONSTANTS.es
  }`;
  const geoTargetConstants = (params.countryCodes.length > 0 ? params.countryCodes : ["ES"])
    .map((c) => GEO_TARGET_CONSTANTS[c?.toUpperCase()])
    .filter((id): id is string => Boolean(id))
    .map((id) => `geoTargetConstants/${id}`);
  if (geoTargetConstants.length === 0) {
    geoTargetConstants.push(`geoTargetConstants/${GEO_TARGET_CONSTANTS.ES}`);
  }

  const body: Record<string, unknown> = {
    language,
    geoTargetConstants,
    includeAdultKeywords: false,
    keywordPlanNetwork: "GOOGLE_SEARCH",
    pageSize: 1000,
  };
  // Seed selection: keyword + url > keyword only > url only.
  if (seeds.length > 0 && url) {
    body.keywordAndUrlSeed = { url, keywords: seeds };
  } else if (seeds.length > 0) {
    body.keywordSeed = { keywords: seeds };
  } else if (url) {
    body.urlSeed = { url };
  }

  let data: {
    error?: unknown;
    results?: {
      text?: string;
      keywordIdeaMetrics?: {
        avgMonthlySearches?: string | number;
        competition?: string;
        lowTopOfPageBidMicros?: string | number;
        highTopOfPageBidMicros?: string | number;
      };
    }[];
  };
  let httpStatus: number | undefined;
  try {
    const resp = await fetchWithTimeout(`${PLANNER_BASE}:generateKeywordIdeas`, {
      method: "POST",
      headers: plannerHeaders(token),
      body: JSON.stringify(body),
    }, 20000);
    httpStatus = resp.status;
    data = await resp.json();
  } catch (e) {
    params.onError?.({
      kind: "network",
      message: e instanceof Error ? e.message : "The Keyword Planner request timed out.",
    });
    return [];
  }

  if (data.error || !Array.isArray(data.results)) {
    params.onError?.(classifyAdsError(httpStatus, data.error ?? data));
    return [];
  }

  const ideas = data.results
    .filter((r): r is { text: string; keywordIdeaMetrics?: NonNullable<typeof r.keywordIdeaMetrics> } =>
      Boolean(r.text)
    )
    .map((r) => {
      const m = r.keywordIdeaMetrics;
      const low = m?.lowTopOfPageBidMicros;
      const high = m?.highTopOfPageBidMicros;
      return {
        text: r.text,
        avgMonthlySearches: Number(m?.avgMonthlySearches ?? 0),
        competition: competitionFrom(m?.competition),
        topOfPageBidLowMicros: low !== undefined ? Number(low) : undefined,
        topOfPageBidHighMicros: high !== undefined ? Number(high) : undefined,
      };
    });

  // Meter the external API call (KeywordPlanIdeaService is free → costMicros 0;
  // we still record the call volume for per-day/per-user observability).
  // Fire-and-forget: never delays or fails the keyword fetch.
  const cc = params.costContext;
  void recordCost({
    category: "external_api",
    provider: "google_ads",
    resource: "generateKeywordIdeas",
    units: ideas.length,
    costMicros: 0,
    userId: cc?.userId ?? null,
    brandId: cc?.brandId ?? null,
    workspaceId: cc?.workspaceId ?? null,
    runId: cc?.runId ?? null,
    stepId: cc?.stepId ?? null,
    meta: {
      seeds: seeds.length,
      hasUrl: Boolean(url),
      languageCode: params.languageCode,
      countries: params.countryCodes,
    },
  });

  return ideas;
}

// ---------------------------------------------------------------------------
// Account currency — resolve the real currency of the Google Ads account so we
// stop hardcoding "€" across the app. Cached for 6h (it never changes in
// practice). Falls back to EUR (our default account) on any error so callers
// always get a usable code. See currencySymbol() for display.
// ---------------------------------------------------------------------------

let cachedCurrency: { code: string; expires: number } | null = null;

// ISO-4217 currency code -> display symbol. Unknown codes render as the code
// itself (e.g. "PLN ") so we never show a wrong symbol.
export function currencySymbol(code: string | null | undefined): string {
  switch ((code ?? "").toUpperCase()) {
    case "EUR":
      return "€";
    case "USD":
    case "MXN":
    case "ARS":
    case "CLP":
    case "COP":
    case "AUD":
    case "CAD":
      return "$";
    case "GBP":
      return "£";
    case "JPY":
      return "¥";
    case "BRL":
      return "R$";
    default:
      return code ? `${code} ` : "€";
  }
}

export async function getAccountCurrency(): Promise<string> {
  if (cachedCurrency && Date.now() < cachedCurrency.expires) {
    return cachedCurrency.code;
  }
  try {
    const token = await getAccessToken();
    const resp = await fetchWithTimeout(
      `${BASE}/googleAds:searchStream`,
      {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({
          query: "SELECT customer.currency_code FROM customer LIMIT 1",
        }),
      },
      15000
    );
    const data = await resp.json();
    // searchStream returns an array of batches, each with `.results`.
    const code = Array.isArray(data)
      ? data[0]?.results?.[0]?.customer?.currencyCode
      : data?.results?.[0]?.customer?.currencyCode;
    if (typeof code === "string" && code) {
      cachedCurrency = { code, expires: Date.now() + 6 * 60 * 60 * 1000 };
      return code;
    }
  } catch {
    /* fall through to default */
  }
  return "EUR";
}

// ---------------------------------------------------------------------------
// Keyword Plan Forecast — GenerateKeywordForecastMetrics (KeywordPlanIdeaService).
// Given a set of keywords, returns Google's own traffic forecast: impressions,
// clicks, CTR, average CPC, cost and (estimated) conversions for a 30-day window.
// This is what lets every RECOMMENDATION carry real numbers ("if you run these
// keywords you'd get ~X clicks at ~€Y") instead of guesses.
//
// Honesty notes (per "que sí haga sentido"):
//   • impressions / clicks / CTR / avgCPC / cost are forecast directly by Google
//     → reliable.
//   • We OMIT conversionRate so Google supplies an *estimated* conversion rate
//     (no account conversion tracking to calibrate against), so conversions /
//     conversionRate / CPA are lower-confidence — callers should label them as
//     estimates assuming a typical conversion rate.
//
// Like generateKeywordIdeas, this NEVER throws to the pipeline: returns null
// when the API can't serve a forecast, so the UI just hides the projection.
// ---------------------------------------------------------------------------

export interface KeywordForecast {
  impressions: number;
  clicks: number;
  ctr: number; // fraction 0..1 (clickThroughRate)
  avgCpcMicros: number;
  costMicros: number;
  conversions: number;
  conversionRate: number; // fraction 0..1
  cpaMicros: number;
  periodDays: number; // length of the forecast window (≈30 → monthly)
  currencyCode: string; // currency the micros are expressed in
  keywordCount: number; // how many keywords were forecast
}

export async function generateKeywordForecast(params: {
  keywords: { text: string; matchType?: "BROAD" | "PHRASE" | "EXACT" }[];
  languageCode: string;
  countryCodes: string[];
  // Manual-CPC bid the forecast bids with. Ground it in real KP CPC when known;
  // defaults to €1.50 so the call still works without CPC data.
  maxCpcMicros?: number;
  // Account currency (resolve once via getAccountCurrency and pass it). When
  // omitted the API defaults to the account currency anyway.
  currencyCode?: string;
  costContext?: {
    userId?: string | null;
    brandId?: string | null;
    workspaceId?: string | null;
    runId?: string | null;
    stepId?: string | null;
  };
  onError?: (e: KeywordPlannerError) => void;
}): Promise<KeywordForecast | null> {
  const kws = params.keywords
    .map((k) => ({
      text: k.text?.trim() ?? "",
      matchType: k.matchType ?? "PHRASE",
    }))
    .filter((k) => Boolean(k.text))
    .slice(0, 1000); // defensive cap
  if (kws.length === 0) return null;

  const language = `languageConstants/${
    LANGUAGE_CONSTANTS[params.languageCode?.toLowerCase()] ?? LANGUAGE_CONSTANTS.es
  }`;
  const geoModifiers = (params.countryCodes.length > 0 ? params.countryCodes : ["ES"])
    .map((c) => GEO_TARGET_CONSTANTS[c?.toUpperCase()])
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ geoTargetConstant: `geoTargetConstants/${id}` }));
  if (geoModifiers.length === 0) {
    geoModifiers.push({
      geoTargetConstant: `geoTargetConstants/${GEO_TARGET_CONSTANTS.ES}`,
    });
  }

  const maxCpcMicros = Math.max(
    Math.round(params.maxCpcMicros ?? 1_500_000),
    10_000
  );

  // 30-day window starting tomorrow (start must be in the future, end within a
  // year). Metrics for impressions/clicks/cost/conversions scale with this
  // window → a 30-day window yields ~monthly figures.
  const periodDays = 30;
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const startDate = fmt(new Date(Date.now() + 86_400_000));
  const endDate = fmt(new Date(Date.now() + (periodDays + 1) * 86_400_000));

  const body: Record<string, unknown> = {
    forecastPeriod: { startDate, endDate },
    campaign: {
      keywordPlanNetwork: "GOOGLE_SEARCH",
      languageConstants: [language],
      geoModifiers,
      biddingStrategy: {
        manualCpcBiddingStrategy: { maxCpcBidMicros: String(maxCpcMicros) },
      },
      // conversionRate intentionally omitted → Google supplies an estimate.
      adGroups: [
        {
          biddableKeywords: kws.map((k) => ({
            keyword: { text: k.text, matchType: k.matchType },
          })),
        },
      ],
    },
  };
  if (params.currencyCode) body.currencyCode = params.currencyCode;

  let data: {
    error?: unknown;
    campaignForecastMetrics?: {
      impressions?: string | number;
      clickThroughRate?: string | number;
      averageCpcMicros?: string | number;
      clicks?: string | number;
      costMicros?: string | number;
      conversions?: string | number;
      conversionRate?: string | number;
      averageCpaMicros?: string | number;
    };
  };
  let httpStatus: number | undefined;
  try {
    const token = await getPlannerAccessToken();
    const resp = await fetchWithTimeout(
      `${PLANNER_BASE}:generateKeywordForecastMetrics`,
      {
        method: "POST",
        headers: plannerHeaders(token),
        body: JSON.stringify(body),
      },
      20000
    );
    httpStatus = resp.status;
    data = await resp.json();
  } catch (e) {
    params.onError?.({
      kind: "network",
      message: e instanceof Error ? e.message : "The Keyword Planner forecast request timed out.",
    });
    return null;
  }
  if (!data || data.error || !data.campaignForecastMetrics) {
    params.onError?.(classifyAdsError(httpStatus, data?.error ?? data));
    return null;
  }

  const m = data.campaignForecastMetrics;
  const currencyCode = params.currencyCode ?? (await getAccountCurrency());
  const forecast: KeywordForecast = {
    impressions: Number(m.impressions ?? 0),
    clicks: Number(m.clicks ?? 0),
    ctr: Number(m.clickThroughRate ?? 0),
    avgCpcMicros: Number(m.averageCpcMicros ?? 0),
    costMicros: Number(m.costMicros ?? 0),
    conversions: Number(m.conversions ?? 0),
    conversionRate: Number(m.conversionRate ?? 0),
    cpaMicros: Number(m.averageCpaMicros ?? 0),
    periodDays,
    currencyCode,
    keywordCount: kws.length,
  };

  // Meter the call (free, like generateKeywordIdeas → costMicros 0). Fire-and-forget.
  const cc = params.costContext;
  void recordCost({
    category: "external_api",
    provider: "google_ads",
    resource: "generateKeywordForecastMetrics",
    units: kws.length,
    costMicros: 0,
    userId: cc?.userId ?? null,
    brandId: cc?.brandId ?? null,
    workspaceId: cc?.workspaceId ?? null,
    runId: cc?.runId ?? null,
    stepId: cc?.stepId ?? null,
    meta: {
      keywords: kws.length,
      languageCode: params.languageCode,
      countries: params.countryCodes,
      maxCpcMicros,
      periodDays,
    },
  });

  return forecast;
}

// Get campaign performance
export async function getCampaignPerformance(campaignId: string): Promise<{
  impressions: number; clicks: number; costMicros: number; status: string;
}> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/googleAds:searchStream`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      query: `SELECT campaign.id, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE campaign.id = ${campaignId}`,
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  const row = data[0]?.results?.[0];
  return {
    impressions: Number(row?.metrics?.impressions || 0),
    clicks: Number(row?.metrics?.clicks || 0),
    costMicros: Number(row?.metrics?.costMicros || 0),
    status: row?.campaign?.status || "UNKNOWN",
  };
}
