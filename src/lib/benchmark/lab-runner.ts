// ============================================================================
// In-app Benchmark Lab runner — the n8n pipeline without Windmill.
//
// Implements the same flow as windmill/f/benchmark/benchmark_suite:
//   1. Oxylabs → keyword → advertiser domains (real Google Ads SERP)
//   2. SerpApi → per-domain Transparency-Center creatives + age
//   3. OpenRouter → AI competitive teardown (same system prompt as the n8n agent)
//   4. Merge → LabReport (same shape as windmill.ts mergeFlowResults)
//
// Active when OXYLABS_USERNAME + SERPAPI_KEY are set in env.
// Reads OPENROUTER_API_KEY for the LLM step (optional but recommended).
//
// GATE: this file never calls oxylabsKeywordAds or serpApiTransparency directly
// without OXYLABS/SERPAPI credentials — the configured() checks act as a hard
// gate just like adSpyAllowedForRun() does in the engine.
// ============================================================================

import { oxylabsKeywordAds, oxylabsConfigured } from "./oxylabs";
import { serpApiTransparency, serpApiConfigured } from "./serpapi-transparency";
import { computeAnalytics } from "./lab-analytics";
import type {
  LabAd,
  LabAdvertiser,
  LabQuery,
  LabReport,
  LabSource,
} from "./lab-types";
import type { BenchmarkCostContext } from "./types";

// Mirrors the n8n "benchmark agent" system prompt (analyze_benchmark.ts).
const ANALYSIS_SYSTEM = `Act like a professional marketer doing a benchmark and uncovering competitors' Google Ads strategies.

You receive:
- a keyword,
- the advertisers detected running ads on that keyword (from Oxylabs google_ads),
- each advertiser's Transparency-Center ad creatives (from SerpApi).

Produce a structured benchmark in the brand's language:
- total ads, country analyzed, average ad age
- TOP 5 OLDEST ads: FULL image URL if available, each with days active
- the landing / final URLs each ad points to
- calls to action
- possible keywords used in their campaigns
- legal entity names running the ads
- headlines & descriptions: in how many ads each appears, with PERCENTAGES and totals
- a keyword-recommendation ranking: at least 10 keywords mined from the most-used headline/description terms, to use in Google Ads campaigns
- whether they run brand-competitor ads

Be concrete and use only the real data provided. Do not invent ad IDs or URLs.`;

function openRouterKey(): string | null {
  return (
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.OPENROUTER_KEY?.trim() ||
    null
  );
}

/** True when Oxylabs + SerpApi are both configured (minimum for a live lab run). */
export function labRunnerConfigured(): boolean {
  return oxylabsConfigured() && serpApiConfigured();
}

