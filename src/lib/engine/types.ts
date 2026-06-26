// ============================================================================
// SEARCH CAMPAIGN ENGINE — shared contract ("un motor, dos caras")
// ----------------------------------------------------------------------------
// This is the FROZEN contract. Every engine file, agent, API route and the UI
// import their types from here. PURE TYPES ONLY — no runtime, no process.env,
// no server imports — so it is safe to import from client components too.
//
// The engine is a single 6-agent pipeline. A flag (`autoAdvance`) gives it two
// faces:
//   - MODO AUTO     → runs straight through to one screen + one "Activar" click.
//   - MODO ASISTIDO → pauses after each agent with an editable proposal.
// Improving the agents improves BOTH modes.
// ============================================================================

export type JSONSchema = Record<string, unknown>;

// ----------------------------------------------------------------------------
// The pipeline
// ----------------------------------------------------------------------------

export type AgentId =
  | "planner" //            A1 — objetivo, geo/idioma, budget, temas, KPIs   (Opus)
  | "keyword_researcher" // A2 — keywords + match types + métricas + negativas (Sonnet)
  | "structure_architect"//A3 — árbol campaña→grupos, estrategia de puja     (Opus)
  | "rsa_copywriter" //     A4 — 15 títulos + 4 descripciones por grupo       (Sonnet)
  | "policy_qa" //          A5 — pass/fix/block: límites, política, URL viva   (Opus)
  | "activator"; //         A6 — mutaciones Google Ads, SIEMPRE en PAUSED (código, sin LLM)

/** Ordered pipeline. The orchestrator runs these in sequence. */
export const PIPELINE: AgentId[] = [
  "planner",
  "keyword_researcher",
  "structure_architect",
  "rsa_copywriter",
  "policy_qa",
  "activator",
];

export const AGENT_TITLES: Record<AgentId, string> = {
  planner: "Estratega",
  keyword_researcher: "Investigador de keywords",
  structure_architect: "Arquitecto de estructura",
  rsa_copywriter: "Redactor de anuncios",
  policy_qa: "Revisor de calidad y política",
  activator: "Activador",
};

export type Intent =
  | "brand"
  | "transactional"
  | "commercial"
  | "informational"
  | "competitor"
  | "local";

export type MatchType = "EXACT" | "PHRASE" | "BROAD";

export type BiddingStrategy =
  | "MANUAL_CPC"
  | "MAXIMIZE_CLICKS"
  | "MAXIMIZE_CONVERSIONS"
  | "TARGET_CPA"
  | "MAXIMIZE_CONVERSION_VALUE"
  | "TARGET_ROAS";

export type ObjectiveType = "leads" | "sales" | "traffic" | "calls" | "awareness";

// ----------------------------------------------------------------------------
// Limits & defaults (Google Ads hard limits + our policy)
// ----------------------------------------------------------------------------

export const RSA_LIMITS = {
  headlineMaxChars: 30,
  descriptionMaxChars: 90,
  minHeadlines: 3,
  maxHeadlines: 15,
  minDescriptions: 2,
  maxDescriptions: 4,
  path1MaxChars: 15,
  path2MaxChars: 15,
} as const;

export const BUDGET = {
  /** $1.00 == 1_000_000 micros == Google daily-budget minimum. */
  minDailyUsd: 1,
} as const;

export const MICROS_PER_UNIT = 1_000_000;

// ----------------------------------------------------------------------------
// Brand seed — what the user gives us to start a run
// ----------------------------------------------------------------------------

export interface BrandSeed {
  brandId: string;
  brandName: string;
  brandWebsite?: string;
  /** Where the ads will point. Defaults to brandWebsite if absent. */
  landingPageUrl?: string;
  description?: string;
  /** Sector / actividad del negocio, tomado de la ficha de marca. */
  industry?: string;
  /** Plain-language goal the user typed, optional ("quiero más reservas"). */
  objectiveHint?: string;
  geoHint?: string;
  budgetHintUsd?: number;
  languageHint?: string;
}

// ----------------------------------------------------------------------------
// A1 — Planner output
// ----------------------------------------------------------------------------

export interface PlannerTheme {
  name: string;
  intent: Intent;
  description: string;
}

export interface PlannerOutput {
  objectiveType: ObjectiveType;
  objectiveSummary: string;
  geo: {
    locations: string[];
    countryCodes: string[];
    languageCode: string; // e.g. "es", "en"
    presenceOnly: boolean; // true = people IN the location (recommended)
  };
  budget: { dailyUsd: number; rationale: string };
  biddingStrategy: BiddingStrategy;
  targetCpaUsd?: number;
  targetRoas?: number;
  /** Seed themes that become ad groups downstream. */
  themes: PlannerTheme[];
  kpis: { primary: string; target: string }[];
  /** Chosen primary conversion action resource name, if one applies. */
  conversionActionResourceName?: string;
  brandSummary: string;
  rationale: string;
}

