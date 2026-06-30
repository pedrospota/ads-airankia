// ============================================================================
// Benchmark engine — the async job that produces one competitor-benchmark
// report. Kicked fire-and-forget from the API route (the app runs as a
// long-lived Node server, so the promise runs to completion in the background)
// and streams progress through benchmark_events.
//
// Data sources, in order of trust + cost:
//   1. Google Keyword Planner (FREE)  — real volumes/CPC/competition for the
//      brand's footprint and each competitor's footprint (URL-seeded).
//   2. Public landing pages (FREE)    — fetched + LLM teardown + tracking/UTM
//      extraction (their offer, CTAs, trust signals, marketing stack).
//   3. Ad-spy (PAID, GATED OFF)       — running creatives via SearchApi. Only
//      runs when an admin enabled the gate AND a key is present (see config.ts).
//   4. Strategy synthesis (LLM)       — crosses all of the above into an
//      actionable plan, written in the brand's language.
//
// Resilience: every external step is wrapped so a single failure becomes a
// note, never a dead run. KP + page fetch never throw; LLM steps are guarded.
// ============================================================================

import { adsDb } from "@/lib/ads-db";
import { benchmarkRuns } from "@/lib/schema";
import { eq } from "drizzle-orm";
import {
  generateKeywordIdeas,
  generateKeywordForecast,
  getAccountCurrency,
  currencySymbol,
  PLANNER_CREDENTIAL_CONFIGURED,
  type KeywordPlanIdea,
  type KeywordPlannerError,
} from "@/lib/google-ads";
import { languageName } from "@/lib/engine/types";
import { benchmarkLlm } from "./llm";
import { getBenchmarkConfig } from "./config";
import { fetchAds, discoverAdvertisers } from "./ad-spy";
import { runBenchmarkLabInApp } from "./lab-runner";
import { findCountry } from "./countries";
import type { BenchmarkMode, LabQuery, TransparencyParams } from "./lab-types";
import { fetchPage, extractTracking, toDomain } from "./page-fetch";
import { emitBenchmarkEvent } from "./events";
import { estimateCompetitorSpend, summarizeSpend } from "./spend";
import type {
  BenchmarkReport,
  BenchmarkKeyword,
  BenchmarkCompetitor,
  CompetitorLanding,
  KeywordGap,
  BenchmarkStrategy,
  BenchmarkCostContext,
  ForecastProjection,
} from "./types";

// ----------------------------------------------------------------------------
// Brand context — everything the engine needs, resolved by the route (which has
// the user session) so the background job touches only adsDb (no Supabase).
// ----------------------------------------------------------------------------
export interface BenchmarkBrandContext {
  brandId: string;
  workspaceId: string;
  userId: string;
  name: string;
  website: string | null;
  domain: string | null;
  offering: string;
  audience: string;
  industry: string;
  competitors: string[];
  languageCode: string;
  countryCode: string;
}

export type EntryMode = "auto" | "keyword" | "domain";

// ---- geo resolution (no LLM; small maps, TLD fallback) ---------------------

const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  spain: "ES", españa: "ES", espana: "ES",
  mexico: "MX", méxico: "MX",
  argentina: "AR", colombia: "CO", chile: "CL", peru: "PE", perú: "PE",
  "united states": "US", usa: "US", "estados unidos": "US",
  "united kingdom": "GB", uk: "GB", "reino unido": "GB",
  france: "FR", francia: "FR",
  germany: "DE", alemania: "DE",
  italy: "IT", italia: "IT",
  portugal: "PT",
};

const TLD_TO_ISO: Record<string, string> = {
  es: "ES", mx: "MX", ar: "AR", co: "CO", cl: "CL", pe: "PE",
  us: "US", uk: "GB", fr: "FR", de: "DE", it: "IT", pt: "PT",
};

const ISO_TO_LANG: Record<string, string> = {
  ES: "es", MX: "es", AR: "es", CO: "es", CL: "es", PE: "es",
  US: "en", GB: "en", FR: "fr", DE: "de", IT: "it", PT: "pt",
};

