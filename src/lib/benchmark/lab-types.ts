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

export type BenchmarkMode = "normal" | "company" | "extended";

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
};

/** A data-provenance line shown in the report so the source is always clear. */
export type LabSource = {
  label: string; // e.g. "Advertiser discovery"
  provider: string; // e.g. "Oxylabs · google_ads"
  detail: string; // e.g. "Real Google Search ads for the keyword"
  live: boolean; // true = real call, false = demo sample
};

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
};
