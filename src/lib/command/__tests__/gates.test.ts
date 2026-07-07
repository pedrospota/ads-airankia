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
  it("DRIFT blocks when live state departed from expected", () => {
    const rs = runGates(baseInput({ expected: { status: "PAUSED" } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("DRIFT");
    const ok = runGates(baseInput({ expected: { status: "ENABLED", dailyBudgetMicros: 10_000_000 } }));
    expect(failed(ok)).toEqual([]);
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
  it("META_LEARNING_RESET passes on Google or small Meta deltas", () => {
    expect(runGates(baseInput()).find(r => r.id === "META_LEARNING_RESET")?.status).toBe("pass");
  });
});
