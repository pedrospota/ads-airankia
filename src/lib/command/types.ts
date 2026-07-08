// Centro de Mando — frozen domain contract. Pure types + constants only.
// No env access, no side effects. See docs/superpowers/specs/2026-07-07-command-center-beta-design.md

export type CcNetwork = "google_ads" | "meta_ads";
export type CcEntityKind = "campaign" | "ad_group" | "adset" | "ad";

// User-selectable action types. "remove_entity" is the sole INTERNAL-ONLY type
// left: it exists so rollbacks of create_* actions can be expressed as an
// action; it is never user-proposable and never allowed by cc_settings.
// allowed_action_types. "remove_negatives" is NOT internal-only (v2.7
// promotion) — it is a normal user-proposable verb that ALSO doubles as the
// internal rollback of add_negatives; that rollback usage bypasses
// ACTION_ALLOWED via the rollback path's hard-blocker filter (executor.ts),
// not via INTERNAL_ACTION_TYPES.
export type CcActionType = "budget_update" | "pause" | "enable" | "add_negatives";
export type CcCreateActionType =
  | "create_budget" | "create_campaign" | "create_ad_group" | "create_keywords" | "create_ad" | "create_adset";
/** v2.7 maintenance verbs: batched keyword pause/reactivate + ad-group CPC edit. Both user-proposable. */
export type CcMaintenanceActionType = "update_keyword_status" | "update_cpc";
export type CcInternalActionType =
  CcActionType | CcCreateActionType | CcMaintenanceActionType | "remove_negatives" | "remove_entity";

export const CC_ACTION_TYPES: readonly CcActionType[] = Object.freeze(["budget_update", "pause", "enable", "add_negatives"]);

/** Element type of the cc_settings allow-list — every user-proposable verb. */
export type CcSettingsActionType = CcActionType | CcCreateActionType | CcMaintenanceActionType | "remove_negatives";

/**
 * Settings-permitted action types: the v1 CC_ACTION_TYPES, the 5 user-proposable
 * create_* types emitted by the v2 blueprint flow, and (v2.7) the 2 new
 * maintenance verbs plus the promoted "remove_negatives". Deliberately excludes
 * "remove_entity" — the sole remaining internal-only rollback type, never
 * user-proposable, always allowed by gates regardless of cc_settings.
 * Used for the cc_settings.allowed_action_types allow-list (load + save), NOT for
 * validating manual/v1 action creation (that still uses CC_ACTION_TYPES).
 */
export const CC_SETTINGS_ACTION_TYPES: readonly CcSettingsActionType[] = Object.freeze([
  ...CC_ACTION_TYPES,
  "create_budget", "create_campaign", "create_ad_group", "create_keywords", "create_ad", "create_adset",
  "update_keyword_status", "update_cpc", "remove_negatives",
]);

export type CcActionStatus =
  | "proposed" | "approved" | "executing" | "executed"
  | "verified" | "failed" | "rolled_back" | "rejected" | "expired";

export type CcSource = "engine" | "manual" | "regla" | "copiloto";

export interface BudgetUpdatePayload { newDailyBudgetMicros: number }
export interface NegativesPayload {
  negatives: Array<{ text: string; match: "EXACT" | "PHRASE" | "BROAD" }>;
}
/**
 * pause/enable carry an empty payload. remove_negatives carries the
 * resourceNames to remove plus an optional `removed` snapshot (text+match per
 * negative) — `removed` is what makes rollback (re-add) possible. The internal
 * rollback-of-add_negatives caller passes only resourceNames, so its own
 * rollback recipe is null (no rollback-of-rollback).
 */
