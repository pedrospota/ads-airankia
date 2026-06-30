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
} from "@/lib/spy/dataforseo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const normKw = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// POST /api/spy/keyword-spend
// Body: { domain, brandDomain?, countryCode? }
// Returns a competitor's estimated Google Ads spend + the paid keywords it bids
// on, and (when brandDomain is given) the keyword gap vs your brand.
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

  // Optional gap vs the brand's own paid keywords.
  let gap: {
    brandDomain: string;
    shared: PaidKeyword[];
    steal: PaidKeyword[]; // only the competitor bids → opportunity
    defend: number; // count of keywords only the brand bids on
  } | null = null;

  if (brandDomain && brandDomain !== domain) {
    const brandKw = await domainPaidKeywords(brandDomain, locationCode, languageCode, 300);
    meter("ranked_keywords", brandKw.cost);
    const compSet = new Set(kw.data.map((k) => normKw(k.keyword)));
    const brandSet = new Set(brandKw.data.map((k) => normKw(k.keyword)));
    const shared = kw.data.filter((k) => brandSet.has(normKw(k.keyword)));
    const steal = kw.data.filter((k) => !brandSet.has(normKw(k.keyword)));
    const defend = brandKw.data.filter((k) => !compSet.has(normKw(k.keyword))).length;
    gap = { brandDomain, shared, steal, defend };
  }

  return NextResponse.json({
    domain,
    country: { code: country.code, name: country.name, flag: country.flag },
    spend: overview.data,
    keywords: kw.data,
    totalPaidKeywords: kw.total,
    gap,
    cost: Number(totalCost.toFixed(4)),
    source: "DataForSEO Labs",
  });
}
