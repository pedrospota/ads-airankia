import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  date,
  bigint,
  bigserial,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Topup credit balance (like Google Ads prepaid)
export const wallets = pgTable("wallets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  balanceCents: integer("balance_cents").default(0).notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  walletId: uuid("wallet_id").references(() => wallets.id).notNull(),
  type: text("type").notNull(), // 'topup' | 'spend' | 'refund'
  amountCents: integer("amount_cents").notNull(),
  description: text("description"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  campaignId: uuid("campaign_id").references(() => campaigns.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  brandId: uuid("brand_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  googleCampaignId: bigint("google_campaign_id", { mode: "number" }),
  googleAdgroupId: bigint("google_adgroup_id", { mode: "number" }),
  googleAccountId: text("google_account_id"),
  status: text("status").default("draft").notNull(), // draft | active | paused | exhausted | stopped
  // SEARCH-engine discriminator: existing rows are 'display'. Display & Search code paths
  // must never cross-execute (every read/mutate path checks campaignType).
  campaignType: text("campaign_type").default("display").notNull(), // 'display' | 'search'
  biddingStrategy: text("bidding_strategy"), // MANUAL_CPC | MAXIMIZE_CLICKS | MAXIMIZE_CONVERSIONS | TARGET_CPA | TARGET_ROAS | MAXIMIZE_CONVERSION_VALUE
  targetCpaMicros: bigint("target_cpa_micros", { mode: "number" }),
  targetRoas: numeric("target_roas", { precision: 10, scale: 4 }),
  conversionActionResourceName: text("conversion_action_resource_name"),
  billingVerifiedAt: timestamp("billing_verified_at", { withTimezone: true }),
  accountCurrency: text("account_currency"), // assert USD before micros/10000 math
  accountTimezone: text("account_timezone"),
  activePlanId: uuid("active_plan_id"), // -> campaign_plans.id (soft ref, no FK)
  dailyBudgetCents: integer("daily_budget_cents"),
  totalBudgetCents: integer("total_budget_cents"),
  spentCents: integer("spent_cents").default(0),
  landingPageUrl: text("landing_page_url"),
  brandName: text("brand_name"),
  brandWebsite: text("brand_website"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const placements = pgTable("placements", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id").references(() => campaigns.id),
  url: text("url").notNull(),
  domain: text("domain").notNull(),
  citationCount: integer("citation_count").default(0),
  modelsCiting: text("models_citing").array(),
  gdnAvailable: boolean("gdn_available").default(true),
  googleCriterionId: bigint("google_criterion_id", { mode: "number" }),
  impressions: integer("impressions").default(0),
  clicks: integer("clicks").default(0),
  costCents: integer("cost_cents").default(0),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const performance = pgTable(
  "performance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .references(() => campaigns.id)
      .notNull(),
    date: date("date").notNull(),
    impressions: integer("impressions").default(0),
    clicks: integer("clicks").default(0),
    costCents: integer("cost_cents").default(0),
    ctr: numeric("ctr", { precision: 5, scale: 4 }).default("0"),
    avgCpcCents: integer("avg_cpc_cents").default(0),
    conversions: integer("conversions").default(0),
    conversionsValueMicros: bigint("conversions_value_micros", { mode: "number" }).default(0),
    allConversions: numeric("all_conversions", { precision: 12, scale: 2 }).default("0"),
    costPerConvMicros: bigint("cost_per_conv_micros", { mode: "number" }).default(0),
  },
  (table) => [
    uniqueIndex("perf_campaign_date_idx").on(table.campaignId, table.date),
  ]
);

export const adInventory = pgTable(
  "ad_inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domain: text("domain").notNull(),
    hasGdn: boolean("has_gdn").default(false),
    gdnPubId: text("gdn_pub_id"),
    networks: text("networks").array(),
    detectionMethod: text("detection_method"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("ad_inventory_domain_idx").on(table.domain),
  ]
);

export const bannerAssets = pgTable("banner_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id").references(() => campaigns.id),
  format: text("format").notNull(),
  r2Url: text("r2_url").notNull(),
  driveUrl: text("drive_url"),
  promptUsed: text("prompt_used"),
  template: text("template"),
  status: text("status").default("generated").notNull(),
  width: integer("width"),
  height: integer("height"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ============================================================================
// SEARCH CAMPAIGN ENGINE — additive tables (Fase 1, task 1)
// All additive. Display paths untouched. Never references main-SaaS Supabase.
// ============================================================================

// Idempotent migration version ledger (paired with /api/migrate).
export const schemaMigrations = pgTable("schema_migrations", {
  version: text("version").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow(),
});

// --- Agentic run substrate -------------------------------------------------

// One agentic build/optimize run. autoAdvance drives MODO AUTO vs ASISTIDO.
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id"), // soft ref; campaign may be created during the run
    brandId: uuid("brand_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    flow: text("flow").notNull(), // 'search_build' | 'display_build' | 'optimize'
    channel: text("channel").default("search").notNull(),
    mode: text("mode").notNull(), // 'auto' | 'assisted'
    autoAdvance: boolean("auto_advance").default(false).notNull(),
    status: text("status").default("queued").notNull(), // queued|running|awaiting_approval|paused|completed|failed|aborted
    // Service-credential scope so a resumed (cookieless) worker keeps identity.
    credentialScope: jsonb("credential_scope"),
    currentStepId: uuid("current_step_id"),
    costMicrosLlm: bigint("cost_micros_llm", { mode: "number" }).default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_agent_runs_campaign").on(table.campaignId),
    index("idx_agent_runs_status").on(table.status),
  ]
);

// One step (agent invocation, code step, or gate). The tick worker claims these.
export const agentSteps = pgTable(
  "agent_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => agentRuns.id).notNull(),
    parentStepId: uuid("parent_step_id"),
    agent: text("agent").notNull(), // which fleet agent / code step
    kind: text("kind").notNull(), // 'llm' | 'code' | 'gate' | 'tool'
    status: text("status").default("NOT_STARTED").notNull(), // NOT_STARTED|RUNNING|COMPLETED|FAILED|STALE|QUARANTINED|AWAITING_APPROVAL
    // Deterministic hash of semantic inputs (upstream output hashes + override + model + promptVersion).
    idempotencyKey: text("idempotency_key"),
    input: jsonb("input"),
    output: jsonb("output"),
    userOverride: jsonb("user_override"), // sticky in ASISTIDO — re-validate, never auto-regenerate
    rationale: text("rationale"), // per-decision explanation rendered in the UI
    model: text("model"),
    promptVersion: text("prompt_version"),
    tokensIn: integer("tokens_in").default(0),
    tokensOut: integer("tokens_out").default(0),
    costMicrosLlm: bigint("cost_micros_llm", { mode: "number" }).default(0),
    attempt: integer("attempt").default(0),
    maxLoops: integer("max_loops").default(3),
    lockedBy: text("locked_by"), // lease owner (tick worker instance)
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_agent_steps_run").on(table.runId),
    index("idx_agent_steps_claim").on(table.status, table.leaseExpiresAt),
    uniqueIndex("agent_steps_idempotency_idx").on(table.runId, table.idempotencyKey),
  ]
);

// Append-only event log. `seq` is the monotonic cursor the SSE reader tails.
export const agentEvents = pgTable(
  "agent_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    id: uuid("id").defaultRandom().notNull(),
    runId: uuid("run_id").references(() => agentRuns.id).notNull(),
    stepId: uuid("step_id"),
    type: text("type").notNull(), // step_started|step_progress|token|artifact|decision|gate|error|run_status|...
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_agent_events_run_seq").on(table.runId, table.seq),
  ]
);

// Versioned campaign blueprint (the plan blob produced by the planner/architect).
export const campaignPlans = pgTable(
  "campaign_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id"),
    runId: uuid("run_id").references(() => agentRuns.id),
    version: integer("version").default(1).notNull(),
    plan: jsonb("plan").notNull(),
    archetypeMix: jsonb("archetype_mix"), // brand_defense / non_brand_stag / dsa / pmax
    status: text("status").default("draft").notNull(), // draft|active|superseded
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_campaign_plans_campaign").on(table.campaignId)]
);

// --- Campaign structure ----------------------------------------------------

export const adGroups = pgTable(
  "ad_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").references(() => campaigns.id).notNull(),
    googleAdgroupId: bigint("google_adgroup_id", { mode: "number" }),
    name: text("name").notNull(),
    theme: text("theme"), // single-intent theme (STAG)
    archetype: text("archetype"), // brand | non_brand_stag | dsa | pmax | competitor
    matchTypePolicy: text("match_type_policy"), // EXACT | PHRASE | BROAD | MIXED (default per group)
    defaultCpcMicros: bigint("default_cpc_micros", { mode: "number" }),
    cohesion: numeric("cohesion", { precision: 5, scale: 4 }), // intent cohesion score (gate G3 >= 0.6)
    landingPageUrl: text("landing_page_url"),
    status: text("status").default("draft").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_ad_groups_campaign").on(table.campaignId)]
);

export const keywords = pgTable(
  "keywords",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adGroupId: uuid("ad_group_id").references(() => adGroups.id),
    campaignId: uuid("campaign_id").references(() => campaigns.id),
    text: text("text").notNull(),
    matchType: text("match_type").notNull(), // EXACT | PHRASE | BROAD
    bidMicros: bigint("bid_micros", { mode: "number" }),
    googleCriterionId: bigint("google_criterion_id", { mode: "number" }),
    avgMonthlySearches: bigint("avg_monthly_searches", { mode: "number" }),
    competition: text("competition"), // LOW | MEDIUM | HIGH
    topOfPageBidMicros: bigint("top_of_page_bid_micros", { mode: "number" }),
    lowTopOfPageBidMicros: bigint("low_top_of_page_bid_micros", { mode: "number" }),
    intent: text("intent"), // brand|transactional|commercial|informational|competitor|local
    relevanceScore: numeric("relevance_score", { precision: 5, scale: 4 }),
    score: numeric("score", { precision: 7, scale: 4 }), // composite volume×intent×relevance×affordability
    source: text("source"), // keyword_seed|url_seed|citation|llm|search_term|historical
    sourceRunId: uuid("source_run_id"), // -> keyword_research_runs.id (soft ref)
    rationale: text("rationale"),
    status: text("status").default("proposed").notNull(), // proposed|accepted|rejected|live
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_keywords_ad_group").on(table.adGroupId),
    index("idx_keywords_campaign").on(table.campaignId),
  ]
);