// ----------------------------------------------------------------------------
// A2 — Keyword researcher output
// ----------------------------------------------------------------------------

export interface KeywordIdea {
  text: string;
  matchType: MatchType;
  /** Which planner theme this maps to (PlannerTheme.name). */
  theme: string;
  intent: Intent;
  avgMonthlySearches?: number;
  competition?: "LOW" | "MEDIUM" | "HIGH";
  topOfPageBidLowMicros?: number;
  topOfPageBidHighMicros?: number;
  relevanceScore?: number; // 0..1
  /** Composite score (volume × intent × relevance × affordability). */
  score?: number;
  source: string; // keyword_seed|url_seed|citation|llm|search_term|historical
  rationale?: string;
}

export interface NegativeKeywordIdea {
  text: string;
  matchType: MatchType;
  negativeClass: string; // free_seeker|wrong_intent|wrong_geo|competitor|brand_cross|cross_group
  scope?: "campaign" | "ad_group" | "shared";
}

export interface KeywordResearchOutput {
  keywords: KeywordIdea[];
  negatives: NegativeKeywordIdea[];
  /** Whether real Google metrics were attached (Keyword Plan Ideas) or estimated. */
  metricsSource: "google_keyword_planner" | "llm_estimate";
  notes: string;
}

// ----------------------------------------------------------------------------
// A3 — Structure architect output
// ----------------------------------------------------------------------------

export interface PlannedKeyword {
  text: string;
  matchType: MatchType;
}

export interface PlannedAdGroup {
  name: string;
  theme: string;
  archetype: "brand" | "non_brand_stag" | "dsa" | "competitor" | "category";
  matchTypePolicy: "EXACT" | "PHRASE" | "BROAD" | "MIXED";
  keywords: PlannedKeyword[];
  negativeKeywords: PlannedKeyword[];
  defaultCpcUsd?: number;
  landingPageUrl: string;
}

export interface StructureOutput {
  campaignName: string;
  adGroups: PlannedAdGroup[];
  /** Campaign-level shared negatives. */
  sharedNegatives: PlannedKeyword[];
  biddingStrategy: BiddingStrategy;
  rationale: string;
}

// ----------------------------------------------------------------------------
// A4 — RSA copywriter output
// ----------------------------------------------------------------------------

export type HeadlinePin = "HEADLINE_1" | "HEADLINE_2" | "HEADLINE_3" | null;
export type DescriptionPin = "DESCRIPTION_1" | "DESCRIPTION_2" | null;

export interface RSAHeadline {
  text: string; // <= 30 chars
  pinnedField?: HeadlinePin;
}

export interface RSADescription {
  text: string; // <= 90 chars
  pinnedField?: DescriptionPin;
}

export interface AdGroupAds {
  adGroupName: string;
  headlines: RSAHeadline[]; // up to 15, >= 3
  descriptions: RSADescription[]; // up to 4, >= 2
  path1?: string;
  path2?: string;
  finalUrl: string;
}

export interface RSAOutput {
  ads: AdGroupAds[];
  rationale: string;
}

// ----------------------------------------------------------------------------
// A5 — Policy / QA output
// ----------------------------------------------------------------------------

export type QAVerdict = "pass" | "fix" | "block";

export interface QAIssue {
  severity: "block" | "fix" | "warn";
  area: string; // budget|policy|landing_page|rsa_limits|structure|geo|bidding|...
  message: string;
  suggestion?: string;
  locator?: string; // e.g. "adGroup[0].headline[4]"
}

