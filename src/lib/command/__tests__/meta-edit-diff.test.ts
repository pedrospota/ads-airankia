import { describe, it, expect } from "bun:test";
import { parseMetaEditDoc, type MetaEditDoc } from "../edit/meta-schema";
import { diffMetaEditDoc } from "../edit/meta-diff";

// Fixture builder identical to meta-edit-schema.test.ts's baseDoc() (tests are
// self-contained, mirroring edit-diff.test.ts's convention). ABO: budget on the adset.
function baseDoc(): MetaEditDoc {
  return parseMetaEditDoc({
    docType: "meta_edit_v1", network: "meta_ads", accountRef: "act_123",
    loadedAt: "2026-07-08T12:00:00.000Z",
    campaign: {
      id: "111",
      base: { name: "C", status: "ENABLED", effectiveStatus: "ACTIVE",
              dailyBudgetMicros: null, lifetimeBudgetMicros: null, currency: "MXN" },
      desired: { status: "ENABLED", dailyBudgetMicros: null },
      adsets: [{
        id: "222",
        base: { name: "AS", status: "ENABLED", effectiveStatus: "ACTIVE",
                dailyBudgetMicros: 20_000_000, lifetimeBudgetMicros: null, learningPhase: "STABLE" },
        desired: { status: "ENABLED", dailyBudgetMicros: 20_000_000 },
        ads: [
          { id: "333", base: { name: "Ad 1", status: "ENABLED", effectiveStatus: "ACTIVE" }, desired: { status: "ENABLED" } },
          { id: "334", base: { name: "Ad 2", status: "PAUSED", effectiveStatus: "PAUSED" }, desired: { status: "PAUSED" } },
        ],
      }],
    },
  });
}
const mk = baseDoc;

describe("diffMetaEditDoc — mapping", () => {
  it("no changes → []", () => expect(diffMetaEditDoc(mk(), "bp1")).toHaveLength(0));

  it("adset budget change → budget_update on the bare node id, expected from BASE", () => {
    const d = mk(); d.campaign.adsets[0].desired.dailyBudgetMicros = 30_000_000;
    const [a] = diffMetaEditDoc(d, "bp1");
    expect(a.actionType).toBe("budget_update");
    expect(a.entityKind).toBe("adset");
    expect(a.entityRef).toBe("222");                                  // bare Graph node id
    expect(a.payload).toEqual({ newDailyBudgetMicros: 30_000_000 });
    expect(a.expected).toEqual({ dailyBudgetMicros: 20_000_000 });    // ONLY the mutated field, from base
    expect(a.localRef).toBeNull();
    expect(a.note).toBe("Presupuesto de «AS»: 20 → 30");              // es-MX antes → después
  });

  it("campaign pause → expected {status: ENABLED}; ad enable → expected {status: PAUSED}", () => {
    const d1 = mk(); d1.campaign.desired.status = "PAUSED";
    const [p] = diffMetaEditDoc(d1, "bp1");
    expect(p.actionType).toBe("pause");
    expect(p.entityKind).toBe("campaign");
    expect(p.entityRef).toBe("111");
    expect(p.expected).toEqual({ status: "ENABLED" });
    expect(p.note).toBe("Pausar campaña «C»");

    const d2 = mk(); d2.campaign.adsets[0].ads[1].desired.status = "ENABLED";
    const [e] = diffMetaEditDoc(d2, "bp1");
    expect(e.actionType).toBe("enable");
    expect(e.entityKind).toBe("ad");
    expect(e.entityRef).toBe("334");
    expect(e.expected).toEqual({ status: "PAUSED" });
    expect(e.note).toBe("Habilitar anuncio «Ad 2»");
  });

  it("no emission when base budget is null (CBO adset / lifetime-locked node)", () => {
    const d = mk();
    d.campaign.adsets[0].base.dailyBudgetMicros = null;      // lifetime-locked shape
    d.campaign.adsets[0].base.lifetimeBudgetMicros = 900_000_000;
    d.campaign.adsets[0].desired.dailyBudgetMicros = null;
    expect(diffMetaEditDoc(parseMetaEditDoc(d), "bp1")).toHaveLength(0);
  });
});

describe("diffMetaEditDoc — phase ordering (A pauses broadest-first, B budgets, E enables narrowest-first LAST)", () => {
  it("full scenario keeps the safety order", () => {
    // Two adsets: one gets paused + budget-changed; the other's paused ad gets
    // enabled and the campaign gets a CBO-style budget change (mixed shape is
    // schema-legal: the coupling is per-node).
    const d = mk();
    d.campaign.base.dailyBudgetMicros = 50_000_000;
    d.campaign.desired.dailyBudgetMicros = 60_000_000;                 // B (campaign)
    d.campaign.adsets.push(structuredClone(d.campaign.adsets[0]));
    d.campaign.adsets[1].id = "223";
    d.campaign.adsets[1].base.name = "AS2";
    d.campaign.adsets[1].ads = [];
    const doc = parseMetaEditDoc(d);
    doc.campaign.adsets[0].desired.status = "PAUSED";                  // A (adset)
    doc.campaign.adsets[0].ads[0].desired.status = "PAUSED";           // A (ad)
    doc.campaign.adsets[1].desired.dailyBudgetMicros = 24_000_000;     // B (adset)
    doc.campaign.adsets[0].ads[1].desired.status = "ENABLED";          // E (ad)
    const acts = diffMetaEditDoc(doc, "bp1");
    expect(acts.map((a) => `${a.actionType}:${a.entityKind}`)).toEqual([
      "pause:adset",          // A — adset before its ads (broadest-first)
      "pause:ad",
      "budget_update:campaign", // B — campaign then adsets
      "budget_update:adset",
      "enable:ad",            // E — narrowest-first, LAST
    ]);
    expect(acts.map((a) => a.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("pauses run campaign → adset; enables run adset → campaign", () => {
    const dP = mk();
    dP.campaign.desired.status = "PAUSED";
    dP.campaign.adsets[0].desired.status = "PAUSED";
    expect(diffMetaEditDoc(dP, "bp1").map((a) => a.entityKind)).toEqual(["campaign", "adset"]);

    const dE = mk();
    dE.campaign.base.status = "PAUSED";
    dE.campaign.adsets[0].base.status = "PAUSED";
    const doc = parseMetaEditDoc(dE);
    doc.campaign.desired.status = "ENABLED";
    doc.campaign.adsets[0].desired.status = "ENABLED";
    expect(diffMetaEditDoc(doc, "bp1").map((a) => a.entityKind)).toEqual(["adset", "campaign"]);
  });
});

describe("diffMetaEditDoc — determinism + fail-closed", () => {
  it("recKeys are deterministic, 'me-'-prefixed, never colliding with 'ed-'", () => {
    const d = mk(); d.campaign.adsets[0].desired.dailyBudgetMicros = 30_000_000;
    const [a1] = diffMetaEditDoc(d, "bp1");
    const [a2] = diffMetaEditDoc(d, "bp1");
    expect(a1.recKey).toBe(a2.recKey);
    expect(a1.recKey.startsWith("me-")).toBe(true);
    expect(a1.recKey).toHaveLength(3 + 14);
  });

  it("defense-in-depth throw: desired budget on a base-null node (hand-built doc bypassing the schema)", () => {
    const d = mk();
    d.campaign.desired.dailyBudgetMicros = 10_000_000; // base is null — schema would reject; differ re-asserts
    expect(() => diffMetaEditDoc(d, "bp1")).toThrow(/no administra presupuesto/);
  });
});
