import { describe, it, expect } from "bun:test";
import { canTransition, assertTransition } from "../state";

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
