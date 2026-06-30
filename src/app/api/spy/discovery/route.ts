import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { recordCost } from "@/lib/cost-ledger";
import { findCountry } from "@/lib/benchmark/countries";
import { toDomain } from "@/lib/benchmark/page-fetch";
import { discoveryConfigured, discoverCompetitors } from "@/lib/spy/discovery";
import type { DiscoverySlice } from "@/lib/spy/brief";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/spy/discovery
// Body: { domain, countryCode? }
// Returns the competitor domains that fight for the same Google keywords as the
// brand, ranked by keyword overlap — rivals the user hadn't listed.
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to run this." }, { status: 401 });

  if (!discoveryConfigured()) {
    return NextResponse.json({ error: "DataForSEO is not configured on the server." }, { status: 503 });
  }

  let body: { domain?: string; countryCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const domain = toDomain((body.domain ?? "").trim());
  if (!domain) return NextResponse.json({ error: "Enter a valid brand domain (e.g. airankia.com)." }, { status: 400 });

  const country = findCountry(body.countryCode ?? null);
  const locationCode = parseInt(country.region, 10) || 2840;
  const languageCode = country.lang || "en";

  const { data, cost, error } = await discoverCompetitors(domain, locationCode, languageCode, 25);
  void recordCost({
    category: "external_api",
    provider: "dataforseo",
    resource: "competitors_domain",
    costMicros: Math.round(cost * 1_000_000),
    units: data.length,
    userId: user.id,
    brandId: null,
    workspaceId: null,
    runId: null,
    meta: { module: "spy", tool: "discovery", domain },
  });

  if (error && data.length === 0) {
    return NextResponse.json({ error }, { status: 502 });
  }

  // Typed brief slice — overlap = keyword intersections.
  const slice: DiscoverySlice = {
    suggested: data.map((c) => ({ domain: c.domain, overlap: c.intersections })),
  };

  return NextResponse.json({
    domain,
    country: { code: country.code, name: country.name, flag: country.flag },
    slice,
    // Friendlier UI shape (carries avg position for context).
    suggested: data,
    cost: Number(cost.toFixed(4)),
    source: "DataForSEO Labs",
  });
}
