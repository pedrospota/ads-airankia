import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { isWindmillConfigured, runBenchmarkLab } from "@/lib/benchmark/windmill";
import { labRunnerConfigured, runBenchmarkLabInApp } from "@/lib/benchmark/lab-runner";
import { buildSampleReport } from "@/lib/benchmark/lab-sample";
import { findCountry } from "@/lib/benchmark/countries";
import type { BenchmarkMode, LabQuery, TransparencyParams } from "@/lib/benchmark/lab-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeQuery(body: Record<string, unknown>): LabQuery {
  const rawKeywords = Array.isArray(body.keywords)
    ? body.keywords
    : typeof body.keywords === "string"
      ? [body.keywords]
      : [];
  // Split each entry on commas/newlines too, so pasted lists work whether they
  // arrive as one string or as array elements that still contain separators.
  const keywords = [
    ...new Set(
      rawKeywords
        .flatMap((s) => String(s).split(/[\n,]/))
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

  const country = findCountry(typeof body.countryCode === "string" ? body.countryCode : null);
  const language =
    typeof body.language === "string" && body.language.trim()
      ? body.language.trim().toLowerCase()
      : country.lang;
  const mode: BenchmarkMode = ["keyword", "company", "extended", "extended_company"].includes(String(body.mode))
    ? (body.mode as BenchmarkMode)
    : "keyword";
  const numKeywords = clampInt(body.numKeywords, 1, 25, keywords.length || 5);
  const numCompetitors = clampInt(body.numCompetitors, 1, 20, 6);

  return {
    keywords: keywords.slice(0, numKeywords),
    countryCode: country.code,
    countryName: country.name,
    geo: country.geo,
    region: country.region,
    language,
    mode,
    numKeywords,
    numCompetitors,
    transparency: normalizeTransparency(body.transparency),
  };
}

// Manual Transparency-Center params — only kept when the user actually set them.
// Everything is optional; omitted values mean "follow the safe default" (no
// region, all platforms/formats, max 100 ads).
function normalizeTransparency(raw: unknown): TransparencyParams | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s : null;
  };
  const PLATFORMS = new Set(["SEARCH", "MAPS", "YOUTUBE", "GOOGLEPLAY"]);
  const FORMATS = new Set(["text", "image", "video"]);
  const platformRaw = str(r.platform)?.toUpperCase() ?? null;
  const formatRaw = str(r.creativeFormat)?.toLowerCase() ?? null;
  const digits = (v: unknown): string | null => {
    const s = str(v)?.replace(/\D/g, "") ?? null;
    return s && s.length === 8 ? s : null; // YYYYMMDD
  };
  const numRaw =
    r.num === undefined || r.num === null || r.num === ""
      ? null
      : Math.max(1, Math.min(100, Math.round(Number(r.num) || 0))) || null;

  const t: TransparencyParams = {
    region: str(r.region),
    platform: platformRaw && PLATFORMS.has(platformRaw) ? platformRaw : null,
    creativeFormat: formatRaw && FORMATS.has(formatRaw) ? formatRaw : null,
    advertiserId: str(r.advertiserId),
    startDate: digits(r.startDate),
    endDate: digits(r.endDate),
    num: numRaw,
  };
  // Drop entirely if nothing meaningful was provided.
  const hasAny = Object.values(t).some((v) => v !== null && v !== undefined);
  return hasAny ? t : undefined;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const query = normalizeQuery(body);
  if (!query.keywords.length) {
    return NextResponse.json({ error: "Add at least one keyword." }, { status: 400 });
  }

  // In-app pipeline (Oxylabs + SerpApi) takes priority over Windmill when
  // configured — it's the n8n parity build Pedro asked for and deploys on the
  // same Coolify app with no extra infra.
  const inAppConfigured = labRunnerConfigured();
  const windmillConfigured = isWindmillConfigured();
  const liveConfigured = inAppConfigured || windmillConfigured;

  // Real runs spend money / hit paid APIs → require auth.
  // Demo (no live backend) stays open so the UI is always previewable.
  if (liveConfigured) {
    const authClient = await createSupabaseServerClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to run a live benchmark." }, { status: 401 });
    }
    try {
      const report = inAppConfigured
        ? await runBenchmarkLabInApp(query)
        : await runBenchmarkLab(query);
      return NextResponse.json({ report });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Benchmark failed.";
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  }

  return NextResponse.json({ report: buildSampleReport(query) });
}
