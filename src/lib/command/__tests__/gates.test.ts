import { describe, it, expect } from "bun:test";
import { runGates, blockingFailures, type GateInput } from "../gates";
import { CC_SETTINGS_DEFAULTS, type EntitySnapshot } from "../types";

function baseBefore(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return {
    entityKind: "campaign", entityRef: "123", name: "Test", status: "ENABLED",
    dailyBudgetMicros: 10_000_000, currency: "USD", learningPhase: "STABLE",
    conversions30d: 12, spend30dMicros: 500_000_000, ...over,
  };
}
function baseInput(over: Partial<GateInput> = {}): GateInput {
  return {
    settings: { ...CC_SETTINGS_DEFAULTS },
    network: "google_ads",
    action: { actionType: "pause", entityKind: "campaign", entityRef: "123", payload: {} },
    capabilities: { read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives"] },
    before: baseBefore(),
    expected: null,
    executedTodayForAccount: 0,
    validateResult: { ok: true },
    ...over,
  };
}
const failed = (rs: ReturnType<typeof runGates>) => rs.filter(r => r.status === "fail").map(r => r.id);

function metaInput(over: Partial<GateInput> = {}): GateInput {
  return baseInput({
    network: "meta_ads",
    capabilities: {
      read: true, write: true,
      actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives",
        "create_campaign", "create_adset", "create_ad", "remove_entity"],
    },
    action: {
      actionType: "create_adset", entityKind: "adset", entityRef: "tmp:as:1",
      payload: {
        name: "A", status: "PAUSED", campaignRef: "tmp:c:1", dailyBudgetMicros: 10_000_000,
        optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", bidStrategy: "LOWEST_COST_WITHOUT_CAP",
        targeting: { countryCodes: ["MX"], ageMin: 18, ageMax: 65 },
      } as never,
    },
    validateResult: { ok: true },
    ...over,
  });
}

