import { describe, it, expect } from "bun:test";
import { parseEditDoc, mergeEditDoc, EDIT_BATCH_MAX, type GoogleSearchEditDoc } from "../edit/schema";

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

  // v2.7 pruning/CPC/negatives fields (spec §b)
  it("accepts baseKeywords.status/desiredStatus, campaign.baseNegatives/removeNegatives, and ad-group cpcBidMicros", () => {
    const d = baseDoc();
    d.campaign.adGroups[0].baseKeywords[0].desiredStatus = "PAUSED";
    d.campaign.removeNegatives = ["customers/123/campaignCriteria/5~1"];
    d.campaign.adGroups[0].desired.cpcBidMicros = 650_000;
    expect(() => parseEditDoc(d)).not.toThrow();
  });
  it("accepts null cpcBidMicros on base and desired (smart-bidding ad group)", () => {
    const d = baseDoc();
    d.campaign.adGroups[0].base.cpcBidMicros = null;
    d.campaign.adGroups[0].desired.cpcBidMicros = null;
    expect(() => parseEditDoc(d)).not.toThrow();
  });
  it("rejects desired.cpcBidMicros below the 10_000-micros (US$0.01) floor", () => {
    const d = baseDoc();
    d.campaign.adGroups[0].desired.cpcBidMicros = 9_999;
    expect(() => parseEditDoc(d)).toThrow();
  });
  it("rejects a bad keyword status enum", () => {
    const d = baseDoc();
    // @ts-expect-error deliberately invalid for the enum-rejection assertion
    d.campaign.adGroups[0].baseKeywords[0].status = "REMOVED";
    expect(() => parseEditDoc(d)).toThrow();
  });
  it("rejects a bad desiredStatus enum", () => {
    const d = baseDoc();
    // @ts-expect-error deliberately invalid for the enum-rejection assertion
    d.campaign.adGroups[0].baseKeywords[0].desiredStatus = "REMOVED";
    expect(() => parseEditDoc(d)).toThrow();
  });
  it("rejects a bad baseNegatives match enum", () => {
    const d = baseDoc();
    // @ts-expect-error deliberately invalid for the enum-rejection assertion
    d.campaign.baseNegatives[0].match = "FUZZY";
    expect(() => parseEditDoc(d)).toThrow();
  });
  it("blast-bound: rejects an ad group with more than EDIT_BATCH_MAX non-KEEP keyword dispositions", () => {
    const d = baseDoc();
    const template = d.campaign.adGroups[0].baseKeywords[0];
    d.campaign.adGroups[0].baseKeywords = Array.from({ length: EDIT_BATCH_MAX + 1 }, (_, i) => ({
      ...template,
      resourceName: `customers/123/adGroupCriteria/7~${i}`,
      status: "ENABLED" as const,
      desiredStatus: "PAUSED" as const,
    }));
    expect(() => parseEditDoc(d)).toThrow();
  });
  it("blast-bound: rejects a campaign with more than EDIT_BATCH_MAX removeNegatives", () => {
    const d = baseDoc();
    d.campaign.removeNegatives = Array.from({ length: EDIT_BATCH_MAX + 1 }, (_, i) => `customers/123/campaignCriteria/5~${i}`);
    expect(() => parseEditDoc(d)).toThrow();
  });
  it("blast-bound: allows exactly EDIT_BATCH_MAX non-KEEP dispositions (boundary)", () => {
    const d = baseDoc();
    const template = d.campaign.adGroups[0].baseKeywords[0];
    d.campaign.adGroups[0].baseKeywords = Array.from({ length: EDIT_BATCH_MAX }, (_, i) => ({
      ...template,
      resourceName: `customers/123/adGroupCriteria/7~${i}`,
      status: "ENABLED" as const,
      desiredStatus: "PAUSED" as const,
    }));
    expect(() => parseEditDoc(d)).not.toThrow();
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
  it("preserves server-owned resourceNames when incoming tampers them", () => {
    const stored = baseDoc();
    const incoming = baseDoc();

    // Tamper with all resourceNames
    incoming.campaign.resourceName = "customers/123/campaigns/999";
    incoming.campaign.adGroups[0].resourceName = "customers/123/adGroups/999";
    incoming.campaign.adGroups[0].ads[0].resourceName = "customers/123/adGroupAds/999~111";

    const out = mergeEditDoc(stored, incoming);

    // Verify all resourceNames are preserved from stored (incoming impostor nodes are not included)
    expect(out.campaign.resourceName).toBe("customers/123/campaigns/5");
    expect(out.campaign.adGroups[0].resourceName).toBe("customers/123/adGroups/7");
    expect(out.campaign.adGroups[0].ads[0].resourceName).toBe("customers/123/adGroupAds/7~11");
    expect(out.campaign.adGroups).toHaveLength(1);
    expect(out.campaign.adGroups[0].ads).toHaveLength(1);
  });
  it("preserves server-owned accountRef, network, baseKeywords, unsupported, and base against tampering", () => {
    const stored = baseDoc();
    const incoming = baseDoc();

    // Tamper with server-owned fields (keeping resourceNames same for matching)
    incoming.accountRef = "999";
    incoming.network = "google_ads";
    incoming.campaign.adGroups[0].baseKeywords = [];
    incoming.campaign.adGroups[0].ads[0].unsupported = true;
    incoming.campaign.adGroups[0].ads[0].base.headlines = [{ text: "Tampered1" }, { text: "Tampered2" }];

    const out = mergeEditDoc(stored, incoming);

    expect(out.accountRef).toBe("123");
    expect(out.network).toBe("google_ads");
    expect(out.campaign.adGroups[0].baseKeywords).toHaveLength(2);
    expect(out.campaign.adGroups[0].baseKeywords[0].text).toBe("kw");
    expect(out.campaign.adGroups[0].ads[0].unsupported).toBe(false);
    expect(out.campaign.adGroups[0].ads[0].base.headlines).toHaveLength(3);
    expect(out.campaign.adGroups[0].ads[0].base.headlines[0].text).toBe("H1");
  });
  it("preserves client replacement while keeping server-owned base on same ad node", () => {
    const stored = baseDoc();
    const incoming = baseDoc();

    // Set replacement (client-owned) and tamper base.headlines (server-owned) on same ad
    incoming.campaign.adGroups[0].ads[0].replacement = {
      tempId: "t1", finalUrl: "https://y.com",
      headlines: [{ text: "New1" }, { text: "New2" }, { text: "New3" }],
      descriptions: [{ text: "NewD1" }, { text: "NewD2" }]
    };
    incoming.campaign.adGroups[0].ads[0].base.headlines = [{ text: "Tampered1" }, { text: "Tampered2" }];

    const out = mergeEditDoc(stored, incoming);

    // Replacement is client-owned (taken from incoming)
    expect(out.campaign.adGroups[0].ads[0].replacement?.tempId).toBe("t1");
    expect(out.campaign.adGroups[0].ads[0].replacement?.finalUrl).toBe("https://y.com");
    // base.headlines is server-owned (preserved from stored)
    expect(out.campaign.adGroups[0].ads[0].base.headlines).toHaveLength(3);
    expect(out.campaign.adGroups[0].ads[0].base.headlines[0].text).toBe("H1");
    expect(out.campaign.adGroups[0].ads[0].base.headlines[1].text).toBe("H2");
    expect(out.campaign.adGroups[0].ads[0].base.headlines[2].text).toBe("H3");
  });

  // v2.7 per-row baseKeywords merge + campaign negatives (spec §b / mergeEditDoc boundary)
  it("lifts desiredStatus from the matching incoming row (matched by resourceName)", () => {
    const stored = baseDoc();
    const incoming = baseDoc();
    incoming.campaign.adGroups[0].baseKeywords[0].desiredStatus = "PAUSED";

    const out = mergeEditDoc(stored, incoming);

    expect(out.campaign.adGroups[0].baseKeywords[0].desiredStatus).toBe("PAUSED");
    // the row not touched by the client stays without a desiredStatus
    expect(out.campaign.adGroups[0].baseKeywords[1].desiredStatus).toBeUndefined();
  });
  it("TAMPER: incoming rewrites a baseKeyword's status/text/match/negative — stored wins", () => {
    const stored = baseDoc();
    const incoming = baseDoc();
    incoming.campaign.adGroups[0].baseKeywords[0].status = "PAUSED";
    incoming.campaign.adGroups[0].baseKeywords[0].text = "keyword robada";
    incoming.campaign.adGroups[0].baseKeywords[0].match = "BROAD";
    incoming.campaign.adGroups[0].baseKeywords[0].negative = true;

    const out = mergeEditDoc(stored, incoming);

    expect(out.campaign.adGroups[0].baseKeywords[0].status).toBe("ENABLED");
    expect(out.campaign.adGroups[0].baseKeywords[0].text).toBe("kw");
    expect(out.campaign.adGroups[0].baseKeywords[0].match).toBe("PHRASE");
    expect(out.campaign.adGroups[0].baseKeywords[0].negative).toBe(false);
  });
  it("DROPS an incoming baseKeyword row whose resourceName the server never loaded (never appended)", () => {
    const stored = baseDoc();
    const incoming = baseDoc();
    incoming.campaign.adGroups[0].baseKeywords.push({
      text: "keyword ajena", match: "EXACT", negative: false,
      resourceName: "customers/123/adGroupCriteria/7~999", status: "ENABLED", desiredStatus: "PAUSED",
    });

    const out = mergeEditDoc(stored, incoming);

    expect(out.campaign.adGroups[0].baseKeywords).toHaveLength(2); // unchanged from stored
    expect(out.campaign.adGroups[0].baseKeywords.some((k) => k.resourceName === "customers/123/adGroupCriteria/7~999")).toBe(false);
  });
  it("base.cpcBidMicros TAMPER: incoming rewrites the ad group's live CPC — stored wins", () => {
    const stored = baseDoc();
    const incoming = baseDoc();
    incoming.campaign.adGroups[0].base.cpcBidMicros = 1;

    const out = mergeEditDoc(stored, incoming);

    expect(out.campaign.adGroups[0].base.cpcBidMicros).toBe(800_000);
  });
  it("desired.cpcBidMicros is wholesale-from-incoming (client-writable, no merge change needed)", () => {
    const stored = baseDoc();
    const incoming = baseDoc();
    incoming.campaign.adGroups[0].desired.cpcBidMicros = 650_000;

    const out = mergeEditDoc(stored, incoming);

    expect(out.campaign.adGroups[0].desired.cpcBidMicros).toBe(650_000);
  });
  it("campaign.baseNegatives stays server-owned against incoming tampering", () => {
    const stored = baseDoc();
    const incoming = baseDoc();
    incoming.campaign.baseNegatives = [{ resourceName: "customers/123/campaignCriteria/999~1", text: "robada", match: "EXACT" }];

    const out = mergeEditDoc(stored, incoming);

    expect(out.campaign.baseNegatives).toHaveLength(2);
    expect(out.campaign.baseNegatives[0].resourceName).toBe("customers/123/campaignCriteria/5~1");
  });
  it("removeNegatives is filtered to resourceNames present in stored baseNegatives (unknowns dropped)", () => {
    const stored = baseDoc();
    const incoming = baseDoc();
    incoming.campaign.removeNegatives = [
      "customers/123/campaignCriteria/5~1",      // known — kept
      "customers/123/campaignCriteria/999~999",  // unknown — filtered out
    ];

    const out = mergeEditDoc(stored, incoming);

    expect(out.campaign.removeNegatives).toEqual(["customers/123/campaignCriteria/5~1"]);
  });
});
