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
// ============================================================================

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
