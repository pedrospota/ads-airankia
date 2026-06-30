// ============================================================================
// Shared types for the Competitor Benchmark Lab.
//
// This is the STABLE contract between the proxy (/api/benchmark/lab) and the
// UI. The raw Windmill flow output (discover / transparency / analyze) is
// normalised into a LabReport server-side, so the frontend never has to care
// whether the data came from the real flow or the demo sample.
//
// No server-only imports here — safe to import from the client component.
// ============================================================================

// keyword   = Oxylabs keyword search only → structured ad report
// company   = SerpApi Transparency only → ads for a specific domain
// extended  = Oxylabs keyword → domains → SerpApi transparency + Firecrawl OCR
// extended_company = SerpApi transparency + Firecrawl OCR (skip keyword search)
export type BenchmarkMode = "keyword" | "company" | "extended" | "extended_company";

/** A single competitor ad creative from the Google Ads Transparency Center. */
export type LabAd = {
  advertiser: string | null;
  advertiserDomain: string | null;
  legalName: string | null;
  format: string | null; // text | image | video
  firstShown: string | null;
  lastShown: string | null;
  daysActive: number | null;
  /** FULL image URL (tpc.googlesyndication.com/...), never the bare CR id. */
  imageUrl: string | null;
  detailsLink: string | null;
  targetDomain: string | null;
  /** Which seed keyword surfaced this advertiser (provenance). */
  viaKeyword?: string | null;
  /** Creative text, when available (demo + future richer scrape / AI extract). */
  headline?: string | null;
  cta?: string | null;
  /** Ad description / body copy (Oxylabs `desc`). */
  description?: string | null;
  /** Campaign label decoded from the tracking URL (Oxylabs). */
  campaign?: string | null;
  /** Sitelink titles (ad extensions). */
  sitelinks?: string[];
  /** Position on the SERP (Oxylabs `pos`). */
  position?: number | null;
};

export type AdvertiserSource = "oxylabs" | "serpapi" | "manual";

/** One competitor: discovered on the keyword and/or scraped from transparency. */
export type LabAdvertiser = {
  domain: string;
  source: AdvertiserSource;
  totalAds: number;
  oldestTop5: LabAd[];
  /** A representative live ad headline seen on the keyword (from Oxylabs). */
  sampleHeadline?: string | null;
  sampleUrl?: string | null;
  viaKeywords: string[];
  /**
   * The representative ad WITH COPY (headline/description/campaign/sitelinks) —
   * from Oxylabs in keyword/extended modes. In extended mode `oldestTop5` holds
   * the transparency creatives (image + days), so this carries the ad text the
   * per-competitor card needs (transparency creatives have no copy).
   */
  topAd?: LabAd | null;
};

/** A data-provenance line shown in the report so the source is always clear. */
export type LabSource = {
  label: string; // e.g. "Advertiser discovery"
  provider: string; // e.g. "Oxylabs · google_ads"
  detail: string; // e.g. "Real Google Search ads for the keyword"
  live: boolean; // true = real call, false = demo sample
};

/**
 * Manual Google Ads Transparency Center parameters (SerpApi / SearchApi).
 * Everything is optional — when omitted we follow Pedro's rule: NO region by
 * default (global), text/domain auto-derived, max ads. Power users set these
 * explicitly in the Lab's advanced panel.
 */
export type TransparencyParams = {
  /** Geo code (e.g. "2840" for the US). Absent/empty = global (anywhere). */
  region?: string | null;
  /** SEARCH | MAPS | YOUTUBE | GOOGLEPLAY — omit for all platforms. */
  platform?: string | null;
  /** text | image | video — omit for all formats. */
  creativeFormat?: string | null;
  /** Look up by a specific advertiser id (AR…) instead of the domain text. */
  advertiserId?: string | null;
  /** Custom range start, format YYYYMMDD. */
  startDate?: string | null;
  /** Custom range end, format YYYYMMDD. */
  endDate?: string | null;
  /** Max creatives to pull (1–100, default 100). */
  num?: number | null;
};

/**
 * Validate/whitelist raw Transparency params from a request body. Pure (no server
 * imports) so both the lab route and the brand-benchmark route share it. Returns
 * undefined when nothing meaningful was set, so callers can follow the defaults.
 */
export function parseTransparencyParams(raw: unknown): TransparencyParams | undefined {
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
  const hasAny = Object.values(t).some((v) => v !== null && v !== undefined);
  return hasAny ? t : undefined;
}

export type LabQuery = {
  keywords: string[];
  countryCode: string;
  countryName: string;
  geo: string;
  region: string;
  language: string;
  mode: BenchmarkMode;
  numKeywords: number;
  numCompetitors: number;
  /** Optional manual Transparency-Center params (Lab advanced panel). */
  transparency?: TransparencyParams;
};

/** A frequency stat with its share of the whole (count + percentage). */
export type LabStat = { label: string; count: number; pct: number };

/** Per-competitor deterministic breakdown for the share-of-voice table. */
export type LabCompetitorStat = {
  domain: string;
  advertiser: string | null;
  legalName: string | null;
  totalAds: number;
  sharePct: number; // share of all ads (share of voice)
  oldestDays: number;
  avgDays: number;
  formats: LabStat[]; // format mix from this competitor's sampled creatives
  topCtas: string[]; // up to 3 CTAs seen (may be empty when not extracted)
  landingUrl: string | null;
  viaKeywords: string[];
  runsVsAds: boolean; // headline suggests a brand-competitor ("vs") angle
};

/**
 * Deterministic analytics computed from the raw ad data — the data-first half
 * of the master-prompt deliverables (formats, CTAs, term frequency, share of
 * voice, keyword coverage, age distribution, "vs" ads, mined keywords).
 * Computed identically for demo and live data so the dashboard never changes shape.
 */
export type LabAnalytics = {
  formats: LabStat[]; // overall format mix (text / image / video)
  ctas: LabStat[]; // CTA leaderboard with % (empty when not available)
  headlineTerms: LabStat[]; // most-used headline/description terms with %
  recommendedKeywords: string[]; // >= 10 keywords mined from competitor copy
  competitors: LabCompetitorStat[]; // share-of-voice table
  keywordCoverage: { keyword: string; domains: string[] }[]; // who shows per keyword
  ageBuckets: LabStat[]; // distribution of ad age
  vsAdvertisers: string[]; // domains running brand-competitor ("vs") ads
  creativesAnalyzed: number; // how many creatives fed these stats
};

export type LabReport = {
  generatedAt: string; // ISO
  demo: boolean; // true = sample data (Windmill not wired yet)
  query: LabQuery;
  summary: {
    advertisers: number;
    totalAds: number;
    avgDaysActive: number;
    oldestDays: number;
    keywordsAnalyzed: number;
  };
  advertisers: LabAdvertiser[];
  /** Oldest still-running ads across every competitor (the headline gallery). */
  topOldestAds: LabAd[];
  /** Deterministic dashboard analytics (always present). */
  analytics: LabAnalytics;
  analysis: {
    model: string;
    language: string;
    markdown: string;
  } | null;
  sources: LabSource[];
};

/** What the UI POSTs to /api/benchmark/lab. */
export type LabRunInput = {
  keywords: string[];
  countryCode: string;
  language: string;
  mode: BenchmarkMode;
  numKeywords: number;
  numCompetitors: number;
  transparency?: TransparencyParams;
};
