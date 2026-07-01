import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { adSpyAllowedForRun } from "@/lib/benchmark/config";
import { recordCost } from "@/lib/cost-ledger";
import { findCountry } from "@/lib/benchmark/countries";
import { toDomain } from "@/lib/benchmark/page-fetch";
import { discoverPaidCompetitors } from "@/lib/spy/discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/spy/discovery — PAID competitor discovery.
// Body: { brandDomain?, keywords?: string[], countryCode? }
// Live Oxylabs scrape that returns the domains ACTUALLY running Google Ads on the
// brand's own keywords right now — the real paid rivals, not organic look-alikes.
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to run this." }, { status: 401 });

  // Live paid scrape — gate exactly like the Premium Report does.
  if (!(await adSpyAllowedForRun(true))) {
    return NextResponse.json(
      { error: "Live ad-spy isn't enabled for this account — enable it in /admin." },
      { status: 403 }
    );
  }

  let body: { brandDomain?: string; keywords?: string[]; countryCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const brandDomain = toDomain((body.brandDomain ?? "").trim());
  const keywords = (Array.isArray(body.keywords) ? body.keywords : [])
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter(Boolean);
  if (!brandDomain && keywords.length === 0) {
    return NextResponse.json({ error: "Enter your brand domain or a few seed keywords." }, { status: 400 });
  }

  const country = findCountry(body.countryCode ?? null);
  const locationCode = parseInt(country.region, 10) || 2840;
  const languageCode = country.lang || "en";
  const geo = country.geo;

  const cost = { userId: user.id, brandId: null, workspaceId: null, runId: null };
  const { data, keywordsProbed, cost: runCost, error } = await discoverPaidCompetitors({
    brandDomain: brandDomain ?? "",
    seedKeywords: keywords,
    locationCode,
    languageCode,
    geo,
    cost,
  });

  void recordCost({
    category: "external_api",
    provider: "oxylabs",
    resource: "discovery",
    costMicros: Math.round(runCost * 1_000_000),
    units: keywordsProbed.length,
    userId: user.id,
    brandId: null,
    workspaceId: null,
    runId: null,
    meta: { module: "spy", tool: "discovery", brandDomain: brandDomain ?? null },
  });

  if (error && data.length === 0) {
    return NextResponse.json({ error }, { status: 502 });
  }

  return NextResponse.json({
    brandDomain,
    country: { code: country.code, name: country.name, flag: country.flag },
    advertisers: data,
    keywordsProbed,
    cost: Number(runCost.toFixed(4)),
    source: "Oxylabs (live Google Ads)",
  });
}
