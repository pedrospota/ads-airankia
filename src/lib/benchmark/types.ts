// ============================================================================
// Benchmark report shapes — the structured result of one competitor-benchmark
// run, stored in benchmark_runs.result and rendered by the premium dashboard.
//
// Everything here is derived from FREE data sources (Google Keyword Planner +
// fetching public landing pages) EXCEPT `CompetitorAd[]`, which comes from the
// optional, admin-gated PAID ad-spy block. When the gate is off, `ads` is null
// and `adsStatus` is "off" — the rest of the report is fully populated.
// ============================================================================

export type Competition =
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "UNSPECIFIED"
  | "UNKNOWN";

/** One keyword with its real Google Keyword Planner metrics. */
export interface BenchmarkKeyword {
  text: string;
  avgMonthlySearches: number;
  competition: Competition;
  cpcLowMicros?: number;
  cpcHighMicros?: number;
}

/** A tracking/analytics stack detected on a competitor's landing page. */
export interface TrackingStack {
  /** Distinct utm_* params found on outbound/internal links (key→sample value). */
  utmParams: { key: string; value: string }[];
  /** Detected pixels/tags (GA4, Google Ads, GTM, Meta Pixel, TikTok, …). */
  pixels: string[];
  hasGtm: boolean;
  gtmIds: string[];
  gaIds: string[];
  adsConversionIds: string[];
}

/** LLM teardown of a competitor's landing page (the "what they say" layer). */
export interface CompetitorLanding {
  url: string;
  httpStatus: number | null;
  title: string;
  valueProposition: string;
  offers: string[];
  ctas: string[];
  trustSignals: string[];
  toneNotes: string;
  tracking: TrackingStack;
}

/** One transparency-center ad creative (PAID ad-spy only; null when gated off). */
export interface CompetitorAd {
  format: string; // text | image | video
  headline?: string;
  body?: string;
  destinationUrl?: string;
  firstShown?: string;
  lastShown?: string;
}

export type AdsStatus = "off" | "empty" | "ok" | "error";

/** Everything we learned about one competitor domain. */
export interface BenchmarkCompetitor {
  domain: string;
  source: "brand_profile" | "manual" | "derived";
  keywords: BenchmarkKeyword[];
  totalVolume: number;
  landing: CompetitorLanding | null;
  ads: CompetitorAd[] | null;
  adsStatus: AdsStatus;
  /** Non-fatal notes (e.g. "landing fetch timed out"). */
  notes: string[];
}

/** A keyword competitors are associated with that the brand appears to miss. */
export interface KeywordGap {
  text: string;
  avgMonthlySearches: number;
  competition: Competition;
  cpcLowMicros?: number;
  cpcHighMicros?: number;
  competitorsCovering: string[]; // domains whose footprint surfaced this kw
  brandCovers: boolean;
}

/** The AI's synthesized strategy — the "so what / do this" layer. */
export interface BenchmarkStrategy {
  summary: string; // executive summary, in the brand's language
  positioning: string;
  opportunities: string[];
  threats: string[];
  recommendedKeywords: string[];
  recommendedAngles: string[];
}

export interface BenchmarkReport {
  generatedAt: string;
  language: string;
  country: string;
  brand: { name: string; website: string | null; domain: string | null };
  brandKeywords: BenchmarkKeyword[];
  competitors: BenchmarkCompetitor[];
  keywordGaps: KeywordGap[];
  strategy: BenchmarkStrategy;
  meta: {
    liveAdSpy: boolean;
    domainsAnalyzed: number;
    keywordsDiscovered: number;
  };
}

/** Cost-attribution linkage threaded through every metered call in a run. */
export interface BenchmarkCostContext {
  userId?: string | null;
  brandId?: string | null;
  workspaceId?: string | null;
  runId?: string | null;
}
