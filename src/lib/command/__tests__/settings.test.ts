import { describe, it, expect } from "bun:test";
import { rowToSettings } from "../settings";
import { CC_SETTINGS_DEFAULTS } from "../types";

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
});
