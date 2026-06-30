// ============================================================================
// CompetitiveBrief — the single shared object every ad-spy tool writes a slice
// of. It is the SPINE that unifies the three product surfaces (see the strategy
// memo): the standalone tools (manual control / compare), the PREMIUM
// consolidated report (sells), and the AGENTIC pipeline that feeds the campaign
// agents (A1–A6). "Build once, expose three times."
//
// Each tool stays a small typed function `(input) => Promise<XSlice>`; the
// deterministic auto-mode orchestrator fans them out and assembles them here.
// An LLM "research-agent" then reasons OVER this brief (it never fetches).
// ============================================================================

/** Provenance — so every number can show which API it came from. */
export interface BriefSource {
  tool: string; // e.g. "keyword-spend"
  provider: string; // e.g. "DataForSEO Labs"
  ranAt: string; // ISO
  costUsd?: number;
}

/** 💰 Keyword & Spend Spy (DataForSEO). */
export interface KeywordSpendSlice {
  domain: string;
  estimatedMonthlySpend: number;
  paidKeywords: number;
  estimatedPaidTraffic: number;
  topKeywords: { keyword: string; volume: number; cpc: number | null; position: number | null; etv: number }[];
}

/** 🥊 Keyword gap vs the brand (computed alongside spend). */
export interface KeywordGapSlice {
  steal: string[]; // only the rival bids → opportunity
  shared: string[]; // both bid
  defendCount: number; // keywords only the brand bids on
}

/** 🔬 Landing X-Ray (Firecrawl + LLM). */
export interface LandingSlice {
  domain: string;
  url: string;
  offer: string | null;
  pricing: string[] | null;
  primaryCta: string | null;
  valueProps: string[];
  socialProof: string[];
  funnelSteps: string[] | null;
  trackingStack: string[];
  /** strong | partial | weak — does the landing deliver on the ad's promise? */
  adMessageMatch: "strong" | "partial" | "weak" | null;
  matchRationale: string | null;
}

/** 🛡️ Brand Defense (Oxylabs) — who bids on the brand's own terms. */
export interface BrandThreatSlice {
  brandKeyword: string;
  conquesters: { domain: string; headline: string | null; description: string | null }[];
}

/** 🔍 Competitor Discovery (DataForSEO) — rivals the user hadn't listed. */
export interface DiscoverySlice {
  suggested: { domain: string; overlap: number }[];
}

/** What the LLM research-agent writes after reasoning over the whole brief. */
export interface BriefSynthesis {
  positioning: string;
  opportunities: string[];
  threats: string[];
  recommendedAngle: string;
}

export interface CompetitiveBrief {
  brand: { name: string; domain: string | null };
  market: { countryCode: string; countryName: string; language: string };
  competitors: string[]; // domains
  keywordSpend: KeywordSpendSlice[];
  keywordGap: KeywordGapSlice | null;
  landing: LandingSlice[];
  brandThreats: BrandThreatSlice[];
  discovery: DiscoverySlice | null;
  sources: BriefSource[];
  /** Filled by the LLM research-agent; null until synthesis runs. */
  synthesis: BriefSynthesis | null;
  generatedAt: string; // ISO
}

/** Start an empty brief the orchestrator fills slice by slice. */
export function emptyBrief(
  brand: CompetitiveBrief["brand"],
  market: CompetitiveBrief["market"],
  competitors: string[]
): CompetitiveBrief {
  return {
    brand,
    market,
    competitors,
    keywordSpend: [],
    keywordGap: null,
    landing: [],
    brandThreats: [],
    discovery: null,
    sources: [],
    synthesis: null,
    generatedAt: new Date().toISOString(),
  };
}
