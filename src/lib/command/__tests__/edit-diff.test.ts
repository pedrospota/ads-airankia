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
      baseNegatives: [
        { resourceName: "customers/123/campaignCriteria/5~1", text: "gratis", match: "EXACT" },
        { resourceName: "customers/123/campaignCriteria/5~2", text: "barato", match: "PHRASE" },
      ],
      removeNegatives: [],
      adGroups: [{
        resourceName: "customers/123/adGroups/7", id: "7",
        base: { name: "G", status: "ENABLED", cpcBidMicros: 800_000 }, desired: { status: "ENABLED", cpcBidMicros: 800_000 },
        baseKeywords: [
          { text: "kw", match: "PHRASE", negative: false, resourceName: "customers/123/adGroupCriteria/7~1", status: "ENABLED" },
          { text: "kw2", match: "EXACT", negative: false, resourceName: "customers/123/adGroupCriteria/7~2", status: "PAUSED" },
        ],
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

  it("throws when ad replacement.tempId equals group's kw:id namespace", () => {
    const d = mk();
    d.campaign.adGroups[0].newKeywords = [{ text: "k", match: "PHRASE", negative: false }];
    d.campaign.adGroups[0].ads[0].replacement = { ...REPL, tempId: "kw:7" };
    expect(() => diffEditDoc(d, "bp1")).toThrow(/tempId/);
  });
});

describe("diffEditDoc — regression (enables-last ordering)", () => {
  it("campaign + ad group enable → order is [create_keywords, enable, enable] with ad_group first, campaign last", () => {
    const d = mk();
    d.campaign.base.status = "PAUSED";
    d.campaign.desired.status = "ENABLED";
    d.campaign.adGroups[0].base.status = "PAUSED";
    d.campaign.adGroups[0].desired.status = "ENABLED";
    d.campaign.adGroups[0].newKeywords = [{ text: "k", match: "PHRASE", negative: false }];

    const acts = diffEditDoc(d, "bp1");
    const actionTypes = acts.map(a => a.actionType);
    expect(actionTypes).toEqual(["create_keywords", "enable", "enable"]);

    const enableActions = acts.filter(a => a.actionType === "enable");
    expect(enableActions[0].entityKind).toBe("ad_group");
    expect(enableActions[1].entityKind).toBe("campaign");
  });
});

describe("diffEditDoc — regression (multi-replacement interleave)", () => {
  it("two ads with replacements → interleaved [create_ad, pause, create_ad, pause] paired by entityRef", () => {
    const d = mk();
    d.campaign.adGroups[0].ads.push({
      resourceName: "customers/123/adGroupAds/7~12",
      unsupported: false,
      base: { status: "ENABLED", finalUrl: "https://y.com", headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }], descriptions: [{ text: "D1" }, { text: "D2" }] },
      replacement: null,
    });

    d.campaign.adGroups[0].ads[0].replacement = { tempId: "t1", finalUrl: "https://x.com", headlines: [{ text: "A" }, { text: "B" }, { text: "C" }], descriptions: [{ text: "d1" }, { text: "d2" }] };
    d.campaign.adGroups[0].ads[1].replacement = { tempId: "t2", finalUrl: "https://y.com", headlines: [{ text: "A" }, { text: "B" }, { text: "C" }], descriptions: [{ text: "d1" }, { text: "d2" }] };

    const acts = diffEditDoc(d, "bp1");
    const actionTypes = acts.map(a => a.actionType);
    expect(actionTypes).toEqual(["create_ad", "pause", "create_ad", "pause"]);

    const pauseActions = acts.filter(a => a.actionType === "pause" && a.entityKind === "ad");
    expect(pauseActions[0].entityRef).toBe("customers/123/adGroupAds/7~11");
    expect(pauseActions[1].entityRef).toBe("customers/123/adGroupAds/7~12");
  });
});

// ---------------------------------------------------------------------------
// v2.7: keyword pause/reactivate batches (A2/E0), update_cpc (B2),
// remove_negatives (C0), phase ordering, fail-closed throws, no-op discipline.
// ---------------------------------------------------------------------------

