// Centro de Mando — frozen domain contract. Pure types + constants only.
// No env access, no side effects. See docs/superpowers/specs/2026-07-07-command-center-beta-design.md

export type CcNetwork = "google_ads" | "meta_ads";
export type CcEntityKind = "campaign" | "ad_group" | "adset";

// User-selectable action types. "remove_negatives" is INTERNAL-ONLY: it exists
// so rollbacks of add_negatives can be expressed as an action; it is never
// user-proposable and never allowed by cc_settings.allowed_action_types.
export type CcActionType = "budget_update" | "pause" | "enable" | "add_negatives";
export type CcInternalActionType = CcActionType | "remove_negatives";

export const CC_ACTION_TYPES: readonly CcActionType[] = Object.freeze(["budget_update", "pause", "enable", "add_negatives"]);

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
export type CcPayload =
  | BudgetUpdatePayload | NegativesPayload | RemoveNegativesPayload | Record<string, never>;

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
  allowedActionTypes: CcActionType[];
  /** Absolute per-entity daily-budget ceiling in micros; null = disabled. */
  maxDailyBudgetMicros: number | null;
  watchHours: number;
}

export const CC_SETTINGS_DEFAULTS: Readonly<CcSettingsValues> = Object.freeze({
  executionsPaused: false,
  maxBudgetDeltaPct: 30,
  maxActionsPerAccountDay: 20,
  requireTwoStep: true,
  allowedActionTypes: [...CC_ACTION_TYPES],
  maxDailyBudgetMicros: null,
  watchHours: 72,
});

export const MICROS_PER_UNIT = 1_000_000;
/** Meta daily_budget is in minor units (cents). cents * 10_000 = micros. */
export const MICROS_PER_MINOR_UNIT = 10_000;
