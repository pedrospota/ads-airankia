// ============================================================================
// In-app Benchmark Lab runner — 4 exact modes matching Pedro's n8n workflow.
//
// MODES:
//   keyword          → Oxylabs (keyword → ads + domains) only
//   company          → SerpApi Transparency (domain → creatives) only
//   extended         → Oxylabs → discover domains → SerpApi + Firecrawl OCR in parallel
//   extended_company → SerpApi + Firecrawl OCR (skip keyword search)
//
// TOOLS (exactly 3, matching the n8n nodes):
//   1. Oxylabs realtime.oxylabs.io — source:google_ads (keyword → advertisers)
//   2. SerpApi serpapi.com/search — engine:google_ads_transparency_center (domain → creatives)
//   3. Firecrawl OCR — ocr_image_simple_text (image URL → text)
//
// RULES:
//   - SerpApi: NO region by default (global) unless user asks
//   - Transparency report: only accepts DOMAINS, not company names
//   - Always return full image URLs (tpc.googlesyndication.com/...) never CR IDs
//   - Top 5 oldest ads by days_active
//   - Firecrawl OCR called in parallel on all image URLs
//   - Final analysis: the app's unified LLM layer (model/provider per /admin)
// ============================================================================

import { oxylabsKeywordAds } from "./oxylabs";
import { serpApiTransparency, type SerpApiTransparencyOpts } from "./serpapi-transparency";
import { ocrImagesBatch } from "./firecrawl-ocr";
import { computeAnalytics } from "./lab-analytics";
import { benchmarkLlm } from "./llm";
import type {
  LabAd,
  LabAdvertiser,
  LabQuery,
  LabReport,
  LabSource,
  BenchmarkMode,
} from "./lab-types";
import type { BenchmarkCostContext } from "./types";

// Senior-strategist benchmark prompt — produces the rich, decision-ready report
// format (landscape → per-competitor teardown → copy analysis → keyword mining →
// positioning map), in the brand's language, from the real Oxylabs + SerpApi +
// OCR data only.
const SYSTEM_PROMPT = `Act like a senior performance-marketing strategist running a competitor benchmark to uncover rivals' Google Ads strategies. You receive RAW JSON from up to three real data sources:
- Oxylabs (source: google_ads): the live PAID results on a keyword. Each ad has: title (headline), description (desc), landing page (url), root destination (destinationUrl), the decoded campaign + campaignLabel + targetedKeyword + matchType from the tracking URL, sitelinks, and position/positionOverall.
- SerpApi (engine: google_ads_transparency_center): a domain's active ad creatives, each with first_shown/last_shown, total_days_shown (age in days), format, the FULL creative image URL, the advertiser legal name, and target_domain.
- Firecrawl OCR: the text extracted from each ad image (keyed by image URL).

Write the report in the brand's language. Use GitHub-flavored Markdown. Use ONLY the real data provided — never invent advertisers, numbers, URLs or quotes. If a field is missing, omit it gracefully. Produce EXACTLY these sections, in this order:

# Competitive Intelligence Report

## Competitive Landscape Overview
Country analyzed · search query (or domain) · total ads found · total unique competitors (domains) · average ad age in days (ONLY when transparency data is present).

## Top Competitors & Their Ad Strategies
For EACH competitor (ranked by ad presence / position) a compact table with rows: Ad Position, Main Headline, Description, Landing Page, Campaign Label (decoded from the tracking URL when present), Key USPs, Sitelinks, Calls to Action detected.

## Top 5 Oldest Ads (longest-running = proven winners)
ONLY when transparency data is present. For each: the FULL creative image URL (https://tpc.googlesyndication.com/...), days active, advertiser, landing URL, and any text extracted from the image via OCR.

## Ad Copy & Headlines Analysis
A "Most Used Words in Headlines" table (Word | Frequency | % of ads) and a "Most Used Words in Descriptions" table (Word | Frequency | % of ads). Exclude generic stopwords.

## Keyword Ranking Recommendations
At least 10 keywords mined from the most-used terms across headlines/descriptions and the targetedKeyword fields. Split into High-Priority and Niche, ranked by commercial intent.

## Brand vs. Competitor Strategy
State Yes/No whether any advertiser bids on competitor brand terms or positions against rivals, with the evidence.

## Landing Page Strategy Insights
Table: Competitor | Landing Page | Offer / Strategy.

## Strategic Recommendations
Headlines that win (patterns from the winners) · description angles to test · sitelinks you need · gaps to exploit (what NO competitor is doing).

## Competitive Positioning Map
A simple ASCII quadrant placing the competitors (e.g. feature complexity vs price, or breadth vs speed).

## Legal Entities / Brands Running Ads
Every advertiser domain with its legal entity name (from transparency advertiser_legal_name when available).

HARD RULES:
- ALWAYS output FULL image URLs (https://tpc.googlesyndication.com/archive/simgad/...). NEVER output CR IDs like CR12154176544763281409.
- Extract the real landing/destination URLs and campaign labels from the data.
- Percentages must be computed from the real counts.
- Keep it concrete and decision-ready — the kind of teardown a strategist hands a client.`;

