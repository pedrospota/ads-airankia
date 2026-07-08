import { describe, it, expect } from "bun:test";
import { EDIT_BASELINE_MAX_AGE_MS } from "../edit/schema";
import {
  parseMetaEditDoc, mergeMetaEditDoc,
  EDIT_BASELINE_MAX_AGE_MS as reExported,
  type MetaEditDoc,
} from "../edit/meta-schema";

// Canonical fixture: ABO campaign (campaign daily null, budget lives on the adset).
// Mirrors edit-schema.test.ts's baseDoc() convention — parse the raw shape so every
// fixture is schema-valid by construction.
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

// CBO variant: campaign owns the daily budget, the adset does not.
function cboDoc(): MetaEditDoc {
  const raw = baseDoc() as unknown as Record<string, unknown>;
  const d = structuredClone(raw) as unknown as MetaEditDoc;
  d.campaign.base.dailyBudgetMicros = 50_000_000;
  d.campaign.desired.dailyBudgetMicros = 50_000_000;
  d.campaign.adsets[0].base.dailyBudgetMicros = null;
  d.campaign.adsets[0].desired.dailyBudgetMicros = null;
  return parseMetaEditDoc(d);
}

describe("metaEditDocSchema", () => {
  it("parses a valid ABO doc and a valid CBO doc (round-trip)", () => {
    expect(baseDoc().campaign.id).toBe("111");
    expect(cboDoc().campaign.base.dailyBudgetMicros).toBe(50_000_000);
    expect(() => parseMetaEditDoc(baseDoc())).not.toThrow();
  });

  it("rejects a wrong docType (google edit docs must not enter the meta path)", () => {
    const d = { ...baseDoc(), docType: "google_search_edit_v1" };
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("rejects a desired budget where base is null — adset level (no introducing a budget Meta doesn't own)", () => {
    const d = cboDoc(); // adset base daily is null under CBO
    d.campaign.adsets[0].desired.dailyBudgetMicros = 10_000_000;
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("rejects a desired budget where base is null — campaign level", () => {
    const d = baseDoc(); // campaign base daily is null under ABO
    d.campaign.desired.dailyBudgetMicros = 10_000_000;
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("rejects a null desired budget where base is non-null (no clearing an owned budget)", () => {
    const d = baseDoc();
    d.campaign.adsets[0].desired.dailyBudgetMicros = null;
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("rejects a non-cent-aligned desired budget (micros % 10_000 !== 0)", () => {
    const d = baseDoc();
    d.campaign.adsets[0].desired.dailyBudgetMicros = 20_005_001;
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("rejects a sub-floor desired budget (< MICROS_PER_UNIT, the CURRENCY_SANITY floor)", () => {
    const d = baseDoc();
    d.campaign.adsets[0].desired.dailyBudgetMicros = 990_000;
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("accepts a lifetime-budget adset (daily null both sides — budget-locked, status still editable)", () => {
    const d = baseDoc();
    d.campaign.adsets[0].base.dailyBudgetMicros = null;
    d.campaign.adsets[0].base.lifetimeBudgetMicros = 900_000_000;
    d.campaign.adsets[0].desired.dailyBudgetMicros = null;
    expect(() => parseMetaEditDoc(d)).not.toThrow();
  });

  it("rejects a bad status enum and a bad learningPhase enum", () => {
    const d1 = baseDoc();
    // @ts-expect-error deliberately invalid for the enum-rejection assertion
    d1.campaign.desired.status = "ARCHIVED";
    expect(() => parseMetaEditDoc(d1)).toThrow();
    const d2 = baseDoc();
    // @ts-expect-error deliberately invalid for the enum-rejection assertion
    d2.campaign.adsets[0].base.learningPhase = "WARMING_UP";
    expect(() => parseMetaEditDoc(d2)).toThrow();
  });

  it("TTL const is the SAME value re-exported from edit/schema — never re-declared", () => {
    expect(reExported).toBe(EDIT_BASELINE_MAX_AGE_MS);
    expect(reExported).toBe(60 * 60_000);
  });
});

describe("mergeMetaEditDoc (server-owned baseline, blast-bound)", () => {
  it("lifts ONLY desired per row, matched by id", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.desired.status = "PAUSED";
    incoming.campaign.adsets[0].desired.dailyBudgetMicros = 24_000_000;
    incoming.campaign.adsets[0].ads[1].desired.status = "ENABLED";
    const out = mergeMetaEditDoc(stored, incoming);
    expect(out.campaign.desired.status).toBe("PAUSED");
    expect(out.campaign.adsets[0].desired.dailyBudgetMicros).toBe(24_000_000);
    expect(out.campaign.adsets[0].ads[1].desired.status).toBe("ENABLED");
  });

  it("spoofing matrix: base flips / id swaps / loadedAt+accountRef tamper are all preserved-from-stored", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.loadedAt = "2027-01-01T00:00:00.000Z";       // TTL tamper
    incoming.accountRef = "act_999";                       // tenant tamper
    incoming.campaign.base.name = "spoofed";              // baseline tamper
    incoming.campaign.base.status = "PAUSED";
    incoming.campaign.adsets[0].base.dailyBudgetMicros = 1_000_000; // fake baseline for a bigger delta
    incoming.campaign.adsets[0].base.learningPhase = "LEARNING";
    const out = mergeMetaEditDoc(stored, incoming);
    expect(out.loadedAt).toBe(stored.loadedAt);
    expect(out.accountRef).toBe("act_123");
    expect(out.campaign.base).toEqual(stored.campaign.base);
    expect(out.campaign.adsets[0].base).toEqual(stored.campaign.adsets[0].base);
  });

  it("unknown incoming adset/ad ids are structurally dropped (server never loaded them)", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.adsets.push({
      id: "666",
      base: { name: "inyectado", status: "ENABLED", effectiveStatus: "ACTIVE",
              dailyBudgetMicros: 10_000_000, lifetimeBudgetMicros: null, learningPhase: "UNKNOWN" },
      desired: { status: "PAUSED", dailyBudgetMicros: 10_000_000 },
      ads: [],
    });
    incoming.campaign.adsets[0].ads.push({
      id: "667", base: { name: "ad inyectado", status: "ENABLED", effectiveStatus: "ACTIVE" },
      desired: { status: "PAUSED" },
    });
    const out = mergeMetaEditDoc(stored, incoming);
    expect(out.campaign.adsets.map((a) => a.id)).toEqual(["222"]);
    expect(out.campaign.adsets[0].ads.map((a) => a.id)).toEqual(["333", "334"]);
  });

  it("stored rows missing from incoming are preserved as-is", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.adsets[0].ads = [incoming.campaign.adsets[0].ads[0]]; // client dropped ad 334
    const out = mergeMetaEditDoc(stored, incoming);
    expect(out.campaign.adsets[0].ads).toHaveLength(2);
    expect(out.campaign.adsets[0].ads[1]).toEqual(stored.campaign.adsets[0].ads[1]);
  });

  it("final re-parse fires the superRefine against SERVER truth: a lifted budget on a base-null node throws", () => {
    // Client claims the campaign owns a budget (fake base) and lifts a desired one.
    // Incoming parses fine (its own base/desired are coherent), but after the merge
    // rebuilds base from STORED (null), the base-null⇔desired-null refine must throw.
    const stored = baseDoc(); // campaign base daily null (ABO)
    const incoming = baseDoc();
    incoming.campaign.base.dailyBudgetMicros = 50_000_000; // spoofed baseline
    incoming.campaign.desired.dailyBudgetMicros = 80_000_000;
    expect(() => mergeMetaEditDoc(stored, incoming)).toThrow();
  });

  it("invalid incoming (wrong docType / malformed) throws before touching anything", () => {
    const stored = baseDoc();
    expect(() => mergeMetaEditDoc(stored, { docType: "meta_ads_v1" })).toThrow();
    expect(() => mergeMetaEditDoc(stored, null)).toThrow();
  });
});