export function resolveCountryCode(
  mainCountry: string | null | undefined,
  website: string | null | undefined
): string {
  const raw = (mainCountry ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  const byName = COUNTRY_NAME_TO_ISO[raw.toLowerCase()];
  if (byName) return byName;
  const d = website ? toDomain(website) : null;
  if (d) {
    const tld = d.split(".").pop() ?? "";
    if (TLD_TO_ISO[tld]) return TLD_TO_ISO[tld];
  }
  return "ES";
}

export function resolveLanguageCode(countryCode: string): string {
  return ISO_TO_LANG[countryCode.toUpperCase()] ?? "es";
}

/** Pull domain-like entries out of a free-form competitors list. */
export function deriveCompetitorDomains(
  competitors: string[],
  ownDomain: string | null
): string[] {
  const out: string[] = [];
  for (const c of competitors) {
    const s = (c ?? "").trim();
    if (!s || !s.includes(".")) continue; // name-only entries can't be URL-seeded
    const d = toDomain(s);
    if (d && d !== ownDomain && !out.includes(d)) out.push(d);
  }
  return out;
}

// ---- helpers ----------------------------------------------------------------

const normKw = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function toBenchmarkKeyword(i: KeywordPlanIdea): BenchmarkKeyword {
  return {
    text: i.text,
    avgMonthlySearches: i.avgMonthlySearches,
    competition: i.competition,
    cpcLowMicros: i.topOfPageBidLowMicros,
    cpcHighMicros: i.topOfPageBidHighMicros,
  };
}

function topByVolume(kws: BenchmarkKeyword[], n: number): BenchmarkKeyword[] {
  return [...kws]
    .sort((a, b) => b.avgMonthlySearches - a.avgMonthlySearches)
    .slice(0, n);
}

async function setRun(
  runId: string,
  patch: Partial<typeof benchmarkRuns.$inferInsert>
): Promise<void> {
  await adsDb
    .update(benchmarkRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(benchmarkRuns.id, runId));
}

async function stage(
  runId: string,
  label: string,
  progress: number
): Promise<void> {
  await setRun(runId, { stage: label, progress });
  await emitBenchmarkEvent(runId, "stage", { stage: label, progress });
}

// ----------------------------------------------------------------------------
// Start — insert the run row + kick the background job. Returns the run id.
// ----------------------------------------------------------------------------
export async function startBenchmarkRun(input: {
  ctx: BenchmarkBrandContext;
  entryMode: EntryMode;
  manualKeyword?: string | null;
  manualDomain?: string | null;
  /** End user's per-run opt-in to live competitor ads + keyword-advertiser
   *  discovery (PAID SearchApi). Default false → free run, no spend. */
  adSpy?: boolean;
  /** Optional manual Transparency-Center params (advanced settings). */
  transparency?: TransparencyParams;
}): Promise<string> {
  const { ctx, entryMode } = input;
  const config = await getBenchmarkConfig();
  const adSpy = input.adSpy === true;

  const seedDomains = deriveCompetitorDomains(ctx.competitors, ctx.domain);
  const manualDomain = input.manualDomain
    ? toDomain(input.manualDomain)
    : null;
  if (manualDomain && !seedDomains.includes(manualDomain)) {
    seedDomains.unshift(manualDomain);
  }

  const seedKeywords: string[] = [];
  const manualKeyword = (input.manualKeyword ?? "").trim();
  if (manualKeyword) seedKeywords.push(manualKeyword);

  const [row] = await adsDb
    .insert(benchmarkRuns)
    .values({
      brandId: ctx.brandId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      status: "queued",
      entryMode,
      seedKeywords,
      seedDomains: seedDomains.slice(0, config.maxCompetitors),
      countryCode: ctx.countryCode,
      languageCode: ctx.languageCode,
      // Records the intent to run live ad-spy for this run (admin master switch
      // OR the user's per-run opt-in). Whether ads actually came back is
      // reflected separately in report.meta.liveAdSpy.
      liveEnabled: config.liveEnabled || adSpy,
      progress: 0,
    })
    .returning({ id: benchmarkRuns.id });

  const runId = row.id;

  // Fire-and-forget. The job marks the run failed on any uncaught error.
  void runBenchmark(runId, ctx, {
    keywords: seedKeywords,
    domains: seedDomains.slice(0, config.maxCompetitors),
    manualDomain,
    adSpy,
    transparency: input.transparency,
  }).catch(async (e) => {
    console.error("[benchmark] run crashed", runId, e);
    await setRun(runId, {
      status: "failed",
      error: e instanceof Error ? e.message : "benchmark failed",
      finishedAt: new Date(),
    });
    await emitBenchmarkEvent(runId, "error", {
      message: e instanceof Error ? e.message : "benchmark failed",
    });
  });

  return runId;
}

// ----------------------------------------------------------------------------
// The job.
// ----------------------------------------------------------------------------
export async function runBenchmark(
  runId: string,
  ctx: BenchmarkBrandContext,
  seeds: {
    keywords: string[];
    domains: string[];
    manualDomain?: string | null;
    adSpy?: boolean;
    transparency?: TransparencyParams;
  }
): Promise<void> {
  const adSpy = seeds.adSpy === true;
  // When the live competitor-ad analysis runs (Pedro's Oxylabs→domains→Transparency
  // pipeline below), it IS the benchmark — so we skip the old engine's heavy,
  // slow, LLM-per-competitor landing teardowns and strategy synthesis (they were
  // the 90% freeze and the "noise" Pedro doesn't want). The teardown report is
  // the single source of truth.
  const skipHeavyEngine = adSpy;
  const cost: BenchmarkCostContext = {
    userId: ctx.userId,
    brandId: ctx.brandId,
    workspaceId: ctx.workspaceId,
    runId,
  };
  const lang = ctx.languageCode;
  const langLabel = languageName(lang);
  const country = ctx.countryCode;
  const config = await getBenchmarkConfig();

  await setRun(runId, { status: "running", startedAt: new Date() });
  await stage(runId, "Reading your brand", 5);

  // Resolve the account currency once (fixes the hardcoded "€"). Threaded into
  // spend modeling + the forecast so every figure renders in the real currency.
  const currencyCode = await getAccountCurrency();
  const currency = currencySymbol(currencyCode);

  // Track the deterministic-data layer: the first planner failure (if any) is
  // kept so the report can honestly say WHY numbers are missing instead of
  // silently showing zeros. Held in an object so the closures can mutate it
  // without TS narrowing it away.
  const planner: { error: KeywordPlannerError | null } = { error: null };
  const onPlannerError = (e: KeywordPlannerError) => {
    if (!planner.error) planner.error = e;
  };

  // ---- 1. Brand's own keyword footprint (URL-seeded + any manual keyword) ----
  await stage(runId, "Mapping your keyword footprint", 12);
  const brandIdeas = await generateKeywordIdeas({
    keywordSeeds: seeds.keywords.length ? seeds.keywords : undefined,
    urlSeed: ctx.website ?? undefined,
    languageCode: lang,
    countryCodes: [country],
    costContext: cost,
    onError: onPlannerError,
  });
  const brandKeywords = topByVolume(brandIdeas.map(toBenchmarkKeyword), 60);
  const brandKwSet = new Set(brandKeywords.map((k) => normKw(k.text)));
  await emitBenchmarkEvent(runId, "partial", {
    kind: "brandKeywords",
    count: brandKeywords.length,
  });

  // ---- 1b. Who actually advertises on the seed keyword? ----------------------
  // "Ambos": when the user starts from a keyword AND opts into live data, we
  // discover the domains running real paid ads on that term (SearchApi SERP) and
  // UNION them with the saved competitor list — deduped by domain, provenance
  // tracked so the report can show which came from discovery vs the profile.
  const domainSource = new Map<string, BenchmarkCompetitor["source"]>();
  for (const d of seeds.domains) domainSource.set(d, "brand_profile");
  const manualDomain = seeds.manualDomain ?? null;
  if (manualDomain && domainSource.has(manualDomain)) {
    domainSource.set(manualDomain, "manual");
  }

  if (!skipHeavyEngine && adSpy && seeds.keywords.length) {
    await stage(runId, "Discovering who advertises on your keyword", 9);
    let discovered = 0;
    for (const kw of seeds.keywords) {
      const disc = await discoverAdvertisers(kw, country, cost, {
        optIn: adSpy,
      });
      for (const d of disc.domains) {
        if (!d || d === ctx.domain) continue; // never analyze the brand itself
        if (!domainSource.has(d)) {
          domainSource.set(d, "derived");
          discovered++;
        }
      }
    }
    if (discovered > 0) {
      await emitBenchmarkEvent(runId, "partial", {
        kind: "discovered",
        count: discovered,
      });
    }
  }

  // ---- 2. Per-competitor analysis -------------------------------------------
  // Saved-list + manual domains keep priority (inserted first); discovered ones
  // fill the remaining slots up to the cost cap.
  const competitors: BenchmarkCompetitor[] = [];
  if (!skipHeavyEngine) {
    const domains = [...domainSource.keys()].slice(0, config.maxCompetitors);
    const spanStart = 18;
    const spanEnd = 72;

    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i];
      const source = domainSource.get(domain) ?? "brand_profile";
      const progress =
        spanStart + Math.round(((i + 0.5) / Math.max(1, domains.length)) * (spanEnd - spanStart));
      await stage(
        runId,
        `Analyzing competitor ${i + 1} of ${domains.length}: ${domain}`,
        progress
      );

      const comp = await analyzeCompetitor(
        domain,
        ctx,
        country,
        currency,
        cost,
        source,
        adSpy,
        onPlannerError
      );
      competitors.push(comp);
      await emitBenchmarkEvent(runId, "partial", { kind: "competitor", competitor: comp });
    }
  }

  // ---- 3. Keyword gaps (competitor footprint minus brand footprint) ----------
  await stage(runId, "Finding keyword gaps", 78);
  const keywordGaps = computeKeywordGaps(competitors, brandKwSet);
  await emitBenchmarkEvent(runId, "partial", { kind: "gaps", count: keywordGaps.length });

  // ---- Deterministic-data availability --------------------------------------
  // Real numbers (volumes / CPC / forecast) are the hero of this report. Decide
  // honestly whether we actually have them — so we never render a confident AI
  // strategy on top of all-zeros (the #1 ask: real numbers > AI prose).
  const hasRealKeywordData =
    brandKeywords.length > 0 || competitors.some((c) => c.keywords.length > 0);
  const blockedByAccess =
    !hasRealKeywordData &&
    planner.error !== null &&
    (planner.error.kind === "access" || planner.error.kind === "quota");

  // ---- 4. AI strategy synthesis ---------------------------------------------
  await stage(runId, "Writing your strategy", 90);
  let strategy: BenchmarkStrategy;
  if (blockedByAccess) {
    // No real search data came back → skip the heavyweight AI synthesis. We do
    // NOT manufacture a full strategy on top of empty numbers; we say plainly
    // why the data is missing. The (free, qualitative) competitor landing
    // teardowns above are still complete.
    strategy = {
      summary:
        planner.error?.message ??
        "Real keyword data isn't available yet, so we're not generating a full strategy on top of empty numbers. The competitor landing-page teardowns below are still complete.",
      positioning: "",
      opportunities: [],
      threats: [],
      recommendedKeywords: [],
      recommendedAngles: [],
    };
  } else if (skipHeavyEngine) {
    // The live ad teardown below IS the strategy — skip the slow LLM synthesis
    // (it was timing out at 90% and is exactly the "noise" Pedro asked to drop).
    strategy = {
      summary: "",
      positioning: "",
      opportunities: [],
      threats: [],
      recommendedKeywords: [],
      recommendedAngles: [],
    };
  } else {
    try {
      strategy = await synthesizeStrategy(
        ctx,
        langLabel,
        brandKeywords,
        competitors,
        keywordGaps,
        cost
      );
    } catch (e) {
      // Even with the LLM down, we still have real numbers + teardowns — so the
      // "AI strategy" section degrades to a data-derived plan instead of a bare
      // apology (recommended keywords, opportunities, threats from the data).
      strategy = buildFallbackStrategy(competitors, keywordGaps);
      console.error("[benchmark] strategy synthesis failed", runId, e);
    }
  }

  // ---- 5. Forecast the recommended plan (Google's own traffic projection) ----
  // So every recommendation carries real numbers (clicks/cost/CTR/CPC, and an
  // estimated conversions figure). Never throws → just null when unavailable.
  // Skipped entirely when the planner data is blocked (nothing to forecast).
  await stage(runId, "Forecasting the recommended plan", 95);
  const forecast = blockedByAccess
    ? null
    : await buildForecast(
        ctx,
        country,
        currency,
        currencyCode,
        strategy,
        keywordGaps,
        brandKeywords,
        competitors,
        cost,
        onPlannerError
      );
  if (forecast) {
    await emitBenchmarkEvent(runId, "partial", {
      kind: "forecast",
      clicks: forecast.clicks,
      costMicros: forecast.costMicros,
    });
  }

  // ---- 5b. Live ad-intelligence teardown (shared pipeline) -------------------
  // EXACTLY Pedro's flow: Oxylabs keyword search → the domains present in the ads
  // → Google Ads Transparency for each of those domains → the strategist report.
  // NO OCR ("no more than that"), NO adding domains to the brand's competitor
  // list (this only reads the brand). Same engine as /benchmark-lab.
  //
  //   - "by a keyword" / auto with keywords → extended  (Oxylabs → domains → Transparency)
  //   - "by a competitor" / only domains    → company   (Transparency on the given domains)
  //
  // PAID → runs only on the explicit opt-in. Capped + hard-timeout so it can
  // never hang the run (the 90% freeze Pedro hit); a failure/timeout just drops
  // the section, never kills the report.
  let adIntelligence: BenchmarkReport["adIntelligence"] = null;
  let teardownDomains = 0; // advertisers found by the live pipeline (for the meta strip)
  if (adSpy || config.liveEnabled) {
    try {
      await stage(runId, "Reading competitors' live Google Ads", 92);
      const c = findCountry(country);
      const labMode: BenchmarkMode = seeds.keywords.length ? "extended" : "company";
      const labSeeds = seeds.keywords.length
        ? seeds.keywords.slice(0, 3) // cap: a few keywords keeps Oxylabs fast
        : seeds.domains.length
          ? seeds.domains
          : [ctx.offering || ctx.name].filter(Boolean);
      if (labSeeds.length) {
        const labQuery: LabQuery = {
          keywords: labSeeds,
          countryCode: c.code,
          countryName: c.name,
          geo: c.geo,
          region: c.region,
          language: lang,
          mode: labMode,
          numKeywords: labSeeds.length,
          numCompetitors: config.maxCompetitors,
          transparency: seeds.transparency,
        };
        // Hard wall-clock cap so a slow Oxylabs/SerpApi/LLM can't freeze the run.
        const labReport = await Promise.race([
          runBenchmarkLabInApp(labQuery, cost, null, { skipOcr: true }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 180_000)),
        ]);
        if (labReport && labReport.analysis?.markdown) {
          adIntelligence = {
            markdown: labReport.analysis.markdown,
            generatedBy: labReport.analysis.model,
          };
          teardownDomains = labReport.advertisers.length;
        } else if (!labReport) {
          console.warn("[benchmark] ad-intelligence teardown timed out", runId);
        }
      }
    } catch (e) {
      console.error("[benchmark] ad-intelligence teardown failed", runId, e);
    }
  }

  // ---- 6. Assemble + persist -------------------------------------------------
  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    language: lang,
    country,
    currency,
    brand: { name: ctx.name, website: ctx.website, domain: ctx.domain },
    brandKeywords,
    competitors,
    keywordGaps,
    strategy,
    forecast,
    adIntelligence,
    spendSummary: summarizeSpend(competitors.map((c) => c.spend), currency),
    meta: {
      liveAdSpy: adIntelligence !== null || competitors.some((c) => c.adsStatus === "ok"),
      domainsAnalyzed: competitors.length || teardownDomains,
      keywordsDiscovered:
        brandKeywords.length +
        competitors.reduce((n, c) => n + c.keywords.length, 0),
      keywordData: {
        status: hasRealKeywordData
          ? planner.error
            ? "partial"
            : "ok"
          : planner.error
            ? planner.error.kind === "access"
              ? "no_access"
              : planner.error.kind === "quota"
                ? "quota"
                : "error"
            : "no_data",
        hasRealKeywordData,
        plannerCredential: PLANNER_CREDENTIAL_CONFIGURED ? "planner" : "default",
        message: planner.error?.message,
      },
    },
  };

  await setRun(runId, {
    status: "completed",
    progress: 100,
    stage: "Done",
    result: report,
    finishedAt: new Date(),
  });
  await emitBenchmarkEvent(runId, "done", { status: "completed" });
}