export interface QAChecklistItem {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface QAOutput {
  verdict: QAVerdict;
  issues: QAIssue[];
  checklist: QAChecklistItem[];
  rationale: string;
}

// ----------------------------------------------------------------------------
// A6 — Activator result (code agent, no LLM)
// ----------------------------------------------------------------------------

export interface ActivatorMutationLogEntry {
  operation: string;
  resourceName?: string;
  status: "done" | "failed";
  detail?: string;
}

export interface ActivatorOutput {
  campaignResourceName: string;
  googleCampaignId: string;
  budgetResourceName: string;
  adGroups: { name: string; resourceName: string; id: string }[];
  keywordsAdded: number;
  negativesAdded: number;
  adsCreated: number;
  /** Extensions/assets linked to the campaign (sitelinks/callouts/structured snippets). */
  assetsLinked: number;
  /** Friendly Spanish labels of the extension kinds added (e.g. "enlaces a tu web"). */
  assetKinds: string[];
  /** True iff a planned Smart Bidding strategy was auto-downgraded to Maximize Clicks because the account measures no conversions. */
  conversionDowngradeApplied: boolean;
  /** True iff the account already has an ENABLED conversion action (the campaign measures real results, not just clicks). Read-only reflection — the activator never auto-creates one. */
  conversionTrackingEnabled: boolean;
  /** Resource name of the conversion action the account measures with, if any (mirrored onto the campaign row for Optimize / Performance Max). */
  conversionActionResourceName?: string;
  /** Activator ALWAYS leaves the campaign PAUSED. Enabling is a separate, explicit action. */
  status: "PAUSED";
  mutationLog: ActivatorMutationLogEntry[];
}

// ----------------------------------------------------------------------------
// Run + step records (subset of DB rows the engine reads/writes)
// ----------------------------------------------------------------------------

export type RunMode = "auto" | "assisted";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "aborted";

export type StepStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "AWAITING_APPROVAL";

export interface AgentRunRecord {
  id: string;
  campaignId: string | null;
  brandId: string;
  workspaceId: string;
  userId: string;
  flow: string;
  channel: string;
  mode: RunMode;
  autoAdvance: boolean;
  status: RunStatus;
  currentStepId: string | null;
  error: string | null;
}

export interface AgentStepRecord {
  id: string;
  runId: string;
  agent: AgentId;
  kind: "llm" | "code";
  status: StepStatus;
  input: unknown | null;
  output: unknown | null;
  userOverride: unknown | null;
  rationale: string | null;
  model: string | null;
}

// ----------------------------------------------------------------------------
// RunContext — accumulated typed state passed to every agent
// ----------------------------------------------------------------------------

export interface RunContext {
  run: AgentRunRecord;
  brand: BrandSeed;
  /** Outputs of already-completed upstream steps (user overrides already merged). */
  planner?: PlannerOutput;
  keywords?: KeywordResearchOutput;
  structure?: StructureOutput;
  rsa?: RSAOutput;
  qa?: QAOutput;
  activator?: ActivatorOutput;
  /** Our DB campaign uuid, once a campaign row exists. */
  campaignId?: string;
}

// ----------------------------------------------------------------------------
// Agent contract — every pipeline agent implements this
// ----------------------------------------------------------------------------

export type AgentEventType =
  | "run_status"
  | "step_started"
  | "step_progress"
  | "token"
  | "decision"
  | "artifact"
  | "gate"
  | "error"
  | "step_completed";

export interface AgentHelpers {
  /** Emit a live event (tailed by the SSE stream → UI). */
  emit(type: AgentEventType, data: unknown): Promise<void>;
  /** The current step row id (for events/persistence). */
  stepId: string;
  /** Abort signal so a cancelled run stops mid-agent. */
  signal?: AbortSignal;
}

export interface AgentResult<O = unknown> {
  output: O;
  rationale?: string;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costMicros?: number;
}

export interface AgentDefinition<O = unknown> {
  id: AgentId;
  title: string;
  /** Anthropic model id for llm agents; null for the code-only activator. */
  model: string | null;
  kind: "llm" | "code";
  promptVersion: string;
  /**
   * Run the agent: read upstream outputs from ctx, do the work (LLM or code),
   * persist any domain rows (keywords, ad_groups, ...), and return the output.
   * The orchestrator persists the AgentResult onto the step row afterwards.
   */
  execute(ctx: RunContext, helpers: AgentHelpers): Promise<AgentResult<O>>;
}

// ----------------------------------------------------------------------------
// API DTOs (server ⇄ client)
// ----------------------------------------------------------------------------

export interface StartRunRequest {
  brandId: string;
  mode: RunMode;
  seed: BrandSeed;
}

export interface StartRunResponse {
  runId: string;
}

export interface StepDTO {
  id: string;
  agent: AgentId;
  title: string;
  kind: "llm" | "code";
  status: StepStatus;
  model: string | null;
  output: unknown | null;
  userOverride: unknown | null;
  rationale: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunStateDTO {
  run: {
    id: string;
    status: RunStatus;
    mode: RunMode;
    autoAdvance: boolean;
    campaignId: string | null;
    googleCampaignId: string | null;
    error: string | null;
  };
  steps: StepDTO[];
}

export interface AdvanceRequest {
  /** The awaiting step to accept (defaults to the current awaiting step). */
  stepId?: string;
  /** Edited proposal to persist as a sticky user override before advancing. */
  userOverride?: unknown;
  action?: "accept" | "run_next" | "regenerate";
}

export interface ActivateResponse {
  ok: boolean;
  googleCampaignId?: string;
  enabled: boolean; // false = left PAUSED (default & recommended)
  error?: string;
  /** What was really created in Google Ads (so the user isn't left with a black box). */
  summary?: {
    adGroupsCount: number;
    keywordsCount: number;
    negativesCount: number;
    adsCount: number;
    assetsCount: number;
    assetKinds: string[];
  };
  /** Deep link to view the created campaign in the Google Ads UI. */
  googleAdsDeepLink?: string;
  /** True when bidding was auto-adjusted to clicks because no conversions are measured yet. */
  conversionDowngradeApplied?: boolean;
  /** True when the account already measures conversions (an ENABLED conversion action exists). */
  conversionTrackingEnabled?: boolean;
}
