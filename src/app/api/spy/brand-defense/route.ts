import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { recordCost } from "@/lib/cost-ledger";
import { findCountry } from "@/lib/benchmark/countries";
import { adSpyAllowedForRun } from "@/lib/benchmark/config";
import { toDomain } from "@/lib/benchmark/page-fetch";
import {
  oxylabsConfigured,
  runBrandDefense,
  toBrandThreatSlices,
} from "@/lib/spy/brand-defense";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Estimated Oxylabs google_ads cost per branded keyword scraped (directional —
// Oxylabs bills per 1k realtime queries; the live client also logs call volume).
const EST_USD_PER_KEYWORD = 0.005;

// POST /api/spy/brand-defense
// Body: { brandDomain, brandName?, keywords?: string[], countryCode? }
// Runs a real-time Google Ads SERP for each branded keyword and returns the
// advertisers bidding on the brand's own terms that are NOT the brand itself.
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to run this." }, { status: 401 });

  if (!oxylabsConfigured()) {
    return NextResponse.json({ error: "Oxylabs is not configured on the server." }, { status: 503 });
  }
  // Same paid-ad-spy gate every other live spy enforces: an explicit run IS the
  // per-run opt-in, but it still respects the account/admin authorization.
  if (!(await adSpyAllowedForRun(true))) {
    return NextResponse.json({ error: "Live ad-spy isn't enabled for this account — enable it in /admin." }, { status: 403 });
  }

  let body: { brandDomain?: string; brandName?: string; keywords?: string[]; countryCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const brandDomain = toDomain((body.brandDomain ?? "").trim());
  const brandName = (body.brandName ?? "").trim();
  if (!brandDomain && !brandName) {
    return NextResponse.json({ error: "Enter your brand domain or brand name." }, { status: 400 });
  }

  // Build the branded keyword set (max 3): explicit keywords win, else fall back
  // to the brand name and the domain's label (e.g. "airankia.com" → "airankia").
  const provided = (Array.isArray(body.keywords) ? body.keywords : []).map((k) => String(k).trim()).filter(Boolean);
  const fallback = [brandName, brandDomain ? brandDomain.replace(/\.[a-z.]+$/i, "") : ""].filter(Boolean);
  const keywords = (provided.length ? provided : fallback).slice(0, 3);
  if (!keywords.length) {
    return NextResponse.json({ error: "Add at least one branded keyword (your brand name)." }, { status: 400 });
  }

  const country = findCountry(body.countryCode ?? null);

  // Meter the run to the cost ledger (the live oxylabs client also records each
  // underlying call; this row is the tool-level dollar estimate for /admin Costs).
  const cost = Number((keywords.length * EST_USD_PER_KEYWORD).toFixed(4));
  void recordCost({
    category: "external_api",
    provider: "oxylabs",
    resource: "brand_defense",
    costMicros: Math.round(cost * 1_000_000),
    units: keywords.length,
    userId: user.id,
    brandId: null,
    workspaceId: null,
    runId: null,
    meta: { module: "spy", tool: "brand_defense", brandDomain: brandDomain ?? brandName, keywords },
  });

  const { brandDomain: brand, threats } = await runBrandDefense({
    brandDomain: brandDomain ?? brandName,
    keywords,
    geo: country.geo,
    cost: { userId: user.id, brandId: null, workspaceId: null, runId: null },
  });

  const totalThreats = new Set(threats.flatMap((t) => t.conquesters.map((c) => c.domain))).size;

  return NextResponse.json({
    brandDomain: brand,
    country: { code: country.code, name: country.name, flag: country.flag },
    threats,
    // Typed CompetitiveBrief slice — the orchestrator drops this straight in.
    slice: toBrandThreatSlices(threats),
    totalThreats,
    cost,
    source: "Oxylabs",
  });
}