// ----------------------------------------------------------------------------
// One competitor: keyword footprint + landing teardown + (gated) ad-spy.
// ----------------------------------------------------------------------------
async function analyzeCompetitor(
  domain: string,
  ctx: BenchmarkBrandContext,
  country: string,
  currency: string,
  cost: BenchmarkCostContext,
  source: BenchmarkCompetitor["source"],
  adSpy: boolean,
  onPlannerError?: (e: KeywordPlannerError) => void
): Promise<BenchmarkCompetitor> {
  const notes: string[] = [];

  // Keyword footprint via KP (URL seed). Free, never throws.
  const ideas = await generateKeywordIdeas({
    urlSeed: `https://${domain}`,
    languageCode: ctx.languageCode,
    countryCodes: [country],
    costContext: cost,
    onError: onPlannerError,
  });
  const keywords = topByVolume(ideas.map(toBenchmarkKeyword), 40);
  if (keywords.length === 0) notes.push("Keyword Planner returned no data for this domain.");
  const totalVolume = keywords.reduce((n, k) => n + k.avgMonthlySearches, 0);

  // Landing teardown (fetch + LLM + tracking). Free.
  let landing: CompetitorLanding | null = null;
  const page = await fetchPage(`https://${domain}`);
  if (page.ok && page.text.length > 80) {
    const tracking = extractTracking(page.html);
    try {
      const teardown = await benchmarkLlm<{
        valueProposition: string;
        offers: string[];
        ctas: string[];
        trustSignals: string[];
        toneNotes: string;
      }>({
        tier: "sonnet",
        stage: "landing_teardown",
        cost,
        temperature: 0.2,
        toolName: "submit_teardown",
        toolDescription: "Return the structured landing-page teardown.",
        schema: TEARDOWN_SCHEMA,
        system: `You are a senior paid-search strategist analyzing a competitor's landing page. Be concrete and specific. Write every string in ${languageName(ctx.languageCode)}.`,
        prompt: [
          `Competitor domain: ${domain}`,
          `Page title: ${page.title || "(none)"}`,
          "",
          "Visible page text (truncated):",
          page.text,
          "",
          "Extract: the core value proposition, concrete offers/promotions, the calls-to-action used, trust signals (reviews, guarantees, certifications, logos), and notes on tone/positioning. If something isn't present, return an empty list rather than inventing it.",
        ].join("\n"),
      });
      landing = {
        url: page.url,
        httpStatus: page.status,
        title: page.title,
        valueProposition: teardown.valueProposition ?? "",
        offers: teardown.offers ?? [],
        ctas: teardown.ctas ?? [],
        trustSignals: teardown.trustSignals ?? [],
        toneNotes: teardown.toneNotes ?? "",
        tracking,
      };
    } catch {
      // LLM hiccup — keep the page facts + tracking, skip the teardown text.
      landing = {
        url: page.url,
        httpStatus: page.status,
        title: page.title,
        valueProposition: "",
        offers: [],
        ctas: [],
        trustSignals: [],
        toneNotes: "",
        tracking,
      };
      notes.push("Landing teardown AI step was skipped (timeout).");
    }
  } else {
    notes.push(
      page.status
        ? `Landing page returned HTTP ${page.status}.`
        : "Landing page couldn't be fetched."
    );
  }

  // Ad-spy (PAID — runs only on the user's per-run opt-in or the admin gate;
  // returns status "off" without spending otherwise).
  // Uses SerpApi (n8n parity) → SearchApi fallback — see ad-spy.ts.
  const adResult = await fetchAds(domain, country, cost, { optIn: adSpy });

  const comp: BenchmarkCompetitor = {
    domain,
    source,
    keywords,
    totalVolume,
    landing,
    ads: adResult.ads,
    adsStatus: adResult.status,
    notes,
  };
  // Modeled monthly investment from the (free) KP volumes × CPC. Null when the
  // footprint carries no CPC bids (nothing monetizable to estimate).
  comp.spend = estimateCompetitorSpend(comp, currency);
  return comp;
}

