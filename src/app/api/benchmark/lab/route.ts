import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { isWindmillConfigured, runBenchmarkLab } from "@/lib/benchmark/windmill";
import { labRunnerConfigured, runBenchmarkLabInApp } from "@/lib/benchmark/lab-runner";
import { buildSampleReport } from "@/lib/benchmark/lab-sample";
import { findCountry } from "@/lib/benchmark/countries";
import type { BenchmarkMode, LabQuery } from "@/lib/benchmark/lab-types";

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
  const mode: BenchmarkMode = ["normal", "company", "extended"].includes(String(body.mode))
    ? (body.mode as BenchmarkMode)
    : "normal";
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
  };
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