export const negativeKeywords = pgTable(
  "negative_keywords",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").references(() => campaigns.id),
    adGroupId: uuid("ad_group_id").references(() => adGroups.id),
    sharedSetResourceName: text("shared_set_resource_name"), // per-brand shared set (never global)
    text: text("text").notNull(),
    matchType: text("match_type").notNull(),
    negativeClass: text("negative_class"), // free_seeker|wrong_intent|wrong_geo|competitor|cross_group|brand_cross
    scope: text("scope").default("campaign").notNull(), // campaign|ad_group|shared
    googleCriterionId: bigint("google_criterion_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_neg_keywords_campaign").on(table.campaignId),
    index("idx_neg_keywords_ad_group").on(table.adGroupId),
  ]
);

// Responsive Search Ads (one+ per ad group). headlines/descriptions are jsonb arrays.
export const searchAds = pgTable(
  "search_ads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adGroupId: uuid("ad_group_id").references(() => adGroups.id).notNull(),
    campaignId: uuid("campaign_id").references(() => campaigns.id),
    headlines: jsonb("headlines").notNull(), // [{ text, pinnedField? }]
    descriptions: jsonb("descriptions").notNull(),
    finalUrls: text("final_urls").array(),
    path1: text("path1"),
    path2: text("path2"),
    adStrength: text("ad_strength"), // Google-reported (soft score, not a hard gate)
    googleAdId: bigint("google_ad_id", { mode: "number" }),
    isControl: boolean("is_control").default(false),
    policyApprovalStatus: text("policy_approval_status"), // polled from Google before ENABLE
    policyTopics: jsonb("policy_topics"),
    status: text("status").default("draft").notNull(), // draft|approved|live|quarantined|disapproved
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_search_ads_ad_group").on(table.adGroupId)]
);

