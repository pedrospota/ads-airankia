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
//   - Final analysis: OpenRouter with Pedro's exact system prompt
// ============================================================================

import { oxylabsKeywordAds } from "./oxylabs";
import { serpApiTransparency } from "./serpapi-transparency";
import { ocrImagesBatch } from "./firecrawl-ocr";
import { computeAnalytics } from "./lab-analytics";
import type {
  LabAd,
  LabAdvertiser,
  LabQuery,
  LabReport,
  LabSource,
  BenchmarkMode,
} from "./lab-types";
import type { BenchmarkCostContext } from "./types";

// Pedro's exact system prompt from analyze_benchmark.ts
const SYSTEM_PROMPT = `Act like a professional marketer doing a benchmark and uncovering competitors' Google Ads strategies.

You receive:
- a keyword or company/domain,
- the advertisers detected running ads (from Oxylabs google_ads when keyword mode),
- each advertiser's Transparency-Center ad creatives (from SerpApi).

Produce a structured benchmark in the brand's language with EXACTLY this format:

## Benchmark Report

**Total ads analyzed:** X
**Country analyzed:** [country or Global if no region filter]
**Average ad age:** X days

---

### Top 5 Oldest Ads (longest running)
For each: full image URL (https://tpc.googlesyndication.com/...) - X days active - landing URL

---

### Legal Entities Running Ads
List all advertiser legal names found.

---

### Ad Creatives Analysis
**Headlines & Descriptions:**
List each unique headline/description, how many ads contain it, percentage of total.

---

### Landing URLs
List all final destination URLs found in ads.

---

### Calls to Action
List CTAs found, with frequency and percentage.

---

### Keyword Recommendations (min 10)
Based on most-used terms in headlines/descriptions, list at least 10 keywords to use in Google Ads campaigns. Ranked by relevance.

---

### Brand Competitor Ads
Yes/No — are any ads targeting competitor brand keywords? List them if yes.

---

### Strategic Summary
Brief professional analysis of competitors' strategy.

IMPORTANT:
- Always return FULL image URLs like https://tpc.googlesyndication.com/archive/simgad/... NEVER return CR IDs like CR12154176544763281409
- Extract real landing/destination URLs from ad data
- Be concrete, use only real data provided, do not invent anything`;

function openRouterKey(): string | null {
  return process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_KEY?.trim() || null;
}

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
// OpenRouter analysis with Pedro's exact system prompt.
// Non-fatal — returns null if LLM call fails (deterministic data still returned).
// ---------------------------------------------------------------------------
async function analyzeWithOpenRouter(
  input: string,
  mode: BenchmarkMode,
  advertisers: string[],
  transparencyData: unknown[],
  ocrTexts: Record<string, string>,
  language: string
): Promise<{ model: string; markdown: string } | null> {
  const key = openRouterKey();
  if (!key) return null;

  const model = "anthropic/claude-opus-4-5";
  const payload = JSON.stringify(
    { input, mode, advertisers, transparency: transparencyData, ocr_texts: ocrTexts },
    null,
    2
  );

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `${SYSTEM_PROMPT}\n\nOutput language: ${language}.`,
          },
          { role: "user", content: `Benchmark data:\n${payload}` },
        ],
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const markdown = data?.choices?.[0]?.message?.content?.trim() ?? "";
    return markdown ? { model, markdown } : null;
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
async function runCompanyMode(
  query: LabQuery,
  cost: BenchmarkCostContext,
  regionOverride: string | null = null
): Promise<{ advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] }> {
  const byDomain = new Map<string, LabAdvertiser>();
  const rawForLlm: unknown[] = [];
  const allImageUrls: string[] = [];

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

    const result = await serpApiTransparency(cleanDomain, regionOverride, cost, 100);
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
  regionOverride: string | null = null
): Promise<{ advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] }> {
  const byDomain = new Map<string, LabAdvertiser>();
  const rawForLlm: unknown[] = [];
  const allImageUrls: string[] = [];

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
      serpApiTransparency(domain, regionOverride, cost, 100)
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

  // Step 3: Firecrawl OCR — all image URLs in parallel.
  if (allImageUrls.length > 0) {
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
  regionOverride: string | null = null   // null = global (don't send region to SerpApi)
): Promise<LabReport> {
  const costCtx: BenchmarkCostContext = cost ?? {
    userId: null, brandId: null, workspaceId: null, runId: null,
  };

  const mode: BenchmarkMode = query.mode;
  let result: { advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] };

  switch (mode) {
    case "company":
      result = await runCompanyMode(query, costCtx, regionOverride);
      break;
    case "extended":
      result = await runExtendedMode(query, costCtx, false, regionOverride);
      break;
    case "extended_company":
      result = await runExtendedMode(query, costCtx, true, regionOverride);
      break;
    case "keyword":
    default:
      result = await runKeywordMode(query, costCtx);
      break;
  }

  const { advertisers, rawData, allImageUrls } = result;

  // OCR texts already embedded in rawData for extended modes. Build a lookup for the LLM.
  const ocrEntry = rawData.find((d) => (d as Record<string, unknown>).step === "ocr") as
    | { texts?: Record<string, string> }
    | undefined;
  const ocrTexts = ocrEntry?.texts ?? {};

  // OpenRouter analysis.
  const inputLabel = query.keywords.join(", ");
  const analysis = await analyzeWithOpenRouter(
    inputLabel,
    mode,
    advertisers.map((a) => a.domain),
    rawData,
    ocrTexts,
    query.language
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
