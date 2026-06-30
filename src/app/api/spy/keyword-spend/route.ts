import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { recordCost } from "@/lib/cost-ledger";
import { findCountry } from "@/lib/benchmark/countries";
import { toDomain } from "@/lib/benchmark/page-fetch";
import {
  dataForSeoConfigured,
  domainSpendOverview,
  domainPaidKeywords,
  type PaidKeyword,
  type DomainSpend,
} from "@/lib/spy/dataforseo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const normKw = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// Per-domain summary used in the you-vs-them comparison.
interface DomainMetrics {
  domain: string;
  monthlySpend: number;
  paidKeywords: number;
  clicks: number;
  avgCpc: number | null;
  avgPosition: number | null;
  positions: { top: number; pos2to3: number; pos4to10: number; lower: number };
}

// A keyword BOTH domains bid on — brand vs competitor side by side.
interface SharedKeyword {
  keyword: string;
  volume: number;
  theirCpc: number | null;
  theirPosition: number | null;
  theirEtv: number;
  yourCpc: number | null;
  yourPosition: number | null;
  yourEtv: number;
}

// Pure: derive a DomainMetrics from a domain's spend overview + its returned
// keyword list. avgCpc = mean cpc where cpc != null && > 0 (null if none);
// avgPosition = mean position where position != null, rounded to 1 dp (null if none).
function metricsFor(domain: string, overview: DomainSpend | null, kwList: PaidKeyword[]): DomainMetrics {
  const cpcs = kwList.map((k) => k.cpc).filter((c): c is number => c != null && c > 0);
  const poss = kwList.map((k) => k.position).filter((p): p is number => p != null);
  const avgCpc = cpcs.length ? Math.round((cpcs.reduce((a, b) => a + b, 0) / cpcs.length) * 100) / 100 : null;
  const avgPosition = poss.length ? Math.round((poss.reduce((a, b) => a + b, 0) / poss.length) * 10) / 10 : null;
  return {
    domain,
    monthlySpend: overview?.estimatedMonthlySpend ?? 0,
    paidKeywords: overview?.paidKeywords ?? 0,
    clicks: overview?.estimatedPaidTraffic ?? 0,
    avgCpc,
    avgPosition,
    positions: overview?.positions ?? { top: 0, pos2to3: 0, pos4to10: 0, lower: 0 },
  };
}

// POST /api/spy/keyword-spend
// Body: { domain, brandDomain?, countryCode? }
// Returns a competitor's estimated Google Ads spend + the paid keywords it bids
// on, and (when brandDomain is given) the full you-vs-them comparison + gap.
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to run this." }, { status: 401 });

  if (!dataForSeoConfigured()) {
    return NextResponse.json({ error: "DataForSEO is not configured on the server." }, { status: 503 });
  }

  let body: { domain?: string; brandDomain?: string; countryCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const domain = toDomain((body.domain ?? "").trim());
  if (!domain) return NextResponse.json({ error: "Enter a valid competitor domain (e.g. semrush.com)." }, { status: 400 });
  const brandDomain = body.brandDomain ? toDomain(body.brandDomain.trim()) : null;

  const country = findCountry(body.countryCode ?? null);
  const locationCode = parseInt(country.region, 10) || 2840;
  const languageCode = country.lang || "en";

  let totalCost = 0;
  const meter = (resource: string, cost: number) => {
    totalCost += cost;
    void recordCost({
      category: "external_api", provider: "dataforseo", resource,
      costMicros: Math.round(cost * 1_000_000),
      userId: user.id, brandId: null, workspaceId: null, runId: null,
      meta: { module: "spy", tool: "keyword_spend", domain },
    });
  };

  // Competitor: spend overview + its paid keywords (in parallel).
  const [overview, kw] = await Promise.all([
    domainSpendOverview(domain, locationCode, languageCode),
    domainPaidKeywords(domain, locationCode, languageCode, 100),
  ]);
  meter("domain_rank_overview", overview.cost);
  meter("ranked_keywords", kw.cost);

  if (overview.error && kw.error) {
    return NextResponse.json({ error: overview.error || kw.error }, { status: 502 });
  }

  // Optional you-vs-them comparison when the brand's own domain is provided.
  let brandSpend: DomainSpend | null = null;
  let comparison: { brand: DomainMetrics; competitor: DomainMetrics } | null = null;
  let gap: {
    brandDomain: string;
    steal: PaidKeyword[];     // competitor bids, brand does NOT → opportunity
    shared: SharedKeyword[];  // BOTH bid → brand vs competitor side by side
    defend: PaidKeyword[];    // brand bids, competitor does NOT → brand's own keywords
    defendCount: number;      // full count of defend keywords before the cap
  } | null = null;

  if (brandDomain && brandDomain !== domain) {
    // Brand: spend overview + its paid keywords (in parallel).
    const [brandOverview, brandKw] = await Promise.all([
      domainSpendOverview(brandDomain, locationCode, languageCode),
      domainPaidKeywords(brandDomain, locationCode, languageCode, 300),
    ]);
    meter("domain_rank_overview", brandOverview.cost);
    meter("ranked_keywords", brandKw.cost);

    brandSpend = brandOverview.data;
    comparison = {
      brand: metricsFor(brandDomain, brandOverview.data, brandKw.data),
      competitor: metricsFor(domain, overview.data, kw.data),
    };

    const compSet = new Set(kw.data.map((k) => normKw(k.keyword)));
    const brandByKw = new Map(brandKw.data.map((k) => [normKw(k.keyword), k] as const));

    // Competitor bids, brand does not → steal these.
    const steal = kw.data.filter((k) => !brandByKw.has(normKw(k.keyword)));
    // Both bid → pair competitor (their*) with the brand entry (your*).
    const shared: SharedKeyword[] = kw.data
      .filter((k) => brandByKw.has(normKw(k.keyword)))
      .map((k) => {
        const yours = brandByKw.get(normKw(k.keyword))!;
        return {
          keyword: k.keyword,
          volume: k.volume,
          theirCpc: k.cpc,
          theirPosition: k.position,
          theirEtv: k.etv,
          yourCpc: yours.cpc,
          yourPosition: yours.position,
          yourEtv: yours.etv,
        };
      });
    // Brand bids, competitor does not → brand's own keywords to defend.
    const defendAll = brandKw.data.filter((k) => !compSet.has(normKw(k.keyword)));
    const defend = [...defendAll].sort((a, b) => b.etv - a.etv).slice(0, 100);

    gap = { brandDomain, steal, shared, defend, defendCount: defendAll.length };
  }

  return NextResponse.json({
    domain,
    country: { code: country.code, name: country.name, flag: country.flag },
    spend: overview.data,
    keywords: kw.data,
    totalPaidKeywords: kw.total,
    brandSpend,
    comparison,
    gap,
    cost: Number(totalCost.toFixed(4)),
    source: "DataForSEO Labs",
  });
}
