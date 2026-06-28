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
  type KeywordPlanIdea,
} from "@/lib/google-ads";
import { languageName } from "@/lib/engine/types";
import { benchmarkLlm } from "./llm";
import { getBenchmarkConfig } from "./config";
import { fetchCompetitorAds } from "./searchapi";
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
}): Promise<string> {
  const { ctx, entryMode } = input;
  const config = await getBenchmarkConfig();

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
      liveEnabled: config.liveEnabled,
      progress: 0,
    })
    .returning({ id: benchmarkRuns.id });

  const runId = row.id;

  // Fire-and-forget. The job marks the run failed on any uncaught error.
  void runBenchmark(runId, ctx, {
    keywords: seedKeywords,
    domains: seedDomains.slice(0, config.maxCompetitors),
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
  seeds: { keywords: string[]; domains: string[] }
): Promise<void> {
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

  // ---- 1. Brand's own keyword footprint (URL-seeded + any manual keyword) ----
  await stage(runId, "Mapping your keyword footprint", 12);
  const brandIdeas = await generateKeywordIdeas({
    keywordSeeds: seeds.keywords.length ? seeds.keywords : undefined,
    urlSeed: ctx.website ?? undefined,
    languageCode: lang,
    countryCodes: [country],
    costContext: cost,
  });
  const brandKeywords = topByVolume(brandIdeas.map(toBenchmarkKeyword), 60);
  const brandKwSet = new Set(brandKeywords.map((k) => normKw(k.text)));
  await emitBenchmarkEvent(runId, "partial", {
    kind: "brandKeywords",
    count: brandKeywords.length,
  });

  // ---- 2. Per-competitor analysis -------------------------------------------
  const competitors: BenchmarkCompetitor[] = [];
  const domains = seeds.domains.slice(0, config.maxCompetitors);
  const spanStart = 18;
  const spanEnd = 72;

  for (let i = 0; i < domains.length; i++) {
    const domain = domains[i];
    const progress =
      spanStart + Math.round(((i + 0.5) / Math.max(1, domains.length)) * (spanEnd - spanStart));
    await stage(
      runId,
      `Analyzing competitor ${i + 1} of ${domains.length}: ${domain}`,
      progress
    );

    const comp = await analyzeCompetitor(domain, ctx, country, cost);
    competitors.push(comp);
    await emitBenchmarkEvent(runId, "partial", { kind: "competitor", competitor: comp });
  }

  // ---- 3. Keyword gaps (competitor footprint minus brand footprint) ----------
  await stage(runId, "Finding keyword gaps", 78);
  const keywordGaps = computeKeywordGaps(competitors, brandKwSet);
  await emitBenchmarkEvent(runId, "partial", { kind: "gaps", count: keywordGaps.length });

  // ---- 4. AI strategy synthesis ---------------------------------------------
  await stage(runId, "Writing your strategy", 90);
  let strategy: BenchmarkStrategy;
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
    strategy = {
      summary:
        "We gathered the competitor data below, but the AI summary couldn't be generated this time. The keyword gaps and landing teardowns are still complete.",
      positioning: "",
      opportunities: [],
      threats: [],
      recommendedKeywords: keywordGaps.slice(0, 10).map((g) => g.text),
      recommendedAngles: [],
    };
    console.error("[benchmark] strategy synthesis failed", runId, e);
  }

  // ---- 5. Assemble + persist -------------------------------------------------
  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    language: lang,
    country,
    brand: { name: ctx.name, website: ctx.website, domain: ctx.domain },
    brandKeywords,
    competitors,
    keywordGaps,
    strategy,
    spendSummary: summarizeSpend(competitors.map((c) => c.spend)),
    meta: {
      liveAdSpy: competitors.some((c) => c.adsStatus === "ok"),
      domainsAnalyzed: competitors.length,
      keywordsDiscovered:
        brandKeywords.length +
        competitors.reduce((n, c) => n + c.keywords.length, 0),
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
  cost: BenchmarkCostContext
): Promise<BenchmarkCompetitor> {
  const notes: string[] = [];

  // Keyword footprint via KP (URL seed). Free, never throws.
  const ideas = await generateKeywordIdeas({
    urlSeed: `https://${domain}`,
    languageCode: ctx.languageCode,
    countryCodes: [country],
    costContext: cost,
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

  // Ad-spy (PAID, gated OFF by default — returns status "off" without spending).
  const adResult = await fetchCompetitorAds(domain, country, cost);

  const comp: BenchmarkCompetitor = {
    domain,
    source: "brand_profile",
    keywords,
    totalVolume,
    landing,
    ads: adResult.ads,
    adsStatus: adResult.status,
    notes,
  };
  // Modeled monthly investment from the (free) KP volumes × CPC. Null when the
  // footprint carries no CPC bids (nothing monetizable to estimate).
  comp.spend = estimateCompetitorSpend(comp);
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
  const compLines = competitors.map((c) => {
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
    .slice(0, 25)
    .map(
      (g) =>
        `• ${g.text} — ${g.avgMonthlySearches}/mo, ${g.competition} competition, covered by ${g.competitorsCovering.length} competitor(s)`
    );

  const prompt = [
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

  return benchmarkLlm<BenchmarkStrategy>({
    tier: "opus",
    stage: "strategy",
    cost,
    temperature: 0.4,
    maxTokens: 4000,
    toolName: "submit_strategy",
    toolDescription: "Return the structured competitor strategy.",
    schema: STRATEGY_SCHEMA,
    system: `You are the head of paid search at a top agency, writing a premium competitor-analysis brief for a client. Be specific and decisive. Write EVERYTHING in ${langLabel}.`,
    prompt,
  });
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