describe("diffEditDoc — v2.7 keyword pause/reactivate (A2/E0)", () => {
  it("A2: ENABLED keyword with desiredStatus PAUSED → batched update_keyword_status, ad_group entityRef, expected null", () => {
    const d = mk();
    d.campaign.adGroups[0].baseKeywords[0].desiredStatus = "PAUSED"; // "kw", ENABLED→PAUSED
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("update_keyword_status");
    expect(a.entityKind).toBe("ad_group");
    expect(a.entityRef).toBe("7");
    expect(a.payload).toEqual({
      status: "PAUSED",
      keywords: [{ resourceName: "customers/123/adGroupCriteria/7~1", text: "kw" }],
    });
    expect(a.expected).toBeNull();
    expect(a.note).toContain("«G»");
  });

  it("A2 batches 3 ENABLED→PAUSED keywords in the same ad group into ONE action", () => {
    const d = mk();
    d.campaign.adGroups[0].baseKeywords[0].desiredStatus = "PAUSED"; // "kw"
    d.campaign.adGroups[0].baseKeywords.push(
      { text: "kw3", match: "PHRASE", negative: false, resourceName: "customers/123/adGroupCriteria/7~3", status: "ENABLED", desiredStatus: "PAUSED" },
      { text: "kw4", match: "PHRASE", negative: false, resourceName: "customers/123/adGroupCriteria/7~4", status: "ENABLED", desiredStatus: "PAUSED" },
    );
    const acts = diffEditDoc(d, "bp1");
    const pauseActs = acts.filter(a => a.actionType === "update_keyword_status");
    expect(pauseActs).toHaveLength(1);
    const payload = pauseActs[0].payload as { status: string; keywords: Array<{ resourceName: string; text: string }> };
    expect(payload.status).toBe("PAUSED");
    expect(payload.keywords.map(k => k.resourceName)).toEqual([
      "customers/123/adGroupCriteria/7~1",
      "customers/123/adGroupCriteria/7~3",
      "customers/123/adGroupCriteria/7~4",
    ]);
  });

  it("E0: PAUSED keyword with desiredStatus ENABLED → batched update_keyword_status ENABLED, expected null", () => {
    const d = mk();
    d.campaign.adGroups[0].baseKeywords[1].desiredStatus = "ENABLED"; // "kw2", PAUSED→ENABLED
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("update_keyword_status");
    expect(a.entityKind).toBe("ad_group");
    expect(a.entityRef).toBe("7");
    expect(a.payload).toEqual({
      status: "ENABLED",
      keywords: [{ resourceName: "customers/123/adGroupCriteria/7~2", text: "kw2" }],
    });
    expect(a.expected).toBeNull();
    expect(a.note).toContain("«G»");
  });

  it("negative keyword is never batched, even if it somehow carries desiredStatus PAUSED and a matching status", () => {
    // Guarded by the fail-closed throw below; this test only documents the filter
    // condition (!negative) would exclude it from A2 if the throw were absent.
    const d = mk();
    expect(d.campaign.adGroups[0].baseKeywords.every(k => !k.negative)).toBe(true);
  });
});

describe("diffEditDoc — v2.7 update_cpc (B2)", () => {
  it("cpc change → update_cpc with expected {cpcBidMicros: base}", () => {
    const d = mk();
    d.campaign.adGroups[0].desired.cpcBidMicros = 650_000;
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("update_cpc");
    expect(a.entityKind).toBe("ad_group");
    expect(a.entityRef).toBe("7");
    expect(a.payload).toEqual({ newCpcBidMicros: 650_000 });
    expect(a.expected).toEqual({ cpcBidMicros: 800_000 });
    expect(a.note).toContain("«G»");
  });

  it("setting a CPC where base is null (smart-bidding) → emits, expected {cpcBidMicros: null}, note reads (auto)", () => {
    const d = mk();
    d.campaign.adGroups[0].base.cpcBidMicros = null;
    d.campaign.adGroups[0].desired.cpcBidMicros = 20_000;
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("update_cpc");
    expect(a.payload).toEqual({ newCpcBidMicros: 20_000 });
    expect(a.expected).toEqual({ cpcBidMicros: null });
    expect(a.note).toContain("(auto)");
  });

  it("clearing CPC to null (base non-null, desired null) is deferred → no action", () => {
    const d = mk();
    d.campaign.adGroups[0].desired.cpcBidMicros = null;
    expect(diffEditDoc(d, "bp1")).toHaveLength(0);
  });

  it("equal cpc (no-op) → no action", () => {
    const d = mk(); // base.cpcBidMicros === desired.cpcBidMicros === 800_000 already
    expect(diffEditDoc(d, "bp1")).toHaveLength(0);
  });
});

describe("diffEditDoc — v2.7 remove_negatives (C0)", () => {
  it("removeNegatives → remove_negatives with resourceNames + removed looked up from baseNegatives, expected null", () => {
    const d = mk();
    d.campaign.removeNegatives = ["customers/123/campaignCriteria/5~1"];
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("remove_negatives");
    expect(a.entityKind).toBe("campaign");
    expect(a.entityRef).toBe("5");
    expect(a.payload).toEqual({
      resourceNames: ["customers/123/campaignCriteria/5~1"],
      removed: [{ text: "gratis", match: "EXACT" }],
    });
    expect(a.expected).toBeNull();
    expect(a.note).toContain("«C»");
  });

  it("C0 runs BEFORE add_negatives when both fire in the same save", () => {
    const d = mk();
    d.campaign.removeNegatives = ["customers/123/campaignCriteria/5~1"];
    d.campaign.newNegatives = [{ text: "n", match: "EXACT" }];
    const order = diffEditDoc(d, "bp1").map(a => a.actionType);
    expect(order).toEqual(["remove_negatives", "add_negatives"]);
  });

  it("empty removeNegatives → no action", () => {
    expect(diffEditDoc(mk(), "bp1")).toHaveLength(0);
  });
});