// A/B RSA variants for ad rotation experiments.
export const rsaVariants = pgTable(
  "rsa_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adGroupId: uuid("ad_group_id").references(() => adGroups.id).notNull(),
    searchAdId: uuid("search_ad_id").references(() => searchAds.id),
    variantLabel: text("variant_label"),
    headlines: jsonb("headlines"),
    descriptions: jsonb("descriptions"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_rsa_variants_ad_group").on(table.adGroupId)]
);

// --- Assets / extensions (polymorphic) -------------------------------------

export const campaignAssets = pgTable(
  "campaign_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").references(() => campaigns.id).notNull(),
    assetType: text("asset_type").notNull(), // SITELINK|CALLOUT|STRUCTURED_SNIPPET|IMAGE|CALL|LEAD_FORM|PROMOTION|PRICE|LOGO
    data: jsonb("data").notNull(), // type-specific fields
    googleAssetResourceName: text("google_asset_resource_name"),
    status: text("status").default("draft").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_campaign_assets_campaign").on(table.campaignId)]
);

export const assetLinks = pgTable(
  "asset_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").references(() => campaignAssets.id).notNull(),
    level: text("level").notNull(), // CUSTOMER|CAMPAIGN|AD_GROUP
    campaignId: uuid("campaign_id"),
    adGroupId: uuid("ad_group_id"),
    googleAssetLinkResourceName: text("google_asset_link_resource_name"),
    status: text("status").default("draft").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_asset_links_asset").on(table.assetId)]
);