// ---------------------------------------------------------------------------
// OpenRouter analysis — same model + prompt as the windmill script.
// Non-fatal: if the LLM call fails, we still return the deterministic data.
// ---------------------------------------------------------------------------
async function analyzeWithOpenRouter(
  keyword: string,
  mode: string,
  advertisers: string[],
  transparency: unknown[],
  brandLanguage: string
): Promise<{ model: string; markdown: string } | null> {
  const key = openRouterKey();
  if (!key) return null;
  const model = "anthropic/claude-opus-4-5";
  try {
    const payload = JSON.stringify({ keyword, mode, advertisers, transparency }, null, 2);
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `${ANALYSIS_SYSTEM}\n\nBrand language for the output: ${brandLanguage}.`,
          },
          { role: "user", content: `Benchmark data:\n${payload}` },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const markdown = data?.choices?.[0]?.message?.content?.trim() ?? "";
    if (!markdown) return null;
    return { model, markdown };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Map SerpApi transparency creatives to LabAd (the UI-facing shape).
// ---------------------------------------------------------------------------
interface RawTransparencyAd {
  advertiser?: string | null;
  advertiser_id?: string | null;
  legal_name?: string | null;
  target_domain?: string | null;
  format?: string | null;
  first_shown?: string | null;
  last_shown?: string | null;
  days_active?: number | null;
  image_url?: string | null;
  details_link?: string | null;
  headline?: string | null;
  body?: string | null;
  cta?: string | null;
}

function serpAdToLabAd(
  ad: { format?: string; headline?: string; body?: string; destinationUrl?: string; firstShown?: string; lastShown?: string },
  domain: string,
  keyword: string,
  idx: number
): LabAd {
  return {
    advertiser: null,
    advertiserDomain: domain,
    legalName: null,
    format: ad.format ?? "text",
    firstShown: ad.firstShown ?? null,
    lastShown: ad.lastShown ?? null,
    daysActive: null, // SerpApi transparency gives first/last shown dates; daysActive computed on full response
    imageUrl: null,
    detailsLink: null,
    targetDomain: domain,
    viaKeyword: keyword,
    headline: ad.headline ?? null,
    cta: null,
  };
}

// ---------------------------------------------------------------------------
// Main runner — one call per keyword, merged into a single LabReport.
// ---------------------------------------------------------------------------
export async function runBenchmarkLabInApp(
  query: LabQuery,
  cost?: BenchmarkCostContext
): Promise<LabReport> {
  const costCtx: BenchmarkCostContext = cost ?? {
    userId: null, brandId: null, workspaceId: null, runId: null,
  };

  const keywords = query.keywords.slice(0, Math.max(1, query.numKeywords));
  const byDomain = new Map<string, LabAdvertiser>();

  // Per-keyword raw data (for OpenRouter analysis).
  const perKwRaw: {
    keyword: string;
    advertisers: string[];
    transparencyData: unknown[];
  }[] = [];

  for (const keyword of keywords) {
    // Step 1: Oxylabs → who's advertising on this keyword.
    const oxResult = await oxylabsKeywordAds(keyword, query.geo, costCtx);

    // Seed every discovered advertiser.
    const headlineByDomain = new Map<string, string>();
    for (const ad of oxResult.ads) {
      if (ad.domain && !headlineByDomain.has(ad.domain) && ad.title) {
        headlineByDomain.set(ad.domain, ad.title);
      }
    }

    const discoveredDomains = oxResult.advertisers.slice(0, query.numCompetitors);
    for (const domain of discoveredDomains) {
      ensureAdvertiser(byDomain, domain, keyword, headlineByDomain.get(domain) ?? null);
    }

    // Step 2: SerpApi → creatives for each discovered domain.
    const transparencyData: unknown[] = [];
    for (const domain of discoveredDomains) {
      const tResult = await serpApiTransparency(domain, query.region, costCtx, 12);
      const adv = ensureAdvertiser(byDomain, domain, keyword, headlineByDomain.get(domain) ?? null);

      const serpAds = tResult.ads.map((a, i) => serpAdToLabAd(a, domain, keyword, i));
      adv.totalAds = Math.max(adv.totalAds, tResult.totalAds);
      const merged = [...adv.oldestTop5, ...serpAds]
        .sort((a, b) => (b.daysActive ?? 0) - (a.daysActive ?? 0))
        .slice(0, 5);
      adv.oldestTop5 = merged;
      transparencyData.push({ targetDomain: domain, ...tResult });
    }

    perKwRaw.push({ keyword, advertisers: discoveredDomains, transparencyData });
  }

  // Trim to numCompetitors, sorted by totalAds.
  const advertisers = [...byDomain.values()]
    .sort((a, b) => b.totalAds - a.totalAds)
    .slice(0, query.numCompetitors);

  // Step 3: OpenRouter analysis — one per keyword, merged under headings.
  const analyses: { kw: string; text: string; model: string }[] = [];
  for (const raw of perKwRaw) {
    const result = await analyzeWithOpenRouter(
      raw.keyword,
      query.mode,
      raw.advertisers,
      raw.transparencyData,
      query.language
    );
    if (result) {
      analyses.push({ kw: raw.keyword, text: result.markdown, model: result.model });
    }
  }
  const model = analyses[0]?.model ?? "openrouter";
  const markdown =
    analyses.length === 0
      ? null
      : analyses.length === 1
        ? analyses[0].text
        : analyses.map((a) => `## Keyword: ${a.kw}\n\n${a.text}`).join("\n\n---\n\n");

  // Aggregate stats.
  const allAds = advertisers.flatMap((a) => a.oldestTop5);
  const topOldestAds = [...allAds]
    .sort((a, b) => (b.daysActive ?? 0) - (a.daysActive ?? 0))
    .slice(0, 6);
  const totalAds = advertisers.reduce((n, a) => n + a.totalAds, 0);
  const daysList = allAds.map((a) => a.daysActive ?? 0).filter((n) => n > 0);
  const avgDaysActive = daysList.length
    ? Math.round(daysList.reduce((s, n) => s + n, 0) / daysList.length)
    : 0;
  const oldestDays = daysList.length ? Math.max(...daysList) : 0;

  const sources: LabSource[] = [
    {
      label: "Advertiser discovery",
      provider: "Oxylabs · google_ads",
      detail: `Real Google Search ads for ${keywords.length} keyword(s) in ${query.countryName}`,
      live: true,
    },
    {
      label: "Ad creatives & age",
      provider: "SerpApi · Transparency Center",
      detail: "Active creatives per competitor domain, with first/last shown dates",
      live: true,
    },
    ...(markdown
      ? [
          {
            label: "Strategic teardown",
            provider: `OpenRouter · ${model}`,
            detail:
              "Synthesis of headlines, CTAs, keyword gaps and recommendations",
            live: true,
          },
        ]
      : []),
  ];

  return {
    generatedAt: new Date().toISOString(),
    demo: false,
    query,
    summary: {
      advertisers: advertisers.length,
      totalAds,
      avgDaysActive,
      oldestDays,
      keywordsAnalyzed: keywords.length,
    },
    advertisers,
    topOldestAds,
    analytics: computeAnalytics(advertisers, query),
    analysis: markdown ? { model, language: query.language, markdown } : null,
    sources,
  };
}

function ensureAdvertiser(
  map: Map<string, LabAdvertiser>,
  domain: string,
  keyword: string,
  headline: string | null
): LabAdvertiser {
  const key = domain.replace(/^www\./, "").toLowerCase();
  let adv = map.get(key);
  if (!adv) {
    adv = {
      domain: key,
      source: "oxylabs",
      totalAds: 0,
      oldestTop5: [],
      sampleHeadline: headline,
      sampleUrl: null,
      viaKeywords: [],
    };
    map.set(key, adv);
  }
  if (!adv.viaKeywords.includes(keyword)) adv.viaKeywords.push(keyword);
  if (!adv.sampleHeadline && headline) adv.sampleHeadline = headline;
  return adv;
}
