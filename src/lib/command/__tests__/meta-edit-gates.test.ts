import { describe, it, expect } from "bun:test";
import { blockingFailures, runGates, type GateInput } from "../gates";
import { CC_SETTINGS_DEFAULTS, type EntitySnapshot } from "../types";

// Documenting tests for two meta-edit properties of the UNTOUCHED gates.ts —
// they pin behavior this feature depends on, so a future gates change that
// breaks either assumption fails here with context instead of in production.

function metaEditInput(over: Partial<GateInput> = {}): GateInput {
  return {
    settings: { ...CC_SETTINGS_DEFAULTS },
    network: "meta_ads",
    action: { actionType: "budget_update", entityKind: "adset", entityRef: "222", payload: { newDailyBudgetMicros: 22_000_000 } },
    capabilities: { read: true, write: true, actionTypes: ["budget_update", "pause", "enable"] },
    before: {
      entityKind: "adset", entityRef: "222", status: "ENABLED",
      dailyBudgetMicros: 20_000_000, learningPhase: "STABLE",
      conversions30d: 5, spend30dMicros: 100_000_000,
    } as EntitySnapshot,
    expected: null,
    executedTodayForAccount: 0,
    validateResult: null,
    ...over,
  };
}

describe("meta-edit risk #4 — DRIFT compares CONFIGURED status, like-for-like", () => {
  it("passes when configured status matches expected, even while effective_status diverges (raw rides along only)", () => {
    // buildMetaEditDoc bases the doc on Graph configured `status` (Task 2) and
    // the adapter's snapshot() maps entity.status the same way — so an adset
    // configured ACTIVE inside a paused campaign (effective CAMPAIGN_PAUSED)
    // must NOT drift: both sides of the comparison speak configured status.
    const rs = runGates(metaEditInput({
      action: { actionType: "pause", entityKind: "adset", entityRef: "222", payload: {} },
      expected: { status: "ENABLED" },
      before: {
        entityKind: "adset", entityRef: "222", status: "ENABLED", // configured, mapped by snapshot()
        raw: { effective_status: "CAMPAIGN_PAUSED" },             // divergent effective — display-only
      } as EntitySnapshot,
    }));
    expect(rs.find((g) => g.id === "DRIFT")!.status).toBe("pass");
  });

  it("still blocks on a REAL configured-status change (the guard is alive, not neutered)", () => {
    const rs = runGates(metaEditInput({
      action: { actionType: "pause", entityKind: "adset", entityRef: "222", payload: {} },
      expected: { status: "ENABLED" },
      before: { entityKind: "adset", entityRef: "222", status: "PAUSED" } as EntitySnapshot,
    }));
    expect(blockingFailures(rs).map((g) => g.id)).toContain("DRIFT");
  });
});

describe("meta-edit risk #12 — LEARNING_PHASE preview-vs-execute divergence (accepted + documented)", () => {
  it("preview side: the synthetic before (seeded from expected) has NO learningPhase → gate passes", () => {
    // preview.ts's meta-edit branch builds before = {status:'UNKNOWN', ...expected};
    // a budget_update's expected carries only dailyBudgetMicros — learningPhase
    // is absent, so LEARNING_PHASE cannot fire at preview time.
    const rs = runGates(metaEditInput({
      before: {
        entityKind: "adset", entityRef: "222", status: "UNKNOWN",
        dailyBudgetMicros: 20_000_000, // ...expected spread — no learningPhase
      } as EntitySnapshot,
    }));
    expect(rs.find((g) => g.id === "LEARNING_PHASE")!.status).toBe("pass");
  });

  it("execute side: the real snapshot may reveal LEARNING and hard-block adset budget/enable", () => {
    // This is the DESIGNED divergence: "compuertas N/N" on the review screen is
    // a preview, not a guarantee — the executor re-runs gates against the live
    // snapshot (learning_stage_info included, Task 2 snapshot fields) and a
    // LEARNING adset blocks budget_update/enable at publish time (gates.ts).
    const rs = runGates(metaEditInput({
      before: {
        entityKind: "adset", entityRef: "222", status: "ENABLED",
        dailyBudgetMicros: 20_000_000, learningPhase: "LEARNING",
      } as EntitySnapshot,
    }));
    expect(blockingFailures(rs).map((g) => g.id)).toContain("LEARNING_PHASE");
  });
});