// Single-string structured output so the report flows through callStructured()
// (which enforces provider routing, deadlines and cost metering) cleanly.
const REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    report: {
      type: "string",
      description:
        "The complete competitor-intelligence benchmark report in GitHub-flavored Markdown, in the brand's language, following the exact section structure from the system prompt.",
    },
  },
  required: ["report"],
};

export function labRunnerConfigured(): boolean {
  const hasOxylabs =
    Boolean(process.env.OXYLABS_USERNAME?.trim() || process.env.OXYLABS_USER?.trim());
  const hasSerpApi =
    Boolean(process.env.SERPAPI_KEY?.trim() || process.env.SERPAPI_API_KEY?.trim());
  // keyword/extended need Oxylabs; company/extended_company only need SerpApi.
  // We report as configured if either is available.
  return hasOxylabs || hasSerpApi;
}

// ---------------------------------------------------------------------------
// SerpApi raw creative shape (what comes back from the API).
// ---------------------------------------------------------------------------
interface RawTransCreative {
  advertiser?: string | null;
  advertiser_id?: string | null;
  advertiser_legal_name?: string | null;
  legal_name?: string | null;
  target_domain?: string | null;
  format?: string | null;
  first_shown?: string | null;
  first_shown_date?: string | null;
  last_shown?: string | null;
  last_shown_date?: string | null;
  total_days_shown?: number | null;
  days?: number | null;
  // Full image URL — we want THIS, not the CR id.
  image?: string | null;
  thumbnail?: string | null;
  preview?: string | null;
  // Detail / landing links.
  details_link?: string | null;
  link?: string | null;
  final_url?: string | null;
  url?: string | null;
  // Creative text.
  headline?: string | null;
  description?: string | null;
  body?: string | null;
}

function rawToLabAd(c: RawTransCreative, domain: string, keyword: string): LabAd & {
  imageUrlRaw?: string; daysActive: number | null; legalNameRaw?: string | null;
} {
  const daysActive =
    typeof c.total_days_shown === "number"
      ? c.total_days_shown
      : typeof c.days === "number"
        ? c.days
        : null;

  // Full image URL — prefer the actual image, NOT the CR id format.
  const imageUrl =
    (c.image?.startsWith("http") ? c.image : null) ??
    (c.thumbnail?.startsWith("http") ? c.thumbnail : null) ??
    (c.preview?.startsWith("http") ? c.preview : null) ??
    null;

  const landingUrl =
    c.final_url ?? c.url ?? c.details_link ?? c.link ?? null;

  return {
    advertiser: c.advertiser ?? null,
    advertiserDomain: c.target_domain ?? domain,
    legalName: c.advertiser_legal_name ?? c.legal_name ?? null,
    legalNameRaw: c.advertiser_legal_name ?? c.legal_name ?? null,
    format: c.format ?? "text",
    firstShown: c.first_shown ?? c.first_shown_date ?? null,
    lastShown: c.last_shown ?? c.last_shown_date ?? null,
    daysActive,
    imageUrl,
    imageUrlRaw: imageUrl ?? undefined,
    detailsLink: landingUrl,
    targetDomain: c.target_domain ?? domain,
    viaKeyword: keyword,
    headline: c.headline ?? null,
    cta: null,
  };
}

