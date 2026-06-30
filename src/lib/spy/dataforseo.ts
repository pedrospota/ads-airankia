// ============================================================================
// DataForSEO Labs client — competitor PAID (Google Ads) intelligence.
//
// Powers the "Keyword & Spend Spy" tool: estimated monthly ad spend per domain
// + the actual paid keywords a domain bids on (+ keyword gap vs the brand).
//
// Auth: HTTP Basic base64(login:password) → DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD.
// Endpoints (verified live):
//   POST /v3/dataforseo_labs/google/domain_rank_overview/live
//        → result[0].items[0].metrics.paid.{estimated_paid_traffic_cost, count, etv, pos_*}
//   POST /v3/dataforseo_labs/google/ranked_keywords/live  (item_types:["paid"])
//        → result[0].total_count + items[].{keyword_data.keyword(_info), ranked_serp_element.serp_item}
//
// Values are DataForSEO model estimates — present as directional. Never throws.
// ============================================================================

const BASE = "https://api.dataforseo.com/v3";

function creds(): string | null {
  const login = process.env.DATAFORSEO_LOGIN?.trim();
  const password = process.env.DATAFORSEO_PASSWORD?.trim();
  if (!login || !password) return null;
  return Buffer.from(`${login}:${password}`).toString("base64");
}

export function dataForSeoConfigured(): boolean {
  return creds() !== null;
}

async function post(path: string, task: Record<string, unknown>): Promise<{ result: unknown; cost: number; error: string | null }> {
  const auth = creds();
  if (!auth) return { result: null, cost: 0, error: "DataForSEO credentials are not set." };
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify([task]),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) return { result: null, cost: 0, error: `DataForSEO HTTP ${resp.status}` };
    const j = (await resp.json()) as {
      cost?: number;
      tasks?: { status_message?: string; result?: unknown[] }[];
    };
    const t = j?.tasks?.[0];
    const result = t?.result?.[0] ?? null;
    return { result, cost: j?.cost ?? 0, error: null };
  } catch (e) {
    return { result: null, cost: 0, error: (e as Error)?.name === "TimeoutError" ? "DataForSEO timed out." : "DataForSEO request failed." };
  }
}

export interface DomainSpend {
  domain: string;
  /** Estimated monthly Google Ads spend in USD (directional). */
  estimatedMonthlySpend: number;
  /** Number of paid keywords the domain bids on. */
  paidKeywords: number;
  /** Estimated monthly paid traffic (clicks). */
  estimatedPaidTraffic: number;
  /** Paid position distribution. */
  positions: { top: number; pos2to3: number; pos4to10: number; lower: number };
}

export async function domainSpendOverview(
  domain: string,
  locationCode: number,
  languageCode: string
): Promise<{ data: DomainSpend | null; cost: number; error: string | null }> {
  const { result, cost, error } = await post("/dataforseo_labs/google/domain_rank_overview/live", {
    target: domain,
    location_code: locationCode,
    language_code: languageCode,
  });
  if (!result) return { data: null, cost, error: error ?? "No data for this domain." };
  const r = result as { items?: { metrics?: { paid?: Record<string, number | null> } }[] };
  const paid = r.items?.[0]?.metrics?.paid ?? null;
  if (!paid) {
    // Domain has no paid footprint in the index → a real, useful answer.
    return {
      data: { domain, estimatedMonthlySpend: 0, paidKeywords: 0, estimatedPaidTraffic: 0, positions: { top: 0, pos2to3: 0, pos4to10: 0, lower: 0 } },
      cost,
      error: null,
    };
  }
  const n = (v: number | null | undefined) => (typeof v === "number" ? v : 0);
  return {
    data: {
      domain,
      estimatedMonthlySpend: n(paid.estimated_paid_traffic_cost),
      paidKeywords: n(paid.count),
      estimatedPaidTraffic: n(paid.etv),
      positions: {
        top: n(paid.pos_1),
        pos2to3: n(paid.pos_2_3),
        pos4to10: n(paid.pos_4_10),
        lower: n(paid.pos_11_20) + n(paid.pos_21_30) + n(paid.pos_31_40) + n(paid.pos_41_50),
      },
    },
    cost,
    error: null,
  };
}

export interface PaidKeyword {
  keyword: string;
  volume: number;
  cpc: number | null;
  position: number | null;
  /** Estimated traffic value (clicks) for this keyword. */
  etv: number;
}

export async function domainPaidKeywords(
  domain: string,
  locationCode: number,
  languageCode: string,
  limit = 100
): Promise<{ data: PaidKeyword[]; total: number; cost: number; error: string | null }> {
  const { result, cost, error } = await post("/dataforseo_labs/google/ranked_keywords/live", {
    target: domain,
    location_code: locationCode,
    language_code: languageCode,
    item_types: ["paid"],
    limit: Math.max(1, Math.min(1000, limit)),
    order_by: ["ranked_serp_element.serp_item.etv,desc"],
  });
  if (!result) return { data: [], total: 0, cost, error: error ?? "No paid keywords for this domain." };
  const r = result as {
    total_count?: number;
    items?: {
      keyword_data?: { keyword?: string; keyword_info?: { search_volume?: number; cpc?: number | null } };
      ranked_serp_element?: { serp_item?: { rank_absolute?: number; etv?: number } };
    }[];
  };
  const data: PaidKeyword[] = (r.items ?? []).map((it) => ({
    keyword: it.keyword_data?.keyword ?? "",
    volume: it.keyword_data?.keyword_info?.search_volume ?? 0,
    cpc: it.keyword_data?.keyword_info?.cpc ?? null,
    position: it.ranked_serp_element?.serp_item?.rank_absolute ?? null,
    etv: it.ranked_serp_element?.serp_item?.etv ?? 0,
  })).filter((k) => k.keyword);
  return { data, total: r.total_count ?? data.length, cost, error: null };
}
