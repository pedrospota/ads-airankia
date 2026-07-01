import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { adSpyAllowedForRun } from "@/lib/benchmark/config";
import { findCountry } from "@/lib/benchmark/countries";
import { toDomain } from "@/lib/benchmark/page-fetch";
import { discoverCompetitors } from "@/lib/spy/discovery";
import { runAutoMode } from "@/lib/spy/auto-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/spy/report — the Premium Report. Runs all spy tools over the
// competitor set (auto-discovers it when none is given), assembles one
// CompetitiveBrief, synthesizes it, and returns the consolidated report.
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to run this." }, { status: 401 });
  if (!(await adSpyAllowedForRun(true))) {
    return NextResponse.json({ error: "Live ad-spy isn't enabled for this account — enable it in /admin." }, { status: 403 });
  }

  let body: { brandDomain?: string; brandName?: string; competitors?: string[]; countryCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const brandDomain = toDomain(typeof body.brandDomain === "string" ? body.brandDomain.trim() : "");
  const brandName = typeof body.brandName === "string" ? body.brandName.trim() : "";
  if (!brandDomain && !brandName) {
    return NextResponse.json({ error: "Enter your brand domain or name." }, { status: 400 });
  }

  const country = findCountry(body.countryCode ?? null);
  const cost = { userId: user.id, brandId: null, workspaceId: null, runId: null };

  // Competitors: explicit list wins; otherwise auto-discover from the brand domain.
  let competitors = (Array.isArray(body.competitors) ? body.competitors : [])
    .map((c) => toDomain(String(c)) ?? "")
    .filter(Boolean);
  if (!competitors.length && brandDomain) {
    const disc = await discoverCompetitors(brandDomain, parseInt(country.region, 10) || 2840, country.lang || "en", 5);
    competitors = disc.data.map((d) => d.domain).slice(0, 5);
  }
  if (!competitors.length) {
    return NextResponse.json({ error: "No competitors given and none could be auto-discovered — add a few domains." }, { status: 400 });
  }

  try {
    const result = await runAutoMode({
      brandName: brandName || (brandDomain ?? ""),
      brandDomain,
      competitors,
      countryCode: country.code,
      cost,
    });
    return NextResponse.json({
      brief: result.brief,
      executiveSummary: result.executiveSummary,
      reportMarkdown: result.reportMarkdown,
      competitors: result.brief.competitors,
      cost: result.cost,
      source: "DataForSEO + Oxylabs + Firecrawl + AI",
    });
  } catch (e) {
    console.error("[spy/report] failed", e);
    return NextResponse.json({ error: "The report run failed — try fewer competitors or retry." }, { status: 502 });
  }
}