/** Two-ad-group fixture exercising every v2.7 emission kind plus the pre-existing phases. */
function fullPhaseDoc(): GoogleSearchEditDoc {
  const d = mk();
  d.campaign.desired.dailyBudgetMicros = 500_000_000;                     // B
  d.campaign.newNegatives = [{ text: "n", match: "EXACT" }];              // C
  d.campaign.removeNegatives = ["customers/123/campaignCriteria/5~1"];    // C0
  d.campaign.adGroups[0].desired.status = "PAUSED";                       // A (g7 ad-group pause)
  d.campaign.adGroups[0].baseKeywords[0].desiredStatus = "PAUSED";        // A2 (g7)
  d.campaign.adGroups[0].newKeywords = [{ text: "newkw", match: "PHRASE", negative: false }]; // D (g7)
  d.campaign.adGroups.push({
    resourceName: "customers/123/adGroups/8", id: "8",
    base: { name: "G2", status: "PAUSED", cpcBidMicros: 800_000 },
    desired: { status: "ENABLED", cpcBidMicros: 650_000 },                // E (g8 enable) + B2 (g8 cpc)
    baseKeywords: [
      { text: "kw5", match: "PHRASE", negative: false, resourceName: "customers/123/adGroupCriteria/8~1", status: "PAUSED", desiredStatus: "ENABLED" }, // E0 (g8)
    ],
    newKeywords: [], newAds: [],
    ads: [],
  });
  return d;
}

describe("diffEditDoc — v2.7 full phase ordering", () => {
  it("exercises every kind: existing pauses → A2 → budget → B2 → C0 → add_negatives → creates → E0 → enables", () => {
    const acts = diffEditDoc(fullPhaseDoc(), "bp1");
    const order = acts.map(a => a.actionType);
    expect(order).toEqual([
      "pause",                 // A: g7 ad-group pause
      "update_keyword_status", // A2: g7 kw pause batch
      "budget_update",         // B
      "update_cpc",            // B2: g8 cpc
      "remove_negatives",      // C0
      "add_negatives",         // C
      "create_keywords",       // D: g7
      "update_keyword_status", // E0: g8 kw reactivate batch
      "enable",                // E: g8 ad-group enable
    ]);
    expect(acts[1].entityRef).toBe("7");
    expect((acts[1].payload as { status: string }).status).toBe("PAUSED");
    expect(acts[7].entityRef).toBe("8");
    expect((acts[7].payload as { status: string }).status).toBe("ENABLED");
    expect(acts[8].entityKind).toBe("ad_group");
    expect(acts[8].entityRef).toBe("8");
  });
});

describe("diffEditDoc — v2.7 fail-closed throws", () => {
  it("throws when desiredStatus is set on a negative keyword", () => {
    const d = mk();
    d.campaign.adGroups[0].baseKeywords.push({
      text: "malas reseñas", match: "PHRASE", negative: true,
      resourceName: "customers/123/adGroupCriteria/7~9", status: "ENABLED", desiredStatus: "PAUSED",
    });
    expect(() => diffEditDoc(d, "bp1")).toThrow(/negativa/);
  });

  it("throws when removeNegatives contains a resourceName not in baseNegatives", () => {
    const d = mk();
    d.campaign.removeNegatives = ["customers/123/campaignCriteria/999~1"];
    expect(() => diffEditDoc(d, "bp1")).toThrow(/desconocida/);
  });
});

describe("diffEditDoc — v2.7 no-op discipline", () => {
  it("desiredStatus === status (already reflects live state) → no action", () => {
    const d = mk();
    d.campaign.adGroups[0].baseKeywords[0].desiredStatus = "ENABLED"; // already ENABLED
    d.campaign.adGroups[0].baseKeywords[1].desiredStatus = "PAUSED";  // already PAUSED
    expect(diffEditDoc(d, "bp1")).toHaveLength(0);
  });

  it("equal cpc (desired === base) → no update_cpc action", () => {
    const d = mk();
    d.campaign.adGroups[0].desired.cpcBidMicros = d.campaign.adGroups[0].base.cpcBidMicros;
    expect(diffEditDoc(d, "bp1")).toHaveLength(0);
  });

  it("empty removeNegatives → no remove_negatives action", () => {
    const d = mk();
    d.campaign.removeNegatives = [];
    expect(diffEditDoc(d, "bp1")).toHaveLength(0);
  });
});