// ---------------------------------------------------------------------------
// Strategic teardown via the app's unified LLM layer (model/provider per /admin,
// cost metered). Non-fatal — returns null if the LLM call fails so the
// deterministic dashboard data is still returned.
// ---------------------------------------------------------------------------
async function analyze(
  query: LabQuery,
  mode: BenchmarkMode,
  advertiserDomains: string[],
  rawData: unknown[],
  cost: BenchmarkCostContext
): Promise<{ model: string; markdown: string } | null> {
  try {
    const data = await benchmarkLlm<{ report: string }>({
      tier: "opus",
      system: `${SYSTEM_PROMPT}\n\nOutput language: ${query.language}.`,
      prompt:
        `INPUT: ${query.keywords.join(", ")}\n` +
        `MODE: ${mode}\n` +
        `COUNTRY: ${query.countryName}\n` +
        `COMPETITOR DOMAINS: ${advertiserDomains.join(", ") || "(discovered from the data below)"}\n\n` +
        `RAW DATA (Oxylabs google_ads + SerpApi transparency + Firecrawl OCR):\n` +
        JSON.stringify(rawData, null, 2),
      schema: REPORT_SCHEMA,
      toolName: "deliver_benchmark_report",
      toolDescription: "Return the finished competitor-intelligence benchmark report as Markdown.",
      maxTokens: 8000,
      stage: "benchmark_report",
      cost,
    });
    const markdown = data?.report?.trim() ?? "";
    return markdown ? { model: "Claude · Opus tier (provider per /admin)", markdown } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MODE: keyword — Oxylabs only.
// Input: a keyword. Returns structured report of who's advertising on it.
// ---------------------------------------------------------------------------
async function runKeywordMode(
  query: LabQuery,
  cost: BenchmarkCostContext
): Promise<{ advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] }> {
  const byDomain = new Map<string, LabAdvertiser>();
  const rawForLlm: unknown[] = [];
  const allImageUrls: string[] = [];

  for (const keyword of query.keywords) {
    const result = await oxylabsKeywordAds(keyword, query.geo, cost);
    rawForLlm.push(result);

    for (const ad of result.ads) {
      if (!ad.domain) continue;
      const key = ad.domain.replace(/^www\./, "").toLowerCase();
      let adv = byDomain.get(key);
      if (!adv) {
        adv = {
          domain: key,
          source: "oxylabs",
          totalAds: 0,
          oldestTop5: [],
          sampleHeadline: ad.title ?? null,
          sampleUrl: ad.url ?? null,
          viaKeywords: [],
        };
        byDomain.set(key, adv);
      }
      if (!adv.viaKeywords.includes(keyword)) adv.viaKeywords.push(keyword);
      adv.totalAds++;

      // Build a LabAd from the Oxylabs ad (no transparency data here).
      const labAd: LabAd = {
        advertiser: ad.title ?? null,
        advertiserDomain: key,
        legalName: null,
        format: "text",
        firstShown: null,
        lastShown: null,
        daysActive: null,
        imageUrl: null,
        detailsLink: ad.url ?? null,
        targetDomain: key,
        viaKeyword: keyword,
        headline: ad.title ?? null,
        cta: null,
      };
      if (adv.oldestTop5.length < 5) adv.oldestTop5.push(labAd);
    }
  }

  return {
    advertisers: [...byDomain.values()].slice(0, query.numCompetitors),
    rawData: rawForLlm,
    allImageUrls,
  };
}

// ---------------------------------------------------------------------------
// MODE: company — SerpApi Transparency only.
// Input: domain(s). Returns creatives for each domain.
// NOTE: Transparency report ONLY accepts domains, not company names.
// ---------------------------------------------------------------------------

// Resolve the effective Transparency params for a run: manual values from the
// Lab's advanced panel win; otherwise NO region (global) per Pedro's rule.
function serpParamsFor(
  query: LabQuery,
  regionOverride: string | null
): { region: string | null; num: number; opts: SerpApiTransparencyOpts } {
  const t = query.transparency ?? {};
  return {
    region: (t.region && t.region.trim()) || regionOverride || null,
    num: t.num ?? 100,
    opts: {
      platform: t.platform ?? null,
      creativeFormat: t.creativeFormat ?? null,
      advertiserId: t.advertiserId ?? null,
      startDate: t.startDate ?? null,
      endDate: t.endDate ?? null,
      num: t.num ?? null,
    },
  };
}

async function runCompanyMode(
  query: LabQuery,
  cost: BenchmarkCostContext,
  regionOverride: string | null = null
): Promise<{ advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] }> {
  const byDomain = new Map<string, LabAdvertiser>();
  const rawForLlm: unknown[] = [];
  const allImageUrls: string[] = [];
  const { region, num, opts } = serpParamsFor(query, regionOverride);

  // In company mode, the "keywords" field holds the domain(s) to look up.
  const domains = query.keywords.slice(0, query.numCompetitors);

  for (const domain of domains) {
    // Clean to bare domain (transparency only accepts domains).
    const cleanDomain = domain
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .toLowerCase()
      .trim();

    const result = await serpApiTransparency(cleanDomain, region, cost, num, opts);
    const rawAds = result.rawCreatives as RawTransCreative[];

    const labAds: LabAd[] = rawAds.map((c) => {
      const ad = rawToLabAd(c, cleanDomain, cleanDomain);
      if (ad.imageUrl) allImageUrls.push(ad.imageUrl);
      return ad;
    });

    // Sort oldest-first.
    labAds.sort((a, b) => (b.daysActive ?? 0) - (a.daysActive ?? 0));

    const adv: LabAdvertiser = {
      domain: cleanDomain,
      source: "serpapi",
      totalAds: result.totalAds,
      oldestTop5: labAds.slice(0, 5),
      sampleHeadline: labAds[0]?.headline ?? null,
      sampleUrl: labAds[0]?.detailsLink ?? null,
      viaKeywords: [cleanDomain],
    };
    byDomain.set(cleanDomain, adv);

    rawForLlm.push({
      domain: cleanDomain,
      total_ads: result.totalAds,
      region: result.region,
      ads: rawAds,
    });
  }

  return {
    advertisers: [...byDomain.values()],
    rawData: rawForLlm,
    allImageUrls,
  };
}