// ----------------------------------------------------------------------------
// Keyword gaps: keywords competitors are associated with that the brand isn't.
// ----------------------------------------------------------------------------
function computeKeywordGaps(
  competitors: BenchmarkCompetitor[],
  brandKwSet: Set<string>
): KeywordGap[] {
  const map = new Map<string, KeywordGap>();
  for (const c of competitors) {
    for (const k of c.keywords) {
      const key = normKw(k.text);
      if (brandKwSet.has(key)) continue; // brand already covers it
      const existing = map.get(key);
      if (existing) {
        if (!existing.competitorsCovering.includes(c.domain))
          existing.competitorsCovering.push(c.domain);
      } else {
        map.set(key, {
          text: k.text,
          avgMonthlySearches: k.avgMonthlySearches,
          competition: k.competition,
          cpcLowMicros: k.cpcLowMicros,
          cpcHighMicros: k.cpcHighMicros,
          competitorsCovering: [c.domain],
          brandCovers: false,
        });
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => {
      // Most-contested first, then by volume — those are the richest gaps.
      if (b.competitorsCovering.length !== a.competitorsCovering.length)
        return b.competitorsCovering.length - a.competitorsCovering.length;
      return b.avgMonthlySearches - a.avgMonthlySearches;
    })
    .slice(0, 60);
}

// ----------------------------------------------------------------------------
// Forecast the recommended plan. Picks the keywords we actually recommend (the
// AI's recommendedKeywords first, then the richest keyword gaps), grounds the
// bid in real Keyword Planner CPC, and asks Google's Keyword Planner forecast
// for the projected traffic. Returns null when nothing is forecastable.
// ----------------------------------------------------------------------------
async function buildForecast(
  ctx: BenchmarkBrandContext,
  country: string,
  currency: string,
  currencyCode: string,
  strategy: BenchmarkStrategy,
  gaps: KeywordGap[],
  brandKeywords: BenchmarkKeyword[],
  competitors: BenchmarkCompetitor[],
  cost: BenchmarkCostContext,
  onError?: (e: KeywordPlannerError) => void
): Promise<ForecastProjection | null> {
  // Index every keyword we know CPC for, so recommended-keyword *strings* can
  // recover real CPC to ground the forecast bid.
  const index = new Map<string, BenchmarkKeyword>();
  const remember = (k: BenchmarkKeyword) => {
    const n = normKw(k.text);
    if (n && !index.has(n)) index.set(n, k);
  };
  brandKeywords.forEach(remember);
  competitors.forEach((c) => c.keywords.forEach(remember));
  gaps.forEach((g) =>
    remember({
      text: g.text,
      avgMonthlySearches: g.avgMonthlySearches,
      competition: g.competition,
      cpcLowMicros: g.cpcLowMicros,
      cpcHighMicros: g.cpcHighMicros,
    })
  );

  // Recommended keywords first, then fill from the richest gaps, then (last
  // resort) the brand's own top keywords. Deduped, capped.
  const chosen: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const n = normKw(t);
    if (n && !seen.has(n)) {
      seen.add(n);
      chosen.push(t.trim());
    }
  };
  (strategy.recommendedKeywords ?? []).forEach(push);
  for (const g of gaps) {
    if (chosen.length >= 25) break;
    push(g.text);
  }
  if (chosen.length === 0) topByVolume(brandKeywords, 15).forEach((k) => push(k.text));
  const keywords = chosen.slice(0, 25);
  if (keywords.length === 0) return null;

  // Bid = median of the chosen keywords' real top-of-page high CPC (fallback €1.50).
  const highs = keywords
    .map((t) => index.get(normKw(t))?.cpcHighMicros)
    .filter((n): n is number => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);
  const maxCpcMicros = highs.length
    ? highs[Math.floor(highs.length / 2)]
    : 1_500_000;

  let f;
  try {
    f = await generateKeywordForecast({
      keywords: keywords.map((t) => ({ text: t, matchType: "PHRASE" as const })),
      languageCode: ctx.languageCode,
      countryCodes: [country],
      maxCpcMicros,
      currencyCode,
      costContext: cost,
      onError,
    });
  } catch {
    return null;
  }
  if (!f) return null;

  return {
    currency,
    periodDays: f.periodDays,
    keywordCount: f.keywordCount,
    keywords,
    impressions: f.impressions,
    clicks: f.clicks,
    ctr: f.ctr,
    avgCpcMicros: f.avgCpcMicros,
    costMicros: f.costMicros,
    conversions: f.conversions,
    conversionRate: f.conversionRate,
    cpaMicros: f.cpaMicros,
    maxCpcMicros,
    basis:
      "Google Ads Keyword Planner forecast for the recommended keywords (phrase match, ~30-day window). Impressions, clicks, CTR, average CPC and cost are Google's own forecast; conversions assume an estimated typical conversion rate (no account conversion tracking yet), so treat those as directional.",
  };
}

// ----------------------------------------------------------------------------
// Strategy synthesis — crosses everything into an actionable plan.
// ----------------------------------------------------------------------------
async function synthesizeStrategy(
  ctx: BenchmarkBrandContext,
  langLabel: string,
  brandKeywords: BenchmarkKeyword[],
  competitors: BenchmarkCompetitor[],
  gaps: KeywordGap[],
  cost: BenchmarkCostContext
): Promise<BenchmarkStrategy> {
  // Build the prompt at a chosen size. The retry shrinks maxComp/maxGaps so a
  // second attempt is materially smaller — faster + far less likely to blow the
  // deadline or the structured-output length on a heavy run.
  const buildPrompt = (maxComp: number, maxGaps: number): string => {
    const compLines = competitors.slice(0, maxComp).map((c) => {
      const top = c.keywords.slice(0, 8).map((k) => k.text).join(", ");
      const offer = c.landing?.valueProposition || "(no landing read)";
      const offers = (c.landing?.offers ?? []).slice(0, 4).join("; ");
      const stack = (c.landing?.tracking.pixels ?? []).join(", ");
      const spend = c.spend
        ? `   estimated monthly Google Search spend: ~${c.spend.currency}${Math.round(
            c.spend.monthlyMid
          ).toLocaleString("en-US")} (range ${c.spend.currency}${Math.round(
            c.spend.monthlyLow
          ).toLocaleString("en-US")}–${c.spend.currency}${Math.round(
            c.spend.monthlyHigh
          ).toLocaleString("en-US")}, modeled, not exact)`
        : "";
      return [
        `• ${c.domain} — top keywords: ${top || "(none)"}`,
        `   value prop: ${offer}`,
        offers ? `   offers: ${offers}` : "",
        stack ? `   marketing stack: ${stack}` : "",
        spend,
      ]
        .filter(Boolean)
        .join("\n");
    });

    const gapLines = gaps
      .slice(0, maxGaps)
      .map(
        (g) =>
          `• ${g.text} — ${g.avgMonthlySearches}/mo, ${g.competition} competition, covered by ${g.competitorsCovering.length} competitor(s)`
      );

    return [
      `Brand: ${ctx.name}${ctx.website ? ` (${ctx.website})` : ""}`,
      ctx.industry ? `Industry: ${ctx.industry}` : "",
      ctx.offering ? `What they offer: ${ctx.offering}` : "",
      ctx.audience ? `Audience: ${ctx.audience}` : "",
      `Market: ${ctx.countryCode}`,
      "",
      `The brand's own top keywords: ${brandKeywords.slice(0, 15).map((k) => k.text).join(", ") || "(none found)"}`,
      "",
      "COMPETITORS:",
      compLines.join("\n") || "(no competitor domains analyzed)",
      "",
      "TOP KEYWORD GAPS (competitors rank, brand appears not to):",
      gapLines.join("\n") || "(none)",
      "",
      "Produce a sharp, executive competitor strategy: an executive summary, the brand's positioning vs these competitors, the biggest opportunities (specific, actionable), the real threats, the keywords to prioritize, and the messaging angles to test. Ground every point in the data above — no fluff.",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const run = (prompt: string, maxTokens: number) =>
    benchmarkLlm<BenchmarkStrategy>({
      tier: "opus",
      stage: "strategy",
      cost,
      temperature: 0.4,
      maxTokens,
      toolName: "submit_strategy",
      toolDescription: "Return the structured competitor strategy.",
      schema: STRATEGY_SCHEMA,
      system: `You are the head of paid search at a top agency, writing a premium competitor-analysis brief for a client. Be specific and decisive. Write EVERYTHING in ${langLabel}.`,
      prompt,
    });

  try {
    return await run(buildPrompt(competitors.length, 25), 4000);
  } catch (e1) {
    // One trimmed retry before giving up to the deterministic fallback.
    console.warn("[benchmark] strategy attempt 1 failed — retrying trimmed", e1);
    return await run(buildPrompt(6, 12), 2500);
  }
}

// Deterministic strategy from the data we already have — used only when the LLM
// synthesis fails after the retry. No model call, never throws: the user still
// gets prioritized keywords, concrete opportunities and threats drawn straight
// from the real numbers and teardowns above.
function buildFallbackStrategy(
  competitors: BenchmarkCompetitor[],
  gaps: KeywordGap[]
): BenchmarkStrategy {
  const topGaps = gaps.slice(0, 10);
  const angles = new Set<string>();
  const threats: string[] = [];
  for (const c of competitors) {
    if (c.landing?.valueProposition) {
      threats.push(`${c.domain}: ${c.landing.valueProposition}`);
    }
    (c.landing?.offers ?? []).forEach((o) => o && angles.add(o));
    (c.landing?.ctas ?? []).forEach((cta) => cta && angles.add(cta));
  }
  return {
    summary:
      "The AI summary couldn't be generated this time, so here's a data-derived plan built from the real numbers and teardowns above. The keyword gaps, forecast and competitor teardowns are all complete.",
    positioning: "",
    opportunities: topGaps.map(
      (g) =>
        `Target “${g.text}” — ${g.avgMonthlySearches.toLocaleString("en-US")} searches/mo, ${String(
          g.competition
        ).toLowerCase()} competition, covered by ${g.competitorsCovering.length} competitor(s).`
    ),
    threats: threats.slice(0, 6),
    recommendedKeywords: topGaps.map((g) => g.text),
    recommendedAngles: [...angles].slice(0, 8),
  };
}

// ---- schemas ----------------------------------------------------------------

const TEARDOWN_SCHEMA = {
  type: "object",
  properties: {
    valueProposition: { type: "string" },
    offers: { type: "array", items: { type: "string" } },
    ctas: { type: "array", items: { type: "string" } },
    trustSignals: { type: "array", items: { type: "string" } },
    toneNotes: { type: "string" },
  },
  required: ["valueProposition", "offers", "ctas", "trustSignals", "toneNotes"],
} as const;

const STRATEGY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    positioning: { type: "string" },
    opportunities: { type: "array", items: { type: "string" } },
    threats: { type: "array", items: { type: "string" } },
    recommendedKeywords: { type: "array", items: { type: "string" } },
    recommendedAngles: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary",
    "positioning",
    "opportunities",
    "threats",
    "recommendedKeywords",
    "recommendedAngles",
  ],
} as const;