export interface RemoveNegativesPayload {
  resourceNames: string[];
  removed?: Array<{ text: string; match: "EXACT" | "PHRASE" | "BROAD" }>;
}
/** v2.7: batched pause/reactivate of positive ad-group keyword criteria (self-inverse — rollback is the same verb with inverted status). */
export interface UpdateKeywordStatusPayload {
  status: "PAUSED" | "ENABLED";
  /** `text` rides along for ledger/Bitácora legibility only; not used by the mutation. */
  keywords: Array<{ resourceName: string; text: string }>;
}
/** v2.7: ad-group cpcBidMicros change (integer micros). */
export interface UpdateCpcPayload { newCpcBidMicros: number }
export type BiddingStrategy = "MAXIMIZE_CONVERSIONS" | "TARGET_CPA" | "TARGET_ROAS";
/** A parent reference: either a live Google resourceName or a `tmp:<localRef>` placeholder. */
export type CcRef = string;
export interface CreateBudgetPayload { name: string; amountMicros: number }
export interface CreateCampaignPayload {
  name: string; status: "PAUSED"; channel: "SEARCH"; budgetRef: CcRef;
  bidding: { strategy: BiddingStrategy; targetCpaMicros?: number; targetRoas?: number };
  geoTargetIds: string[]; languageId?: string; presenceOnly: boolean;
}
export interface CreateAdGroupPayload { name: string; campaignRef: CcRef; cpcBidMicros?: number }
export interface CreateKeywordsPayload {
  adGroupRef: CcRef;
  keywords: Array<{ text: string; match: "EXACT" | "PHRASE" | "BROAD"; negative?: boolean }>;
}
export interface CreateAdPayload {
  adGroupRef: CcRef; finalUrl: string;
  headlines: Array<{ text: string; pinnedField?: string }>;
  descriptions: Array<{ text: string }>; path1?: string; path2?: string;
}
export interface MetaCreateCampaignPayload {
  name: string; status: "PAUSED";
  objective: "OUTCOME_TRAFFIC"; buyingType: "AUCTION";
  specialAdCategories: string[];               // slice 1: always []
}
export interface MetaCreateAdsetPayload {
  name: string; status: "PAUSED"; campaignRef: CcRef;   // tmp:<campaign tempId>
  dailyBudgetMicros: number;                             // RAIL MICROS — adapter converts to cents
  optimizationGoal: "LINK_CLICKS"; billingEvent: "IMPRESSIONS";
  bidStrategy: "LOWEST_COST_WITHOUT_CAP";
  targeting: { countryCodes: string[]; ageMin: number; ageMax: number };
}
export interface MetaCreateAdPayload {
  name: string; status: "ACTIVE"; adsetRef: CcRef;       // tmp:<adset tempId>
  creative: { link: string; message: string; headline?: string; description?: string;
    callToActionType?: "LEARN_MORE"|"CONTACT_US"|"SHOP_NOW"|"SIGN_UP"|"GET_QUOTE";
    imageUrl?: string };                                 // → link_data.picture (optional)
}
export interface RemoveEntityPayload { resourceNames: string[] }
export type CcPayload =
  | BudgetUpdatePayload | NegativesPayload | RemoveNegativesPayload
  | UpdateKeywordStatusPayload | UpdateCpcPayload
  | CreateBudgetPayload | CreateCampaignPayload | CreateAdGroupPayload
  | CreateKeywordsPayload | CreateAdPayload
  | MetaCreateCampaignPayload | MetaCreateAdsetPayload | MetaCreateAdPayload
  | RemoveEntityPayload
  | Record<string, never>;

/** What the executor hands to an adapter. */
export interface CcActionInput {
  actionType: CcInternalActionType;
  entityKind: CcEntityKind;
  entityRef: string;          // Google campaign/adGroup id · Meta campaign/adset id
  payload: CcPayload;
}

export interface AdapterAuth {
  /** Google: decrypted per-connection refresh token (memory only). */
  googleRefreshToken?: string;
  /** Google: manager id when the target account is reached through an MCC. */
  googleLoginCustomerId?: string;
}

export interface AdapterCapabilities {
  read: boolean;
  write: boolean;
  actionTypes: CcInternalActionType[];
  reason?: string;            // e.g. "META_SYSTEM_USER_TOKEN no configurado"
}

