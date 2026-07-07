import { describe, it, expect } from "bun:test";
import { canTransition, assertTransition } from "../state";
import type { CcActionStatus } from "../types";

describe("canTransition", () => {
  it("allows the happy path", () => {
    expect(canTransition("proposed", "approved")).toBe(true);
    expect(canTransition("approved", "executing")).toBe(true);
    expect(canTransition("executing", "executed")).toBe(true);
    expect(canTransition("executed", "rolled_back")).toBe(true);
    expect(canTransition("executed", "verified")).toBe(true);
  });
  it("allows rejection/expiry and retry-after-failure", () => {
    expect(canTransition("proposed", "rejected")).toBe(true);
    expect(canTransition("proposed", "expired")).toBe(true);
    expect(canTransition("approved", "rejected")).toBe(true);
    expect(canTransition("executing", "failed")).toBe(true);
    expect(canTransition("failed", "approved")).toBe(true); // re-arm after fix
  });
  it("blocks illegal jumps", () => {
    expect(canTransition("proposed", "executed")).toBe(false);
    expect(canTransition("proposed", "executing")).toBe(false);
    expect(canTransition("rejected", "executing")).toBe(false);
    expect(canTransition("rolled_back", "executed")).toBe(false);
    expect(canTransition("executed", "approved")).toBe(false);
  });
  it("assertTransition throws in Spanish", () => {
    expect(() => assertTransition("proposed", "executed")).toThrow(/Transición inválida/);
  });
});

describe("canTransition (exhaustive adjacency)", () => {
  const ALL_STATUSES: CcActionStatus[] = [
    "proposed",
    "approved",
    "executing",
    "executed",
    "verified",
    "failed",
    "rolled_back",
    "rejected",
    "expired",
  ];

  // Mirrors the TRANSITIONS table in ../state.ts exactly.
  const EXPECTED: Record<CcActionStatus, CcActionStatus[]> = {
    proposed: ["approved", "rejected", "expired"],
    approved: ["executing", "rejected", "expired"],
    executing: ["executed", "failed"],
    executed: ["verified", "rolled_back"],
    verified: ["rolled_back"],
    failed: ["approved", "rejected"],
    rolled_back: [],
    rejected: [],
    expired: [],
  };

  it("matches the expected adjacency map for all 81 (from, to) pairs", () => {
    const mismatches: string[] = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = EXPECTED[from].includes(to);
        const actual = canTransition(from, to);
        if (actual !== expected) {
          mismatches.push(`${from} -> ${to}: expected ${expected}, got ${actual}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
