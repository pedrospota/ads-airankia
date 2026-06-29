// ============================================================================
// Windmill backend client (server-only).
//
// Calls the ported benchmark flow (windmill/f/benchmark/benchmark_suite) via
// Windmill's run-and-wait endpoint and normalises the raw output into the
// LabReport contract the UI consumes.
//
// Config via env (never sent to the browser — only the boolean "configured?"):
//   WINDMILL_URL        e.g. https://windmill.airankia.com
//   WINDMILL_WORKSPACE  e.g. airankia
//   WINDMILL_TOKEN      a Windmill API token (Bearer)
//   WINDMILL_FLOW_PATH  optional, defaults to f/benchmark/benchmark_suite
//
// SECURITY: the token is read here only and never logged or returned.
// ============================================================================

import type { LabAd, LabAdvertiser, LabQuery, LabReport, LabSource } from "./lab-types";
import { computeAnalytics } from "./lab-analytics";

const DEFAULT_FLOW_PATH = "f/benchmark/benchmark_suite";

function env() {
  return {
    url: process.env.WINDMILL_URL?.trim().replace(/\/+$/, "") || "",
    workspace: process.env.WINDMILL_WORKSPACE?.trim() || "",
    token: process.env.WINDMILL_TOKEN?.trim() || "",
    flowPath: process.env.WINDMILL_FLOW_PATH?.trim() || DEFAULT_FLOW_PATH,
  };
}

export function isWindmillConfigured(): boolean {
  const e = env();
  return Boolean(e.url && e.workspace && e.token);
}

// ---- raw flow shape (what the assemble step returns) -----------------------
type RawAd = {
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
};
type RawTransparency = {
  domain: string;
  region?: string;
  total_ads?: number;
  oldest_top5?: RawAd[];
  ads?: RawAd[];
};
type RawDiscoverAd = { title?: string | null; url?: string | null; domain?: string | null };
type RawFlowResult = {
  keyword: string;
  advertisers?: string[];
  discover_ads?: RawDiscoverAd[];
  transparency?: RawTransparency[];
  analyze?: { analysis?: string; model?: string; brand_language?: string };
};

function mapAd(raw: RawAd, viaKeyword: string): LabAd {
  return {
    advertiser: raw.advertiser ?? null,
    advertiserDomain: raw.target_domain ?? null,
    legalName: raw.legal_name ?? null,
    format: raw.format ?? null,
    firstShown: raw.first_shown ?? null,
    lastShown: raw.last_shown ?? null,
    daysActive: typeof raw.days_active === "number" ? raw.days_active : null,
    imageUrl: raw.image_url ?? null,
    detailsLink: raw.details_link ?? null,
    targetDomain: raw.target_domain ?? null,
    viaKeyword,
  };
}

/** Run the flow once per keyword (capped) and merge into a single LabReport. */
export async function runBenchmarkLab(query: LabQuery): Promise<LabReport> {
  const e = env();
  if (!isWindmillConfigured()) throw new Error("Windmill not configured");

  const keywords = query.keywords.slice(0, Math.max(1, query.numKeywords));
  const endpoint = `${e.url}/api/w/${e.workspace}/jobs/run_wait_result/${e.flowPath}`;

  const raws: RawFlowResult[] = [];
  for (const keyword of keywords) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${e.token}`,
      },
      body: JSON.stringify({
        keyword,
        geo_location: query.geo,
        region: query.region,
        mode: query.mode,
        brand_language: query.language,
        num_competitors: query.numCompetitors,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Windmill ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as RawFlowResult;
    raws.push({ ...data, keyword });
  }

  return mergeFlowResults(raws, query);
}

function mergeFlowResults(raws: RawFlowResult[], query: LabQuery): LabReport {
  const byDomain = new Map<string, LabAdvertiser>();

  for (const raw of raws) {
    const kw = raw.keyword;
    // headlines seen on the keyword (Oxylabs discovery), for sampleHeadline
    const headlineByDomain = new Map<string, RawDiscoverAd>();
    for (const d of raw.discover_ads ?? []) {
      if (d.domain && !headlineByDomain.has(d.domain)) headlineByDomain.set(d.domain, d);
    }

    // seed every discovered advertiser (even with zero transparency hits)
    for (const domain of raw.advertisers ?? []) {
      ensureAdvertiser(byDomain, domain, kw, headlineByDomain.get(domain));
    }

    // fold in transparency creatives
    for (const t of raw.transparency ?? []) {
      const adv = ensureAdvertiser(byDomain, t.domain, kw, headlineByDomain.get(t.domain));
      const ads = (t.ads ?? t.oldest_top5 ?? []).map((a) => mapAd(a, kw));
      adv.totalAds = Math.max(adv.totalAds, t.total_ads ?? ads.length);
      const merged = [...adv.oldestTop5, ...ads]
        .sort((a, b) => (b.daysActive ?? 0) - (a.daysActive ?? 0))
        .slice(0, 5);
      adv.oldestTop5 = merged;
    }
  }

  const advertisers = [...byDomain.values()]
    .sort((a, b) => b.totalAds - a.totalAds)
    .slice(0, query.numCompetitors);

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

  // combine per-keyword AI analyses under keyword headings
  const analyses = raws
    .map((r) => ({ kw: r.keyword, text: r.analyze?.analysis?.trim() || "" }))
    .filter((x) => x.text);
  const markdown =
    analyses.length === 1
      ? analyses[0].text
      : analyses.map((a) => `## Keyword: ${a.kw}\n\n${a.text}`).join("\n\n---\n\n");
  const model = raws.find((r) => r.analyze?.model)?.analyze?.model ?? "openrouter";

  const sources: LabSource[] = [
    {
      label: "Advertiser discovery",
      provider: "Oxylabs · google_ads",
      detail: `Real Google Search ads for ${raws.length} keyword(s) in ${query.countryName}`,
      live: true,
    },
    {
      label: "Ad creatives & age",
      provider: "SerpApi · Transparency Center",
      detail: "Active creatives per competitor domain, with first/last shown dates",
      live: true,
    },
    {
      label: "Strategic teardown",
      provider: `OpenRouter · ${model}`,
      detail: "Synthesis of headlines, CTAs, keyword gaps and recommendations",
      live: true,
    },
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
      keywordsAnalyzed: raws.length,
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
  discover?: RawDiscoverAd,
): LabAdvertiser {
  const key = domain.replace(/^www\./, "").toLowerCase();
  let adv = map.get(key);
  if (!adv) {
    adv = {
      domain: key,
      source: "oxylabs",
      totalAds: 0,
      oldestTop5: [],
      sampleHeadline: discover?.title ?? null,
      sampleUrl: discover?.url ?? null,
      viaKeywords: [],
    };
    map.set(key, adv);
  }
  if (!adv.viaKeywords.includes(keyword)) adv.viaKeywords.push(keyword);
  if (!adv.sampleHeadline && discover?.title) adv.sampleHeadline = discover.title;
  return adv;
}
