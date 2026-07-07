import { describe, it, expect } from "bun:test";
import { rowToSettings } from "../settings";
import { runGates, type GateInput } from "../gates";
import { CC_SETTINGS_DEFAULTS, type CcCreateActionType, type CreateCampaignPayload, type EntitySnapshot } from "../types";

const CREATE_TYPES: CcCreateActionType[] = ["create_budget", "create_campaign", "create_ad_group", "create_keywords", "create_ad"];

describe("rowToSettings", () => {
  it("returns defaults for null row", () => {
    expect(rowToSettings(null)).toEqual(CC_SETTINGS_DEFAULTS);
  });
  it("maps a row and sanitizes allowed types", () => {
    const v = rowToSettings({
      executionsPaused: true, maxBudgetDeltaPct: 15, maxActionsPerAccountDay: 5,
      requireTwoStep: false, allowedActionTypes: ["pause", "nope"], watchHours: 24,
    });
    expect(v.executionsPaused).toBe(true);
    expect(v.maxBudgetDeltaPct).toBe(15);
    expect(v.allowedActionTypes).toEqual(["pause"]);
  });

  // Regression coverage for the bug where rowToSettings stripped create_* types
  // (filtered through CC_ACTION_TYPES, which never included them) even though
  // migration 008 wrote them into cc_settings.allowed_action_types. That made
  // every v2 create-flow publish 409 on the ACTION_ALLOWED gate.
  it("preserves create_* types loaded from a migrated DB row (does not strip them)", () => {
    const v = rowToSettings({
      allowedActionTypes: ["budget_update", ...CREATE_TYPES],
    });
    for (const t of CREATE_TYPES) {
      expect(v.allowedActionTypes).toContain(t);
    }
    expect(v.allowedActionTypes).toContain("budget_update");
  });

  it("defaults (null row / no settings row) include the create_* types", () => {
    const v = rowToSettings(null);
    for (const t of CREATE_TYPES) {
      expect(v.allowedActionTypes).toContain(t);
    }
  });

  it("end-to-end: create_campaign passes ACTION_ALLOWED using settings loaded via rowToSettings(null)", () => {
    const settings = rowToSettings(null);
    const before: EntitySnapshot = {
      entityKind: "campaign", entityRef: "tmp:campaign-1", name: null, status: "UNKNOWN",
      dailyBudgetMicros: null, currency: "USD", learningPhase: "UNKNOWN",
      conversions30d: null, spend30dMicros: null,
    };
    const payload: CreateCampaignPayload = {
      name: "New Campaign", status: "PAUSED", channel: "SEARCH", budgetRef: "tmp:budget-1",
      bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
      geoTargetIds: ["2840"], presenceOnly: true,
    };
    const input: GateInput = {
      settings,
      network: "google_ads",
      action: { actionType: "create_campaign", entityKind: "campaign", entityRef: "tmp:campaign-1", payload },
      capabilities: { read: true, write: true, actionTypes: [...CREATE_TYPES, "budget_update", "pause", "enable", "add_negatives"] as never },
      before,
      expected: null,
      executedTodayForAccount: 0,
      validateResult: { ok: true },
    };
    const results = runGates(input);
    const actionAllowed = results.find((r) => r.id === "ACTION_ALLOWED");
    expect(actionAllowed?.status).toBe("pass");
  });
});
