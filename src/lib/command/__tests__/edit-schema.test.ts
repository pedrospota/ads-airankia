import { describe, it, expect } from "bun:test";
import { parseEditDoc, mergeEditDoc, type GoogleSearchEditDoc } from "../edit/schema";

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

describe("editDocSchema", () => {
  it("parses a valid edit doc", () => { expect(baseDoc().campaign.id).toBe("5"); });
  it("rejects a wrong docType (create docs must not enter the edit path)", () => {
    const d = { ...baseDoc(), docType: "google_search_v1" };
    expect(() => parseEditDoc(d)).toThrow();
  });
  it("rejects a replacement violating RSA_SPEC (headline > 30 chars)", () => {
    const d = baseDoc();
    d.campaign.adGroups[0].ads[0].replacement = { tempId: "t1", finalUrl: "https://x.com",
      headlines: [{ text: "x".repeat(31) }, { text: "b" }, { text: "c" }], descriptions: [{ text: "d1" }, { text: "d2" }] };
    expect(() => parseEditDoc(d)).toThrow();
  });
});

describe("mergeEditDoc (server-owned baseline)", () => {
  it("copies desired/new* from the client", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.desired.dailyBudgetMicros = 500_000_000;
    incoming.campaign.newNegatives = [{ text: "gratis", match: "EXACT" }];
    incoming.campaign.adGroups[0].newKeywords = [{ text: "nuevo kw", match: "PHRASE", negative: false }];
    const out = mergeEditDoc(stored, incoming);
    expect(out.campaign.desired.dailyBudgetMicros).toBe(500_000_000);
    expect(out.campaign.newNegatives).toHaveLength(1);
    expect(out.campaign.adGroups[0].newKeywords).toHaveLength(1);
  });
  it("REJECTS client tampering with base/loadedAt/budgetShared/resourceName", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.loadedAt = "2026-07-07T13:00:00.000Z";
    incoming.campaign.base.dailyBudgetMicros = 1;         // laundering attempt
    incoming.campaign.base.budgetShared = true;
    const out = mergeEditDoc(stored, incoming);
    expect(out.loadedAt).toBe(stored.loadedAt);
    expect(out.campaign.base.dailyBudgetMicros).toBe(350_000_000);
    expect(out.campaign.base.budgetShared).toBe(false);
  });
  it("drops client edits referencing nodes absent from the stored doc", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.adGroups.push({ ...baseDoc().campaign.adGroups[0], resourceName: "customers/123/adGroups/999", id: "999" });
    const out = mergeEditDoc(stored, incoming);
    expect(out.campaign.adGroups).toHaveLength(1);
  });
  it("matches ads by resourceName when copying replacement", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.adGroups[0].ads[0].replacement = { tempId: "t1", finalUrl: "https://x.com",
      headlines: [{ text: "A" }, { text: "B" }, { text: "C" }], descriptions: [{ text: "d1" }, { text: "d2" }] };
    const out = mergeEditDoc(stored, incoming);
    expect(out.campaign.adGroups[0].ads[0].replacement?.tempId).toBe("t1");
  });
});