describe("gates", () => {
  it("all pass on a clean pause", () => {
    expect(failed(runGates(baseInput()))).toEqual([]);
  });
  it("KILL_SWITCH blocks when paused", () => {
    const rs = runGates(baseInput({ settings: { ...CC_SETTINGS_DEFAULTS, executionsPaused: true } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("KILL_SWITCH");
  });
  it("CAPABILITY blocks when adapter cannot write", () => {
    const rs = runGates(baseInput({ capabilities: { read: true, write: false, actionTypes: [], reason: "sin token" } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("CAPABILITY");
  });
  it("ACTION_ALLOWED blocks types outside settings", () => {
    const rs = runGates(baseInput({ settings: { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: ["pause"] },
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 11_000_000 } } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("ACTION_ALLOWED");
  });
  it("ACTION_ALLOWED fails closed (no throw) when allowedActionTypes is malformed", () => {
    const bad = { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: null as unknown as typeof CC_SETTINGS_DEFAULTS.allowedActionTypes };
    let rs!: ReturnType<typeof runGates>;
    expect(() => { rs = runGates(baseInput({ settings: bad })); }).not.toThrow();
    expect(rs!.find(r => r.id === "ACTION_ALLOWED")?.status).toBe("fail");
  });
  it("CAPABILITY fails closed (no throw) when actionTypes is malformed", () => {
    const caps = { read: true, write: true, actionTypes: null as unknown as string[] };
    let rs!: ReturnType<typeof runGates>;
    expect(() => { rs = runGates(baseInput({ capabilities: caps as never })); }).not.toThrow();
    expect(rs!.find(r => r.id === "CAPABILITY")?.status).toBe("fail");
  });
  it("ACTION_ALLOWED permits remove_negatives (internal rollback type)", () => {
    const rs = runGates(baseInput({ action: { actionType: "remove_negatives", entityKind: "campaign", entityRef: "123", payload: { resourceNames: ["rn1"] } } }));
    expect(rs.find(r => r.id === "ACTION_ALLOWED")?.status).toBe("pass");
  });
  it("DRIFT blocks when live state departed from expected", () => {
    const rs = runGates(baseInput({ expected: { status: "PAUSED" } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("DRIFT");
    const ok = runGates(baseInput({ expected: { status: "ENABLED", dailyBudgetMicros: 10_000_000 } }));
    expect(failed(ok)).toEqual([]);
  });
  it("DRIFT ignores approve-time metrics context (conversions30d/spend30dMicros)", () => {
    // spec §a "Free bonus": approve now persists conversions30d/spend30dMicros
    // into `expected` alongside status/dailyBudgetMicros. The DRIFT gate must
    // read only status/dailyBudgetMicros, so the extra keys are inert.
    const withoutMetrics = runGates(baseInput({ expected: { status: "ENABLED", dailyBudgetMicros: 10_000_000 } }));
    const withMetrics = runGates(baseInput({
      expected: { status: "ENABLED", dailyBudgetMicros: 10_000_000, conversions30d: 999, spend30dMicros: 123_456_789 },
    }));
    expect(withMetrics.find(r => r.id === "DRIFT")).toEqual(withoutMetrics.find(r => r.id === "DRIFT"));
    expect(failed(withMetrics)).toEqual([]);

    // Same drift-triggering baseline, with or without the extra metrics keys,
    // must produce the identical DRIFT result.
    const driftWithout = runGates(baseInput({ expected: { status: "PAUSED" } }));
    const driftWith = runGates(baseInput({ expected: { status: "PAUSED", conversions30d: 5, spend30dMicros: 1 } }));
    expect(driftWith.find(r => r.id === "DRIFT")).toEqual(driftWithout.find(r => r.id === "DRIFT"));
  });
  it("BUDGET_DELTA blocks >30% and nonpositive; passes 20%", () => {
    const mk = (n: number) => baseInput({ action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: n } } });
    expect(blockingFailures(runGates(mk(14_000_000))).map(r => r.id)).toContain("BUDGET_DELTA"); // +40%
    expect(blockingFailures(runGates(mk(0))).map(r => r.id)).toContain("BUDGET_DELTA");
    expect(failed(runGates(mk(12_000_000)))).toEqual([]); // +20%
  });
  it("BUDGET_DELTA blocks when no baseline budget", () => {
    const rs = runGates(baseInput({
      before: baseBefore({ dailyBudgetMicros: null }),
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 12_000_000 } },
    }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("BUDGET_DELTA");
  });
  it("BLAST_RADIUS blocks at the daily cap", () => {
    const rs = runGates(baseInput({ executedTodayForAccount: 20 }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("BLAST_RADIUS");
  });
  it("CURRENCY_SANITY blocks non-integer or sub-minimum budgets", () => {
    const mk = (n: number) => baseInput({ action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: n } } });
    expect(blockingFailures(runGates(mk(10_000_000.5))).map(r => r.id)).toContain("CURRENCY_SANITY");
    expect(blockingFailures(runGates(mk(900_000))).map(r => r.id)).toContain("CURRENCY_SANITY"); // < 1 unit
  });
  it("LEARNING_PHASE: blocking on meta adset learning + budget/enable; warning on google", () => {
    const meta = runGates(baseInput({
      network: "meta_ads",
      before: baseBefore({ entityKind: "adset", learningPhase: "LEARNING", dailyBudgetMicros: 10_000_000 }),
      action: { actionType: "budget_update", entityKind: "adset", entityRef: "123", payload: { newDailyBudgetMicros: 11_000_000 } },
      validateResult: null,
    }));
    expect(blockingFailures(meta).map(r => r.id)).toContain("LEARNING_PHASE");
    const goog = runGates(baseInput({ before: baseBefore({ learningPhase: "LEARNING" }) }));
    const lp = goog.find(r => r.id === "LEARNING_PHASE");
    expect(lp?.status).toBe("fail");
    expect(lp?.severity).toBe("warning");
  });
  it("TRACKING_SIGNAL warns on spend with zero conversions", () => {
    const rs = runGates(baseInput({ before: baseBefore({ conversions30d: 0, spend30dMicros: 100_000_000 }) }));
    const t = rs.find(r => r.id === "TRACKING_SIGNAL");
    expect(t?.status).toBe("fail");
    expect(t?.severity).toBe("warning");
    expect(blockingFailures(rs)).toHaveLength(0);
  });
  it("VALIDATE_ONLY blocks on failed google rehearsal; ignored for meta", () => {
    const rs = runGates(baseInput({ validateResult: { ok: false, detail: "INVALID_ARGUMENT" } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("VALIDATE_ONLY");
    const meta = runGates(baseInput({ network: "meta_ads", validateResult: null }));
    expect(failed(meta)).toEqual([]);
  });
  it("ABS_BUDGET_CAP blocks budgets over the absolute ceiling", () => {
    const settings = { ...CC_SETTINGS_DEFAULTS, maxDailyBudgetMicros: 50_000_000 };
    const over = runGates(baseInput({ settings,
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 60_000_000 } } }));
    expect(blockingFailures(over).map(r => r.id)).toContain("ABS_BUDGET_CAP");
    const under = runGates(baseInput({ settings,
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 12_000_000 } } }));
    expect(under.filter(r => r.status === "fail").map(r => r.id)).not.toContain("ABS_BUDGET_CAP");
  });
  it("ABS_BUDGET_CAP passes when no ceiling configured", () => {
    const rs = runGates(baseInput({
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 999_000_000 } } }));
    expect(rs.find(r => r.id === "ABS_BUDGET_CAP")?.status).toBe("pass");
  });
  it("META_LEARNING_RESET warns on Meta budget delta over 20%", () => {
    const rs = runGates(baseInput({ network: "meta_ads", validateResult: null,
      before: baseBefore({ entityKind: "adset", dailyBudgetMicros: 10_000_000 }),
      action: { actionType: "budget_update", entityKind: "adset", entityRef: "123", payload: { newDailyBudgetMicros: 12_500_000 } } }));
    const g = rs.find(r => r.id === "META_LEARNING_RESET");
    expect(g?.status).toBe("fail");
    expect(g?.severity).toBe("warning");
    expect(blockingFailures(rs).map(r => r.id)).not.toContain("META_LEARNING_RESET");
  });
  it("META_LEARNING_RESET passes on a real small Meta budget delta (<=20%)", () => {
    const rs = runGates(baseInput({ network: "meta_ads", validateResult: null,
      before: baseBefore({ entityKind: "adset", dailyBudgetMicros: 10_000_000 }),
      action: { actionType: "budget_update", entityKind: "adset", entityRef: "123", payload: { newDailyBudgetMicros: 11_000_000 } } }));
    expect(rs.find(r => r.id === "META_LEARNING_RESET")?.status).toBe("pass");
  });
  it("BUDGET_DELTA passes at exactly the 30% boundary", () => {
    const rs = runGates(baseInput({
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 13_000_000 } } }));
    expect(rs.find(r => r.id === "BUDGET_DELTA")?.status).toBe("pass");
  });
  it("ABS_BUDGET_CAP passes at exactly the cap", () => {
    const settings = { ...CC_SETTINGS_DEFAULTS, maxDailyBudgetMicros: 50_000_000 };
    const rs = runGates(baseInput({ settings,
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 50_000_000 } } }));
    expect(rs.find(r => r.id === "ABS_BUDGET_CAP")?.status).toBe("pass");
  });
  it("META_LEARNING_RESET passes at exactly the 20% boundary", () => {
    const rs = runGates(baseInput({ network: "meta_ads", validateResult: null,
      before: baseBefore({ entityKind: "adset", dailyBudgetMicros: 10_000_000 }),
      action: { actionType: "budget_update", entityKind: "adset", entityRef: "123", payload: { newDailyBudgetMicros: 12_000_000 } } }));
    expect(rs.find(r => r.id === "META_LEARNING_RESET")?.status).toBe("pass");
  });
  it("CURRENCY_SANITY passes at exactly MICROS_PER_UNIT", () => {
    const rs = runGates(baseInput({
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 1_000_000 } } }));
    expect(rs.find(r => r.id === "CURRENCY_SANITY")?.status).toBe("pass");
  });
  it("ACTION_ALLOWED permits remove_entity (internal rollback type)", () => {
    const rs = runGates(baseInput({
      capabilities: { read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives", "remove_entity"] },
      action: { actionType: "remove_entity", entityKind: "campaign", entityRef: "temp:campaign:2", payload: { resourceNames: ["rn1"] } } }));
    expect(rs.find(r => r.id === "ACTION_ALLOWED")?.status).toBe("pass");
  });
  it("CURRENCY_SANITY + ABS_BUDGET_CAP apply to create_budget too", () => {
    const settings = { ...CC_SETTINGS_DEFAULTS, maxDailyBudgetMicros: 50_000_000, allowedActionTypes: [...(CC_SETTINGS_DEFAULTS.allowedActionTypes ?? []), "create_budget" as never] };
    const over = runGates(baseInput({
      settings,
      capabilities: { read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives", "create_budget"] as never },
      action: { actionType: "create_budget" as never, entityKind: "campaign", entityRef: "temp:budget:1", payload: { name: "b", newDailyBudgetMicros: undefined, amountMicros: 60_000_000 } as never } }));
    expect(blockingFailures(over).map(r => r.id)).toContain("ABS_BUDGET_CAP");
    const bad = runGates(baseInput({
      settings: { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: [...(CC_SETTINGS_DEFAULTS.allowedActionTypes ?? []), "create_budget" as never] },
      capabilities: { read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives", "create_budget"] as never },
      action: { actionType: "create_budget" as never, entityKind: "campaign", entityRef: "temp:budget:1", payload: { name: "b", amountMicros: 900_000 } as never } }));
    expect(blockingFailures(bad).map(r => r.id)).toContain("CURRENCY_SANITY");
  });
  it("PAUSED_ON_CREATE blocks a create_campaign not PAUSED and passes when PAUSED", () => {
    const bad = runGates(baseInput({
      settings: { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: [...(CC_SETTINGS_DEFAULTS.allowedActionTypes ?? []), "create_campaign" as never] },
      capabilities: { read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives", "create_campaign"] as never },
      action: { actionType: "create_campaign" as never, entityKind: "campaign", entityRef: "temp:campaign:2", payload: { name: "c", status: "ENABLED" } as never } }));
    expect(blockingFailures(bad).map(r => r.id)).toContain("PAUSED_ON_CREATE");
    const ok = runGates(baseInput({
      settings: { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: [...(CC_SETTINGS_DEFAULTS.allowedActionTypes ?? []), "create_campaign" as never] },
      capabilities: { read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives", "create_campaign"] as never },
      action: { actionType: "create_campaign" as never, entityKind: "campaign", entityRef: "temp:campaign:2", payload: { name: "c", status: "PAUSED" } as never } }));
    expect(ok.find(r => r.id === "PAUSED_ON_CREATE")?.status).toBe("pass");
  });
  it("ABS_BUDGET_CAP + CURRENCY_SANITY apply to create_adset.dailyBudgetMicros", () => {
    const over = runGates(metaInput({
      settings: { ...CC_SETTINGS_DEFAULTS, maxDailyBudgetMicros: 50_000_000 },
      action: {
        actionType: "create_adset", entityKind: "adset", entityRef: "tmp:as:1",
        payload: {
          name: "A", status: "PAUSED", campaignRef: "tmp:c:1", dailyBudgetMicros: 60_000_000,
          optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", bidStrategy: "LOWEST_COST_WITHOUT_CAP",
          targeting: { countryCodes: ["MX"], ageMin: 18, ageMax: 65 },
        } as never,
      },
    }));
    expect(blockingFailures(over).map(r => r.id)).toContain("ABS_BUDGET_CAP");
  });
  it("THE 100x TRIPWIRE: a cents value smuggled as micros (3500) fails CURRENCY_SANITY", () => {
    const rs = runGates(metaInput({
      action: {
        actionType: "create_adset", entityKind: "adset", entityRef: "tmp:as:1",
        payload: {
          name: "A", status: "PAUSED", campaignRef: "tmp:c:1", dailyBudgetMicros: 3500,
          optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", bidStrategy: "LOWEST_COST_WITHOUT_CAP",
          targeting: { countryCodes: ["MX"], ageMin: 18, ageMax: 65 },
        } as never,
      },
    }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("CURRENCY_SANITY");
  });
  it("PAUSED_ON_CREATE blocks a non-PAUSED create_adset and passes PAUSED", () => {
    const bad = runGates(metaInput({
      action: {
        actionType: "create_adset", entityKind: "adset", entityRef: "tmp:as:1",
        payload: {
          name: "A", status: "ACTIVE", campaignRef: "tmp:c:1", dailyBudgetMicros: 10_000_000,
          optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", bidStrategy: "LOWEST_COST_WITHOUT_CAP",
          targeting: { countryCodes: ["MX"], ageMin: 18, ageMax: 65 },
        } as never,
      },
    }));
    expect(blockingFailures(bad).map(r => r.id)).toContain("PAUSED_ON_CREATE");
    const ok = runGates(metaInput());
    expect(ok.find(r => r.id === "PAUSED_ON_CREATE")?.status).toBe("pass");
  });
  it("VALIDATE_ONLY: meta create without validateResult fails closed; meta v1 pause passes No-aplica; meta remove_entity passes", () => {
    const noRehearsal = runGates(metaInput({ validateResult: null }));
    expect(blockingFailures(noRehearsal).map(r => r.id)).toContain("VALIDATE_ONLY");

    const v1Pause = runGates(baseInput({
      network: "meta_ads",
      action: { actionType: "pause", entityKind: "adset", entityRef: "123", payload: {} },
      validateResult: null,
    }));
    expect(v1Pause.find(r => r.id === "VALIDATE_ONLY")?.status).toBe("pass");

    const removeEntity = runGates(baseInput({
      network: "meta_ads",
      capabilities: { read: true, write: true, actionTypes: ["remove_entity"] },
      action: { actionType: "remove_entity", entityKind: "adset", entityRef: "123", payload: { resourceNames: ["rn1"] } },
      validateResult: null,
    }));
    expect(removeEntity.find(r => r.id === "VALIDATE_ONLY")?.status).toBe("pass");
  });
  it("VALIDATE_ONLY: google behavior byte-identical (existing tests still green)", () => {
    const missing = runGates(baseInput({ validateResult: null }));
    expect(blockingFailures(missing).map(r => r.id)).toContain("VALIDATE_ONLY");
    const failedRehearsal = runGates(baseInput({ validateResult: { ok: false, detail: "INVALID_ARGUMENT" } }));
    expect(blockingFailures(failedRehearsal).map(r => r.id)).toContain("VALIDATE_ONLY");
    const passed = runGates(baseInput({ validateResult: { ok: true } }));
    expect(passed.find(r => r.id === "VALIDATE_ONLY")?.status).toBe("pass");
  });

  // ==========================================================================
  // v2.7 Weekly Loop — maintenance verbs (update_keyword_status/update_cpc) +
  // the promotion of remove_negatives out of INTERNAL_ACTION_TYPES.
  // ==========================================================================

  it("CPC_DELTA blocks a delta over maxBudgetDeltaPct and passes within it", () => {
    const mk = (newCpcBidMicros: number) => baseInput({
      before: baseBefore({ entityKind: "ad_group", cpcBidMicros: 1_000_000 }),
      capabilities: { read: true, write: true, actionTypes: ["update_cpc"] },
      action: { actionType: "update_cpc", entityKind: "ad_group", entityRef: "456", payload: { newCpcBidMicros } },
    });
    expect(blockingFailures(runGates(mk(1_400_000))).map(r => r.id)).toContain("CPC_DELTA"); // +40%
    expect(runGates(mk(1_200_000)).find(r => r.id === "CPC_DELTA")?.status).toBe("pass"); // +20%
  });

  it("CPC_DELTA passes open («Sin CPC base») when before.cpcBidMicros is null", () => {
    const rs = runGates(baseInput({
      before: baseBefore({ entityKind: "ad_group", cpcBidMicros: null }),
      capabilities: { read: true, write: true, actionTypes: ["update_cpc"] },
      action: { actionType: "update_cpc", entityKind: "ad_group", entityRef: "456", payload: { newCpcBidMicros: 5_000_000 } },
    }));
    const g = rs.find(r => r.id === "CPC_DELTA");
    expect(g?.status).toBe("pass");
    expect(g?.evidence).toContain("Sin CPC base");
  });

  it("CPC_DELTA does not apply to other action types (No aplica)", () => {
    const rs = runGates(baseInput());
    expect(rs.find(r => r.id === "CPC_DELTA")?.status).toBe("pass");
  });

  it("CURRENCY_SANITY: update_cpc floor rejects 9_999, passes 10_000, rejects non-integer, and never trips ABS_BUDGET_CAP", () => {
    const mk = (newCpcBidMicros: number) => baseInput({
      settings: { ...CC_SETTINGS_DEFAULTS, maxDailyBudgetMicros: 50_000_000 },
      before: baseBefore({ entityKind: "ad_group", cpcBidMicros: 1_000_000 }),
      capabilities: { read: true, write: true, actionTypes: ["update_cpc"] },
      action: { actionType: "update_cpc", entityKind: "ad_group", entityRef: "456", payload: { newCpcBidMicros } },
    });
    expect(blockingFailures(runGates(mk(9_999))).map(r => r.id)).toContain("CURRENCY_SANITY"); // cents-as-micros
    expect(runGates(mk(10_000)).find(r => r.id === "CURRENCY_SANITY")?.status).toBe("pass");
    expect(blockingFailures(runGates(mk(10_000.5))).map(r => r.id)).toContain("CURRENCY_SANITY"); // non-integer
    // update_cpc must never be routed through the budget-only ABS_BUDGET_CAP check,
    // even with a huge CPC value and a low absolute budget ceiling configured.
    const rs = runGates(mk(60_000_000));
    expect(rs.find(r => r.id === "ABS_BUDGET_CAP")?.status).toBe("pass");
  });

  it("DRIFT: cpcBidMicros both-present blocks on mismatch and passes on match", () => {
    const before = baseBefore({ entityKind: "ad_group", cpcBidMicros: 1_000_000 });
    const mismatched = runGates(baseInput({ before, expected: { status: "ENABLED", cpcBidMicros: 900_000 } }));
    expect(blockingFailures(mismatched).map(r => r.id)).toContain("DRIFT");
    const matched = runGates(baseInput({ before, expected: { status: "ENABLED", cpcBidMicros: 1_000_000 } }));
    expect(matched.find(r => r.id === "DRIFT")?.status).toBe("pass");
  });

  it("DRIFT: a legacy expected baseline without cpcBidMicros does not false-block (risk #3)", () => {
    const before = baseBefore({ entityKind: "ad_group", cpcBidMicros: 1_000_000 });
    const rs = runGates(baseInput({ before, expected: { status: "ENABLED", dailyBudgetMicros: 10_000_000 } }));
    expect(rs.find(r => r.id === "DRIFT")?.status).toBe("pass");
  });

  it("ACTION_ALLOWED passes the 3 v2.7 verbs under default settings", () => {
    const cases: Array<{ actionType: string; entityKind: "ad_group" | "campaign"; payload: unknown }> = [
      { actionType: "update_keyword_status", entityKind: "ad_group",
        payload: { status: "PAUSED", keywords: [{ resourceName: "customers/1/adGroupCriteria/1~1", text: "shoes" }] } },
      { actionType: "update_cpc", entityKind: "ad_group", payload: { newCpcBidMicros: 1_000_000 } },
      { actionType: "remove_negatives", entityKind: "campaign", payload: { resourceNames: ["rn1"] } },
    ];
    for (const c of cases) {
      const rs = runGates(baseInput({
        action: { actionType: c.actionType as never, entityKind: c.entityKind, entityRef: "1", payload: c.payload as never },
      }));
      expect(rs.find(r => r.id === "ACTION_ALLOWED")?.status).toBe("pass");
    }
  });

  it("ACTION_ALLOWED still auto-passes remove_entity as internal even with an empty allow-list", () => {
    const rs = runGates(baseInput({
      settings: { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: [] },
      action: { actionType: "remove_entity", entityKind: "campaign", entityRef: "1", payload: { resourceNames: ["rn1"] } },
    }));
    const g = rs.find(r => r.id === "ACTION_ALLOWED");
    expect(g?.status).toBe("pass");
    expect(g?.evidence).toContain("rollback interno");
  });

  it("ACTION_ALLOWED now blocks remove_negatives when NOT allow-listed (promotion: no longer internal-only)", () => {
    const rs = runGates(baseInput({
      settings: { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: ["pause"] },
      action: { actionType: "remove_negatives", entityKind: "campaign", entityRef: "123", payload: { resourceNames: ["rn1"] } },
    }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("ACTION_ALLOWED");
  });
});
