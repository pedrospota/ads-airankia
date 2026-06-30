import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { adsDb } from "@/lib/ads-db";
import { benchmarkRuns } from "@/lib/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  startBenchmarkRun,
  resolveCountryCode,
  resolveLanguageCode,
  type BenchmarkBrandContext,
  type EntryMode,
} from "@/lib/benchmark/engine";
import { toDomain } from "@/lib/benchmark/page-fetch";
import { parseTransparencyParams } from "@/lib/benchmark/lab-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/benchmark/runs?brandId=... — list this user's runs for a brand.
export async function GET(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const brandId = request.nextUrl.searchParams.get("brandId");
  if (!brandId)
    return NextResponse.json({ error: "brandId is required" }, { status: 400 });

  const rows = await adsDb
    .select({
      id: benchmarkRuns.id,
      status: benchmarkRuns.status,
      entryMode: benchmarkRuns.entryMode,
      stage: benchmarkRuns.stage,
      progress: benchmarkRuns.progress,
      liveEnabled: benchmarkRuns.liveEnabled,
      error: benchmarkRuns.error,
      createdAt: benchmarkRuns.createdAt,
      finishedAt: benchmarkRuns.finishedAt,
    })
    .from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.brandId, brandId), eq(benchmarkRuns.userId, user.id)))
    .orderBy(desc(benchmarkRuns.createdAt))
    .limit(25);

  return NextResponse.json({ runs: rows });
}

// POST /api/benchmark/runs — create + kick off a benchmark run for a brand.
// Body: { brandId, entryMode?, manualKeyword?, manualDomain?, adSpy?,
//         countryCode?, languageCode? }
// adSpy is the user's per-run opt-in to live competitor ads + keyword-advertiser
// discovery (PAID). countryCode/languageCode are OPTIONAL overrides — market &
// language are auto-detected from the brand by default (the user never has to
// pick); these only apply when the user explicitly changes them.
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    brandId?: string;
    entryMode?: string;
    manualKeyword?: string;
    manualDomain?: string;
    manualDomains?: string[];
    adSpy?: boolean;
    countryCode?: string;
    languageCode?: string;
    transparency?: unknown;
    ocr?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const brandId = body.brandId;
  if (!brandId)
    return NextResponse.json({ error: "brandId is required" }, { status: 400 });

  // entryMode: the user keeps full control of the entry point (auto / by a
  // keyword / by a competitor domain) — but the default is fully automatic.
  const entryMode: EntryMode =
    body.entryMode === "keyword"
      ? "keyword"
      : body.entryMode === "domain"
        ? "domain"
        : body.entryMode === "competitors"
          ? "competitors"
          : "auto";

  const manualDomains =
    entryMode === "competitors" && Array.isArray(body.manualDomains)
      ? body.manualDomains
          .filter((d): d is string => typeof d === "string")
          .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0])
          .filter(Boolean)
          .slice(0, 20)
      : undefined;

  // Resolve the brand profile (Supabase, read-only) for context + geo.
  const {
    data: { session },
  } = await authClient.auth.getSession();
  const readClient = createSupabaseReadClient(session?.access_token);
  const { data: brand, error: brandError } = await readClient
    .from("brand_project")
    .select(
      "id, workspace_id, name, industry, website, business_entity_offering, audience_client, audience_plural, audience_singular, competitors, main_country"
    )
    .eq("id", brandId)
    .single();

  if (brandError || !brand) {
    console.error("[benchmark/runs] brand lookup failed", brandError);
    return NextResponse.json({ error: "brand not found" }, { status: 404 });
  }

  const website = (brand.website ?? "").trim() || null;
  const competitors = Array.isArray(brand.competitors)
    ? brand.competitors
        .map((c: unknown) => (typeof c === "string" ? c.trim() : ""))
        .filter(Boolean)
    : [];
  // Market + language: auto-detected from the brand by default. The optional
  // body overrides only kick in when the user explicitly changes them (a valid
  // ISO-2 country / 2-letter language). An override country re-derives language
  // unless the user also overrode language explicitly.
  let countryCode = resolveCountryCode(brand.main_country, website);
  let languageCode = resolveLanguageCode(countryCode);
  const overrideCountry = (body.countryCode ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(overrideCountry)) {
    countryCode = overrideCountry.toUpperCase();
    languageCode = resolveLanguageCode(countryCode);
  }
  const overrideLang = (body.languageCode ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(overrideLang)) {
    languageCode = overrideLang.toLowerCase();
  }

  const ctx: BenchmarkBrandContext = {
    brandId,
    workspaceId: brand.workspace_id,
    userId: user.id,
    name: (brand.name ?? "").trim(),
    website,
    domain: website ? toDomain(website) : null,
    offering: (brand.business_entity_offering ?? "").trim(),
    audience: (
      brand.audience_client ||
      brand.audience_plural ||
      brand.audience_singular ||
      ""
    ).trim(),
    industry: (brand.industry ?? "").trim(),
    competitors,
    languageCode,
    countryCode,
  };

  try {
    const runId = await startBenchmarkRun({
      ctx,
      entryMode,
      manualKeyword: body.manualKeyword ?? null,
      manualDomain: body.manualDomain ?? null,
      manualDomains,
      adSpy: body.adSpy === true,
      transparency: parseTransparencyParams(body.transparency),
      ocr: body.ocr === true,
    });
    return NextResponse.json({ runId });
  } catch (e) {
    console.error("[benchmark/runs] failed to start", e);
    return NextResponse.json(
      { error: "failed to start benchmark" },
      { status: 500 }
    );
  }
}
