import { eq } from "drizzle-orm";
import { adsDb } from "@/lib/ads-db";
import { ccSettings } from "@/lib/schema";
import { CC_SETTINGS_ACTION_TYPES, CC_SETTINGS_DEFAULTS, type CcActionType, type CcCreateActionType, type CcSettingsValues } from "./types";

interface SettingsRowShape {
  executionsPaused?: unknown; maxBudgetDeltaPct?: unknown; maxActionsPerAccountDay?: unknown;
  requireTwoStep?: unknown; allowedActionTypes?: unknown; watchHours?: unknown;
  maxDailyBudgetMicros?: unknown;
}

export function rowToSettings(row: SettingsRowShape | null | undefined): CcSettingsValues {
  if (!row) return { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: [...CC_SETTINGS_DEFAULTS.allowedActionTypes] };
  const allowed = Array.isArray(row.allowedActionTypes)
    ? (row.allowedActionTypes as unknown[]).filter(
        (t): t is CcActionType | CcCreateActionType => CC_SETTINGS_ACTION_TYPES.includes(t as CcActionType | CcCreateActionType)
      )
    : [...CC_SETTINGS_DEFAULTS.allowedActionTypes];
  return {
    executionsPaused: Boolean(row.executionsPaused),
    maxBudgetDeltaPct: Number(row.maxBudgetDeltaPct ?? CC_SETTINGS_DEFAULTS.maxBudgetDeltaPct),
    maxActionsPerAccountDay: Number(row.maxActionsPerAccountDay ?? CC_SETTINGS_DEFAULTS.maxActionsPerAccountDay),
    requireTwoStep: row.requireTwoStep === undefined ? true : Boolean(row.requireTwoStep),
    allowedActionTypes: allowed,
    watchHours: Number(row.watchHours ?? CC_SETTINGS_DEFAULTS.watchHours),
    maxDailyBudgetMicros: row.maxDailyBudgetMicros == null ? null : Number(row.maxDailyBudgetMicros),
  };
}

export async function getCcSettings(workspaceId: string): Promise<CcSettingsValues> {
  const rows = await adsDb.select().from(ccSettings).where(eq(ccSettings.workspaceId, workspaceId)).limit(1);
  return rowToSettings(rows[0] ?? null);
}

export async function saveCcSettings(workspaceId: string, values: Partial<CcSettingsValues>, updatedBy: string): Promise<CcSettingsValues> {
  const current = await getCcSettings(workspaceId);
  const next: CcSettingsValues = { ...current, ...values };
  await adsDb
    .insert(ccSettings)
    .values({
      workspaceId,
      executionsPaused: next.executionsPaused,
      maxBudgetDeltaPct: next.maxBudgetDeltaPct,
      maxActionsPerAccountDay: next.maxActionsPerAccountDay,
      requireTwoStep: next.requireTwoStep,
      allowedActionTypes: next.allowedActionTypes,
      watchHours: next.watchHours,
      maxDailyBudgetMicros: next.maxDailyBudgetMicros,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: ccSettings.workspaceId,
      set: {
        executionsPaused: next.executionsPaused,
        maxBudgetDeltaPct: next.maxBudgetDeltaPct,
        maxActionsPerAccountDay: next.maxActionsPerAccountDay,
        requireTwoStep: next.requireTwoStep,
        allowedActionTypes: next.allowedActionTypes,
        watchHours: next.watchHours,
        maxDailyBudgetMicros: next.maxDailyBudgetMicros,
        updatedBy,
        updatedAt: new Date(),
      },
    });
  return next;
}
