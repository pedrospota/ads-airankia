import { describe, it, expect } from "bun:test";
import { parseEditDoc, type GoogleSearchEditDoc } from "../edit/schema";
import { diffEditDoc } from "../edit/diff";

// (fixture builder identical to edit-schema.test.ts's baseDoc(), inline here — tests must be self-contained)
function baseDoc(): GoogleSearchEditDoc {
  return parseEditDoc({
    docType: "google_search_edit_v1", network: "google_ads", accountRef: "123",
    loadedAt: "2026-07-07T12:00:00.000Z",
    campaign: {
      resourceName: "customers/123/campaigns/5", id: "5",
      base: { name: "C", status: "ENABLED", dailyBudgetMicros: 350_000_000, budgetResourceName: "customers/123/campaignBudgets/9", budgetShared: false, currency: "USD" },
      desired: { status: "ENABLED", dailyBudgetMicros: 350_000_000 },
      newNegatives: [],
      adGroups: [{
        resourceName: "customers/123/adGroups/7", id: "7",
        base: { name: "G", status: "ENABLED" }, desired: { status: "ENABLED" },
        baseKeywords: [{ text: "kw", match: "PHRASE", negative: false, resourceName: "customers/123/adGroupCriteria/7~1" }],
        newKeywords: [], newAds: [],
        ads: [{ resourceName: "customers/123/adGroupAds/7~11", unsupported: false,
          base: { status: "ENABLED", finalUrl: "https://x.com", headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }], descriptions: [{ text: "D1" }, { text: "D2" }] },
          replacement: null }],
      }],
    },
  });
}

const mk = baseDoc;

const REPL = { tempId: "t1", finalUrl: "https://x.com", headlines: [{ text: "A" }, { text: "B" }, { text: "C" }], descriptions: [{ text: "d1" }, { text: "d2" }] };

describe("diffEditDoc — mapping", () => {
  it("no changes → []", () => expect(diffEditDoc(mk(), "bp1")).toHaveLength(0));

  it("budget change → budget_update with field-scoped expected", () => {
    const d = mk(); d.campaign.desired.dailyBudgetMicros = 500_000_000;
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("budget_update");
    expect(a.entityRef).toBe("5");                                    // numeric id, v1 convention
    expect(a.payload).toEqual({ newDailyBudgetMicros: 500_000_000 });
    expect(a.expected).toEqual({ dailyBudgetMicros: 350_000_000 });   // ONLY the mutated field
  });

  it("campaign status flip → pause with expected {status: base}", () => {
    const d = mk(); d.campaign.desired.status = "PAUSED";
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("pause"); expect(a.expected).toEqual({ status: "ENABLED" });
  });

  it("newNegatives → add_negatives with expected null", () => {
    const d = mk(); d.campaign.newNegatives = [{ text: "gratis", match: "EXACT" }];
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("add_negatives"); expect(a.expected).toBeNull();
  });

  it("newKeywords → create_keywords with REAL adGroupRef and tmp entityRef", () => {
    const d = mk(); d.campaign.adGroups[0].newKeywords = [{ text: "kw2", match: "PHRASE", negative: false }];
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("create_keywords");
    expect((a.payload as { adGroupRef: string }).adGroupRef).toBe("customers/123/adGroups/7");
    expect(a.entityRef.startsWith("tmp:")).toBe(true);
  });

  it("RSA replace on an ENABLED ad → create_ad immediately followed by paired pause(old, FULL ref)", () => {
    const d = mk(); d.campaign.adGroups[0].ads[0].replacement = REPL;
    const acts = diffEditDoc(d, "bp1");
    const i = acts.findIndex(a => a.actionType === "create_ad");
    expect(acts[i + 1].actionType).toBe("pause");
    expect(acts[i + 1].entityKind).toBe("ad");
    expect(acts[i + 1].entityRef).toBe("customers/123/adGroupAds/7~11");
    expect(acts[i + 1].expected).toEqual({ status: "ENABLED" });
  });

  it("RSA replace on a PAUSED ad → create_ad only (no pause)", () => {
    const d = mk(); d.campaign.adGroups[0].ads[0].base.status = "PAUSED";
    d.campaign.adGroups[0].ads[0].replacement = REPL;
    const acts = diffEditDoc(d, "bp1");
    expect(acts.filter(a => a.actionType === "pause")).toHaveLength(0);
  });
});

describe("diffEditDoc — ordering (phases A..E)", () => {
  it("pause intents first, enables LAST, creates in between", () => {
    const d = mk();
    d.campaign.adGroups[0].desired.status = "PAUSED";        // A (ad-group pause)
    d.campaign.desired.dailyBudgetMicros = 500_000_000;      // B
    d.campaign.newNegatives = [{ text: "n", match: "EXACT" }]; // C
    d.campaign.adGroups[0].newKeywords = [{ text: "k", match: "PHRASE", negative: false }]; // D
    d.campaign.desired.status = "ENABLED";                   // no-op (already ENABLED)
    const order = diffEditDoc(d, "bp1").map(a => a.actionType);
    expect(order).toEqual(["pause", "budget_update", "add_negatives", "create_keywords"]);
  });

  it("seq is contiguous from 0 and recKey is deterministic", () => {
    const d = mk(); d.campaign.desired.dailyBudgetMicros = 500_000_000;
    const [a1] = diffEditDoc(d, "bp1"); const [a2] = diffEditDoc(d, "bp1");
    expect(a1.seq).toBe(0); expect(a1.recKey).toBe(a2.recKey); expect(a1.recKey.startsWith("ed-")).toBe(true);
  });
});

describe("diffEditDoc — fail-closed throws", () => {
  it("throws on budget change while budgetShared", () => {
    const d = mk(); d.campaign.base.budgetShared = true; d.campaign.desired.dailyBudgetMicros = 500_000_000;
    expect(() => diffEditDoc(d, "bp1")).toThrow(/compartido/);
  });

  it("throws on replacement of an unsupported ad", () => {
    const d = mk(); d.campaign.adGroups[0].ads[0].unsupported = true; d.campaign.adGroups[0].ads[0].replacement = REPL;
    expect(() => diffEditDoc(d, "bp1")).toThrow();
  });

  it("throws on duplicate tempId across newAds/replacements", () => {
    const d = mk();
    d.campaign.adGroups[0].newAds = [{ ...REPL, tempId: "dup" }];
    d.campaign.adGroups[0].ads[0].replacement = { ...REPL, tempId: "dup" };
    expect(() => diffEditDoc(d, "bp1")).toThrow(/tempId/);
  });

  it("no non-create action ever carries a tmp: ref (self-assert)", () => {
    const d = mk(); d.campaign.desired.status = "PAUSED"; d.campaign.adGroups[0].newKeywords = [{ text: "k", match: "PHRASE", negative: false }];
    for (const a of diffEditDoc(d, "bp1"))
      if (!a.actionType.startsWith("create_")) expect(a.entityRef.startsWith("tmp:")).toBe(false);
  });
});