export interface EntitySnapshot {
  entityKind: CcEntityKind;
  entityRef: string;
  name?: string | null;
  status?: "ENABLED" | "PAUSED" | "REMOVED" | "ARCHIVED" | "UNKNOWN";
  dailyBudgetMicros?: number | null;   // ALWAYS micros, both networks
  cpcBidMicros?: number | null;        // ad_group only; null = smart-bidding (no manual CPC)
  budgetResourceName?: string | null;  // Google: customers/x/campaignBudgets/y
  currency?: string | null;
  learningPhase?: "LEARNING" | "LIMITED" | "STABLE" | "UNKNOWN";
  conversions30d?: number | null;
  spend30dMicros?: number | null;
  raw?: Record<string, unknown>;
}

export interface ExecuteResult {
  operation: string;                    // "campaignBudgets:mutate" | "POST /{id}" ...
  request: unknown;
  response: unknown;
  resourceNames?: string[];             // created resources (negatives) for rollback
}

export interface RollbackRecipe {
  action: CcActionInput;
  note: string;                         // human-readable Spanish description
}

export interface AccountInfo {
  network: CcNetwork;
  accountRef: string;                   // Google customer_id · Meta "act_123"
  name?: string | null;
  currency?: string | null;
  connectionId?: string | null;         // Supabase ads_google_connections.id
}

/** v2.6: on-demand campaign performance read. "7d" | "30d" only (custom ranges deferred). */
export type CcMetricsRange = "7d" | "30d";

/**
 * v2.6 sibling read (NOT an extension of EntitySnapshot/listCampaigns — see
 * design spec §a). entityRef joins EntitySnapshot.entityRef; the caller merges
 * by id with zero-defaults, so a campaign missing from this list still renders
 * (zero-impression campaigns must never be silently dropped from the entity list).
 */
export interface CampaignMetrics {
  entityRef: string;
  spendMicros: number; clicks: number; impressions: number; conversions: number;
}

export interface NetworkAdapter {
  network: CcNetwork;
  capabilities(auth: AdapterAuth): AdapterCapabilities;
  listCampaigns(auth: AdapterAuth, accountRef: string): Promise<EntitySnapshot[]>;
  snapshot(auth: AdapterAuth, accountRef: string, entityKind: CcEntityKind, entityRef: string): Promise<EntitySnapshot>;
  /** Google only: server-side rehearsal via validateOnly. Meta: undefined. */
  validate?(auth: AdapterAuth, accountRef: string, action: CcActionInput, before: EntitySnapshot): Promise<{ ok: boolean; detail?: string }>;
  execute(auth: AdapterAuth, accountRef: string, action: CcActionInput, before: EntitySnapshot): Promise<ExecuteResult>;
  buildRollback(action: CcActionInput, before: EntitySnapshot, exec: ExecuteResult): RollbackRecipe | null;
  /** OPTIONAL v2.6 read: bulk campaign-level spend/clicks/impressions/conversions for the range. */
  listCampaignMetrics?(auth: AdapterAuth, accountRef: string, range: CcMetricsRange): Promise<CampaignMetrics[]>;
}

export interface GateResult {
  id: string;
  severity: "blocking" | "warning";
  status: "pass" | "fail";
  evidence: string;
}

export interface CcSettingsValues {
  executionsPaused: boolean;
  maxBudgetDeltaPct: number;
  maxActionsPerAccountDay: number;
  requireTwoStep: boolean;
  allowedActionTypes: CcSettingsActionType[];
  /** Absolute per-entity daily-budget ceiling in micros; null = disabled. */
  maxDailyBudgetMicros: number | null;
  watchHours: number;
}

export const CC_SETTINGS_DEFAULTS: Readonly<CcSettingsValues> = Object.freeze({
  executionsPaused: false,
  maxBudgetDeltaPct: 30,
  maxActionsPerAccountDay: 20,
  requireTwoStep: true,
  allowedActionTypes: [...CC_SETTINGS_ACTION_TYPES],
  maxDailyBudgetMicros: null,
  watchHours: 72,
});

export const MICROS_PER_UNIT = 1_000_000;
/** Meta daily_budget is in minor units (cents). cents * 10_000 = micros. */
export const MICROS_PER_MINOR_UNIT = 10_000;
