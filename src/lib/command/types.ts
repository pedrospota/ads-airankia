// Centro de Mando — frozen domain contract. Pure types + constants only.
// No env access, no side effects. See docs/superpowers/specs/2026-07-07-command-center-beta-design.md

export type CcNetwork = "google_ads" | "meta_ads";
export type CcEntityKind = "campaign" | "ad_group" | "adset" | "ad";

// User-selectable action types. "remove_negatives" is INTERNAL-ONLY: it exists
// so rollbacks of add_negatives can be expressed as an action; it is never
// user-proposable and never allowed by cc_settings.allowed_action_types.
export type CcActionType = "budget_update" | "pause" | "enable" | "add_negatives";
export type CcCreateActionType =
  | "create_budget" | "create_campaign" | "create_ad_group" | "create_keywords" | "create_ad" | "create_adset";
export type CcInternalActionType = CcActionType | CcCreateActionType | "remove_negatives" | "remove_entity";

export const CC_ACTION_TYPES: readonly CcActionType[] = Object.freeze(["budget_update", "pause", "enable", "add_negatives"]);

/**
 * Settings-permitted action types: the v1 CC_ACTION_TYPES plus the 5 user-proposable
 * create_* types emitted by the v2 blueprint flow. Deliberately excludes
 * "remove_negatives"/"remove_entity" (internal-only rollback types, never
 * user-proposable, always allowed by gates regardless of cc_settings).
 * Used for the cc_settings.allowed_action_types allow-list (load + save), NOT for
 * validating manual/v1 action creation (that still uses CC_ACTION_TYPES).
 */
export const CC_SETTINGS_ACTION_TYPES: readonly (CcActionType | CcCreateActionType)[] = Object.freeze([
  ...CC_ACTION_TYPES,
  "create_budget", "create_campaign", "create_ad_group", "create_keywords", "create_ad", "create_adset",
]);

export type CcActionStatus =
  | "proposed" | "approved" | "executing" | "executed"
  | "verified" | "failed" | "rolled_back" | "rejected" | "expired";

export type CcSource = "engine" | "manual" | "regla" | "copiloto";

export interface BudgetUpdatePayload { newDailyBudgetMicros: number }
export interface NegativesPayload {
  negatives: Array<{ text: string; match: "EXACT" | "PHRASE" | "BROAD" }>;
}
/** pause/enable carry an empty payload. remove_negatives carries resourceNames. */
export interface RemoveNegativesPayload { resourceNames: string[] }
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

export interface NetworkAdapter {
  network: CcNetwork;
  capabilities(auth: AdapterAuth): AdapterCapabilities;
  listCampaigns(auth: AdapterAuth, accountRef: string): Promise<EntitySnapshot[]>;
  snapshot(auth: AdapterAuth, accountRef: string, entityKind: CcEntityKind, entityRef: string): Promise<EntitySnapshot>;
  /** Google only: server-side rehearsal via validateOnly. Meta: undefined. */
  validate?(auth: AdapterAuth, accountRef: string, action: CcActionInput, before: EntitySnapshot): Promise<{ ok: boolean; detail?: string }>;
  execute(auth: AdapterAuth, accountRef: string, action: CcActionInput, before: EntitySnapshot): Promise<ExecuteResult>;
  buildRollback(action: CcActionInput, before: EntitySnapshot, exec: ExecuteResult): RollbackRecipe | null;
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
  allowedActionTypes: (CcActionType | CcCreateActionType)[];
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