// --- Landing page analysis --------------------------------------------------

export const lpAnalysis = pgTable(
  "lp_analysis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adGroupId: uuid("ad_group_id").references(() => adGroups.id),
    campaignId: uuid("campaign_id"),
    url: text("url").notNull(),
    messageMatchScore: numeric("message_match_score", { precision: 5, scale: 4 }), // gate G9 >= 0.7
    mobileOk: boolean("mobile_ok"),
    httpStatus: integer("http_status"),
    speedMs: integer("speed_ms"),
    fixes: jsonb("fixes"), // prioritized on-page fix list
    applied: boolean("applied").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_lp_analysis_ad_group").on(table.adGroupId)]
);

// --- Conversion tracking (mirror of Google's account-level actions) ---------

export const conversionActions = pgTable(
  "conversion_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    googleAccountId: text("google_account_id"),
    campaignId: uuid("campaign_id"), // nullable — actions are account-level
    resourceName: text("resource_name").notNull(),
    googleId: bigint("google_id", { mode: "number" }),
    name: text("name"),
    category: text("category"), // PURCHASE | SIGNUP | BEGIN_CHECKOUT | DEFAULT | ...
    type: text("type"),
    status: text("status"),
    includeInConversions: boolean("include_in_conversions"),
    primaryForGoal: boolean("primary_for_goal"),
    countingType: text("counting_type"),
    attributionModel: text("attribution_model"),
    valueMicros: bigint("value_micros", { mode: "number" }),
    isPaidScoped: boolean("is_paid_scoped"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_conversion_actions_account").on(table.googleAccountId)]
);

// --- Bidding ladder audit ---------------------------------------------------

export const biddingLadderEvents = pgTable(
  "bidding_ladder_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").references(() => campaigns.id).notNull(),
    fromRung: text("from_rung"),
    toRung: text("to_rung"),
    fromStrategy: text("from_strategy"),
    toStrategy: text("to_strategy"),
    triggerMetric: text("trigger_metric"),
    triggerValue: text("trigger_value"),
    conv30d: numeric("conv_30d", { precision: 12, scale: 2 }),
    decidedBy: text("decided_by"), // 'code' | 'bid_strategist'
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_bidding_ladder_campaign").on(table.campaignId)]
);

// --- Keyword research provenance -------------------------------------------