// ---------------------------------------------------------------------------
// MODE: extended — Oxylabs keyword search → discover domains → SerpApi + OCR.
// MODE: extended_company — SerpApi + OCR only (no keyword search step).
// ---------------------------------------------------------------------------
async function runExtendedMode(
  query: LabQuery,
  cost: BenchmarkCostContext,
  skipKeywordSearch: boolean,
  regionOverride: string | null = null,
  skipOcr = false
): Promise<{ advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] }> {
  const byDomain = new Map<string, LabAdvertiser>();
  const rawForLlm: unknown[] = [];
  const allImageUrls: string[] = [];
  const { region, num, opts } = serpParamsFor(query, regionOverride);

  let discoveredDomains: string[] = [];

  if (!skipKeywordSearch) {
    // Step 1: Oxylabs — keyword → advertiser domains.
    for (const keyword of query.keywords) {
      const result = await oxylabsKeywordAds(keyword, query.geo, cost);
      rawForLlm.push({ step: "oxylabs", ...result });
      for (const domain of result.advertisers) {
        if (!discoveredDomains.includes(domain)) discoveredDomains.push(domain);
      }
    }
    discoveredDomains = discoveredDomains.slice(0, query.numCompetitors);
  } else {
    // extended_company: use keywords as domain list directly.
    discoveredDomains = query.keywords
      .map((k) =>
        k.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase().trim()
      )
      .filter(Boolean)
      .slice(0, query.numCompetitors);
  }

  // Step 2: SerpApi Transparency per domain + collect image URLs — in parallel.
  const transparencyResults = await Promise.all(
    discoveredDomains.map((domain) =>
      serpApiTransparency(domain, region, cost, num, opts)
    )
  );

  // Collect all image URLs for OCR batch.
  const imageUrlsByDomain = new Map<string, string[]>();
  for (let i = 0; i < discoveredDomains.length; i++) {
    const domain = discoveredDomains[i];
    const result = transparencyResults[i];
    const rawAds = result.rawCreatives as RawTransCreative[];
    const domainImages: string[] = [];

    const labAds: LabAd[] = rawAds.map((c) => {
      const ad = rawToLabAd(c, domain, query.keywords[0] ?? domain);
      if (ad.imageUrl) {
        domainImages.push(ad.imageUrl);
        allImageUrls.push(ad.imageUrl);
      }
      return ad;
    });

    labAds.sort((a, b) => (b.daysActive ?? 0) - (a.daysActive ?? 0));
    imageUrlsByDomain.set(domain, domainImages);

    byDomain.set(domain, {
      domain,
      source: "serpapi",
      totalAds: result.totalAds,
      oldestTop5: labAds.slice(0, 5),
      sampleHeadline: labAds[0]?.headline ?? null,
      sampleUrl: labAds[0]?.detailsLink ?? null,
      viaKeywords: [query.keywords[0] ?? domain],
    });

    rawForLlm.push({
      step: "serpapi",
      domain,
      total_ads: result.totalAds,
      region: result.region,
      ads: rawAds,
    });
  }

  // Step 3: Firecrawl OCR — all image URLs in parallel. Skippable (the brand
  // benchmark runs Oxylabs→domains→transparency only, no OCR).
  if (!skipOcr && allImageUrls.length > 0) {
    const ocrMap = await ocrImagesBatch(allImageUrls);
    rawForLlm.push({
      step: "ocr",
      texts: Object.fromEntries(ocrMap),
    });
  }

  return {
    advertisers: [...byDomain.values()],
    rawData: rawForLlm,
    allImageUrls,
  };
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------
export async function runBenchmarkLabInApp(
  query: LabQuery,
  cost?: BenchmarkCostContext,
  regionOverride: string | null = null,   // null = global (don't send region to SerpApi)
  opts?: { skipOcr?: boolean }
): Promise<LabReport> {
  const costCtx: BenchmarkCostContext = cost ?? {
    userId: null, brandId: null, workspaceId: null, runId: null,
  };

  const mode: BenchmarkMode = query.mode;
  const skipOcr = opts?.skipOcr ?? false;
  let result: { advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] };

  switch (mode) {
    case "company":
      result = await runCompanyMode(query, costCtx, regionOverride);
      break;
    case "extended":
      result = await runExtendedMode(query, costCtx, false, regionOverride, skipOcr);
      break;
    case "extended_company":
      result = await runExtendedMode(query, costCtx, true, regionOverride, skipOcr);
      break;
    case "keyword":
    default:
      result = await runKeywordMode(query, costCtx);
      break;
  }

  const { advertisers, rawData, allImageUrls } = result;

  // Strategic teardown via the unified LLM layer (OCR text is already embedded
  // in rawData for the extended modes, so the model sees it directly).
  const analysis = await analyze(
    query,
    mode,
    advertisers.map((a) => a.domain),
    rawData,
    costCtx
  );

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

  const sources: LabSource[] = [];
  if (mode === "keyword" || mode === "extended") {
    sources.push({
      label: "Keyword ad discovery",
      provider: "Oxylabs · google_ads",
      detail: `Real Google Search ads for: ${query.keywords.join(", ")} in ${query.countryName}`,
      live: true,
    });
  }
  if (mode !== "keyword") {
    sources.push({
      label: "Ad creatives & age",
      provider: "SerpApi · Transparency Center",
      detail: `Active creatives per domain${regionOverride ? ` · region ${regionOverride}` : " · global"}`,
      live: true,
    });
  }
  if ((mode === "extended" || mode === "extended_company") && allImageUrls.length > 0) {
    sources.push({
      label: "Ad image text (OCR)",
      provider: "Firecrawl · ocr_image_simple_text",
      detail: `Text extracted from ${allImageUrls.length} ad image(s) in parallel`,
      live: true,
    });
  }
  if (analysis) {
    sources.push({
      label: "Strategic teardown",
      provider: `OpenRouter · ${analysis.model}`,
      detail: "Professional competitor analysis per Pedro's benchmark spec",
      live: true,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    demo: false,
    query,
    summary: {
      advertisers: advertisers.length,
      totalAds,
      avgDaysActive,
      oldestDays,
      keywordsAnalyzed: query.keywords.length,
    },
    advertisers,
    topOldestAds,
    analytics: computeAnalytics(advertisers, query),
    analysis: analysis ? { model: analysis.model, language: query.language, markdown: analysis.markdown } : null,
    sources,
  };
}
