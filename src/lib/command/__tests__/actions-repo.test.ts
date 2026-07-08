import { describe, it, expect } from "bun:test";
import { hasBlockingGateFailure } from "../actions-repo";
import { runGates, type GateInput } from "../gates";
import { CC_SETTINGS_DEFAULTS, type EntitySnapshot } from "../types";

// ---------------------------------------------------------------------------
// hasBlockingGateFailure — pins the REAL GateResult shape gates.ts produces
// (id/severity/status/evidence). Novedades' "bloqueadas por compuertas"
// category depends on this exact shape (design spec top-risk: "a gates.ts
// shape change would silently empty that category — add a test pinning the
// shape"). Every "true" case below runs the REAL runGates() — not a
// hand-rolled GateResult literal — so a rename/reshape in gates.ts fails
// THIS test instead of silently zeroing out the Novedades count.
// ---------------------------------------------------------------------------

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

describe("hasBlockingGateFailure", () => {
  it("true for a REAL runGates() output containing a blocking failure (KILL_SWITCH engaged)", () => {
    const input = baseInput({ settings: { ...CC_SETTINGS_DEFAULTS, executionsPaused: true } });
    const results = runGates(input);
    // Sanity: this input actually produces a blocking fail (mirrors gates.test.ts).
    expect(results.some((r) => r.severity === "blocking" && r.status === "fail")).toBe(true);
    expect(hasBlockingGateFailure(results)).toBe(true);
  });

  it("true for a REAL runGates() output blocked by ACTION_ALLOWED (a different gate than KILL_SWITCH — not overfit to one gate id)", () => {
    const input = baseInput({
      settings: { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: ["pause"] },
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 11_000_000 } },
    });
    const results = runGates(input);
    expect(results.some((r) => r.id === "ACTION_ALLOWED" && r.severity === "blocking" && r.status === "fail")).toBe(true);
    expect(hasBlockingGateFailure(results)).toBe(true);
  });

  it("false for a REAL runGates() output where every gate passes (clean pause)", () => {
    const results = runGates(baseInput());
    expect(results.every((r) => r.status === "pass")).toBe(true); // sanity
    expect(hasBlockingGateFailure(results)).toBe(false);
  });

  it("false for a WARNING-severity failure — TRACKING_SIGNAL (spend, zero conversions) must not count as blocking", () => {
    const input = baseInput({ before: baseBefore({ spend30dMicros: 100_000_000, conversions30d: 0 }) });
    const results = runGates(input);
    const trackingResult = results.find((r) => r.id === "TRACKING_SIGNAL");
    expect(trackingResult).toMatchObject({ severity: "warning", status: "fail" }); // sanity: it's a warning fail, not blocking
    expect(hasBlockingGateFailure(results)).toBe(false);
  });

  it("defensive: non-array / null / malformed elements never throw, always return false", () => {
    expect(hasBlockingGateFailure(null)).toBe(false);
    expect(hasBlockingGateFailure(undefined)).toBe(false);
    expect(hasBlockingGateFailure("not-an-array")).toBe(false);
    expect(hasBlockingGateFailure([])).toBe(false);
    expect(hasBlockingGateFailure([null, 42, { severity: "blocking" }, { status: "fail" }])).toBe(false);
  });

  it("(shape-drift regression) a differently-shaped element — renamed fields — is NOT detected", () => {
    // Demonstrates exactly the failure mode the spec risk warns about: if
    // gates.ts ever renamed severity/status to something else, a hand-rolled
    // fixture using the OLD field names would keep passing here while the
    // real category silently went to zero. The tests above guard against
    // that by running the REAL runGates() output instead.
    expect(hasBlockingGateFailure([{ id: "X", sev: "blocking", state: "fail", evidence: "y" }])).toBe(false);
  });

  it("only a blocking+fail combination counts — blocking+pass and warning+fail on their own do not", () => {
    expect(hasBlockingGateFailure([{ id: "A", severity: "blocking", status: "pass", evidence: "" }])).toBe(false);
    expect(hasBlockingGateFailure([{ id: "B", severity: "warning", status: "fail", evidence: "" }])).toBe(false);
    expect(hasBlockingGateFailure([{ id: "C", severity: "blocking", status: "fail", evidence: "" }])).toBe(true);
  });
});