export const keywordResearchRuns = pgTable(
  "keyword_research_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id"),
    runId: uuid("run_id").references(() => agentRuns.id),
    seeds: jsonb("seeds"),
    sources: jsonb("sources"), // which of the 6 sources contributed
    rounds: integer("rounds").default(0),
    totalIdeas: integer("total_ideas").default(0),
    kept: integer("kept").default(0),
    raw: jsonb("raw"), // summarized raw dump
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_kw_research_runs_campaign").on(table.campaignId)]
);

// --- Google mutations ledger (idempotent reconciliation by run-label) -------

export const googleMutations = pgTable(
  "google_mutations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => agentRuns.id),
    campaignId: uuid("campaign_id"),
    operation: text("operation").notNull(), // createBudget|createCampaign|createAdGroup|createAd|addKeywords|addNegatives|enable|...
    tempId: text("temp_id"), // negative temp resource id used in the atomic mutate
    resourceName: text("resource_name"), // returned by Google
    runLabel: text("run_label"), // label applied for GAQL reconciliation
    requestHash: text("request_hash"), // idempotency
    status: text("status").default("pending").notNull(), // pending|done|failed|reconciled
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_google_mutations_run").on(table.runId),
    index("idx_google_mutations_campaign").on(table.campaignId),
    index("idx_google_mutations_resource").on(table.resourceName),
  ]
);

// ============================================================================
// app_settings — key/value store for app-level config (LLM provider/model)
// and secrets (OpenRouter key). Lives in the ads DB (NOT the main Supabase).
// Secrets stored here are NEVER returned to the browser by the admin API.
// ============================================================================
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ============================================================================
// cost_events — the unified cost ledger. ONE append-only row per metered unit
// of spend: every LLM step (tokens + $) and every external API call (Google
// Ads, SearchApi, …). This is the single source of truth behind the /admin
// Costs panel (per-day / per-user / per-provider rollups). Soft refs only (no
// FKs) so a metering write can never block on a missing/late parent row, and
// recording is always best-effort — a ledger failure must never break a build.
// ============================================================================
export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Who/what incurred it (soft refs).
    userId: uuid("user_id"),
    brandId: uuid("brand_id"),
    workspaceId: uuid("workspace_id"),
    runId: uuid("run_id"),
    stepId: uuid("step_id"),
    // Taxonomy.
    category: text("category").notNull(), // 'llm' | 'external_api'
    provider: text("provider"), // 'anthropic' | 'openrouter' | 'google_ads' | 'searchapi'
    resource: text("resource"), // model id, or API operation name
    // Usage + cost.
    tokensIn: integer("tokens_in").default(0).notNull(),
    tokensOut: integer("tokens_out").default(0).notNull(),
    units: integer("units").default(0).notNull(), // non-token calls: # of results/requests
    costMicros: bigint("cost_micros", { mode: "number" }).default(0).notNull(),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_cost_events_occurred").on(table.occurredAt),
    index("idx_cost_events_user").on(table.userId),
    index("idx_cost_events_run").on(table.runId),
    index("idx_cost_events_provider").on(table.provider),
  ]
);

// ============================================================================
// benchmark_runs — the premium competitor-benchmark suite. One async job per
// run that crosses a brand with its competitors: Keyword Planner volumes/CPC
// (free), landing-page teardown + tracking extraction (free), and an OPTIONAL,
// admin-gated paid ad-spy. The final strategic report is stored in `result`.
// Soft refs only (no FKs) so a run can never block on a missing parent and is
// trivially purgeable. Progress is streamed via benchmark_events (below).
// ============================================================================
export const benchmarkRuns = pgTable(
  "benchmark_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    status: text("status").default("queued").notNull(), // queued|running|completed|failed
    // How the run was seeded — 'auto' (from the brand profile), or a manual
    // 'keyword' / 'domain' entry the user typed to steer the analysis.
    entryMode: text("entry_mode").default("auto").notNull(),
    seedKeywords: text("seed_keywords").array(),
    seedDomains: text("seed_domains").array(),
    countryCode: text("country_code"),
    languageCode: text("language_code"),
    // Whether the paid ad-spy block actually ran (admin gate + key present).
    liveEnabled: boolean("live_enabled").default(false).notNull(),
    stage: text("stage"), // human-readable current stage, mirrored in events
    progress: integer("progress").default(0).notNull(), // 0..100
    error: text("error"),
    result: jsonb("result"), // the full BenchmarkReport once completed
    costMicros: bigint("cost_micros", { mode: "number" }).default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_benchmark_runs_brand").on(table.brandId),
    index("idx_benchmark_runs_status").on(table.status),
  ]
);

