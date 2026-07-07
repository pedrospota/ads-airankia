import { describe, it, expect } from "bun:test";
import { META_THRESHOLDS, GOOGLE_THRESHOLDS, budgetStepOk, isFatigued, RSA_SPEC } from "../knowledge";

describe("knowledge constants", () => {
  it("exposes the canonical scaling + kill numbers", () => {
    expect(META_THRESHOLDS.scaleStepPct).toBe(20);
    expect(META_THRESHOLDS.scaleCadenceDays).toBe(5);
    expect(META_THRESHOLDS.killCpaMultiple).toBe(3);
    expect(META_THRESHOLDS.learningConversionsPerWeek).toBe(50);
    expect(GOOGLE_THRESHOLDS.smartBiddingMinConv30d).toBe(30);
    expect(GOOGLE_THRESHOLDS.budgetSpendMultiplierPerDay).toBe(2);
  });
  it("budgetStepOk enforces +20%/5d style single-step ceiling", () => {
    expect(budgetStepOk(10_000_000, 12_000_000)).toBe(true);   // +20%
    expect(budgetStepOk(10_000_000, 13_000_000)).toBe(false);  // +30%
    expect(budgetStepOk(10_000_000, 9_000_000)).toBe(true);    // decrease always ok
  });
  it("isFatigued flags frequency+CTR-decay on prospecting", () => {
    expect(isFatigued({ campaignType: "prospecting", frequency7d: 4.5, ctrDeltaPct: -25 })).toBe(true);
    expect(isFatigued({ campaignType: "prospecting", frequency7d: 1.5, ctrDeltaPct: -5 })).toBe(false);
    expect(isFatigued({ campaignType: "retargeting", frequency7d: 5.0, ctrDeltaPct: -10 })).toBe(false);
  });
  it("RSA_SPEC carries Google's real RSA limits", () => {
    expect(RSA_SPEC.headline.maxLen).toBe(30);
    expect(RSA_SPEC.headline.min).toBe(3);
    expect(RSA_SPEC.headline.max).toBe(15);
    expect(RSA_SPEC.description.maxLen).toBe(90);
    expect(RSA_SPEC.description.min).toBe(2);
    expect(RSA_SPEC.description.max).toBe(4);
    expect(RSA_SPEC.path.maxLen).toBe(15);
  });
});