// Append-only event log for a benchmark run. `seq` is the monotonic cursor the
// SSE reader tails (same shape/contract as agent_events). Soft ref to the run.
export const benchmarkEvents = pgTable(
  "benchmark_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    id: uuid("id").defaultRandom().notNull(),
    runId: uuid("run_id").notNull(),
    type: text("type").notNull(), // stage|progress|partial|done|error
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_benchmark_events_run_seq").on(table.runId, table.seq)]
);

// ============================================================
// Centro de Mando (beta) — multi-network execution rail.
// Spec: docs/superpowers/specs/2026-07-07-command-center-beta-design.md
// ============================================================

export const ccActions = pgTable(
  "cc_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    createdBy: text("created_by").notNull(), // session email
    network: text("network").notNull(), // google_ads|meta_ads
    connectionId: uuid("connection_id"), // Supabase ads_google_connections.id (null for Meta env-token)
    accountRef: text("account_ref").notNull(), // Google customer_id | Meta act_<id>
    entityKind: text("entity_kind").notNull(), // campaign|ad_group|adset
    entityRef: text("entity_ref").notNull(),
    entityName: text("entity_name"),
    actionType: text("action_type").notNull(), // budget_update|pause|enable|add_negatives
    payload: jsonb("payload").notNull(),
    expected: jsonb("expected"), // before-values captured at approve time (drift baseline)
    source: text("source").default("manual").notNull(), // engine|manual|regla|copiloto
    recKey: text("rec_key"), // dedup with engine proposals
    rationale: text("rationale"),
    evidence: jsonb("evidence"),
    status: text("status").default("proposed").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    gateResults: jsonb("gate_results"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_cc_actions_workspace").on(table.workspaceId),
    index("idx_cc_actions_status").on(table.status),
    index("idx_cc_actions_account").on(table.accountRef),
  ]
);

export const ccExecutions = pgTable(
  "cc_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionId: uuid("action_id")
      .references(() => ccActions.id)
      .notNull(),
    attempt: integer("attempt").default(1).notNull(),
    network: text("network").notNull(),
    accountRef: text("account_ref").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    validateOnly: boolean("validate_only").default(false).notNull(),
    before: jsonb("before").notNull(),
    request: jsonb("request"),
    response: jsonb("response"),
    after: jsonb("after"),
    rollbackRecipe: jsonb("rollback_recipe"),
    status: text("status").default("pending").notNull(), // pending|done|failed|rolled_back
    actor: text("actor").notNull(), // session email
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_cc_executions_action").on(table.actionId),
    uniqueIndex("uq_cc_executions_attempt").on(table.actionId, table.requestHash, table.attempt),
  ]
);

export const ccSettings = pgTable("cc_settings", {
  workspaceId: uuid("workspace_id").primaryKey(),
  executionsPaused: boolean("executions_paused").default(false).notNull(), // kill switch
  maxBudgetDeltaPct: integer("max_budget_delta_pct").default(30).notNull(),
  maxActionsPerAccountDay: integer("max_actions_per_account_day").default(20).notNull(),
  requireTwoStep: boolean("require_two_step").default(true).notNull(),
  allowedActionTypes: jsonb("allowed_action_types")
    .default(["budget_update", "pause", "enable", "add_negatives"])
    .notNull(),
  watchHours: integer("watch_hours").default(72).notNull(),
  maxDailyBudgetMicros: bigint("max_daily_budget_micros", { mode: "number" }),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
