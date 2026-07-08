import { describe, it, expect } from "bun:test";
import { buildEditDoc } from "../edit/read-tree";
import { parseEditDoc, EDIT_BATCH_MAX } from "../edit/schema";
import type { RawCampaignTree } from "../networks/google";

const TREE: RawCampaignTree = {
  campaign: { campaign: { id: "5", resourceName: "customers/123/campaigns/5", name: "C", status: "ENABLED", advertisingChannelType: "SEARCH", campaignBudget: "customers/123/campaignBudgets/9" },
              campaignBudget: { amountMicros: "350000000", explicitlyShared: false }, customer: { currencyCode: "USD" } },
  adGroups: [{ adGroup: { id: "7", resourceName: "customers/123/adGroups/7", name: "G", status: "ENABLED", cpcBidMicros: "800000" } }],
  keywords: [
    { adGroupCriterion: { resourceName: "customers/123/adGroupCriteria/7~1", negative: false, status: "ENABLED", keyword: { text: "kw", matchType: "PHRASE" } }, adGroup: { id: "7" } },
    { adGroupCriterion: { resourceName: "customers/123/adGroupCriteria/7~2", negative: true, status: "ENABLED", keyword: { text: "gratis", matchType: "EXACT" } }, adGroup: { id: "7" } },
  ],
  ads: [
    { adGroupAd: { resourceName: "customers/123/adGroupAds/7~11", status: "ENABLED",
        ad: { type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://x.com"],
          responsiveSearchAd: { headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }], descriptions: [{ text: "D1" }, { text: "D2" }], path1: "ofertas" } } }, adGroup: { id: "7" } },
    { adGroupAd: { resourceName: "customers/123/adGroupAds/7~12", status: "ENABLED", ad: { type: "EXPANDED_TEXT_AD" } }, adGroup: { id: "7" } },
  ],
  // v2.7: readCampaignTree's 5th GAQL — live campaign-level negatives feeding
  // schema.ts's server-owned baseNegatives.
  campaignNegatives: [
    { campaignCriterion: { resourceName: "customers/123/campaignCriteria/5~1", keyword: { text: "descuento", matchType: "BROAD" } } },
  ],
};

describe("buildEditDoc", () => {
  it("maps the tree with desired=base, empty new*, loadedAt=nowIso", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    expect(doc.docType).toBe("google_search_edit_v1");
    expect(doc.loadedAt).toBe("2026-07-07T12:00:00.000Z");
    expect(doc.campaign.base.dailyBudgetMicros).toBe(350_000_000); // string micros → number
    expect(doc.campaign.base.budgetShared).toBe(false);
    expect(doc.campaign.desired).toEqual({ status: "ENABLED", dailyBudgetMicros: 350_000_000 });
    expect(doc.campaign.adGroups[0].baseKeywords).toHaveLength(2);
    expect(doc.campaign.adGroups[0].newKeywords).toHaveLength(0);
  });
  it("flags non-RSA ads unsupported (they still exist for the enabled-count)", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    expect(doc.campaign.adGroups[0].ads[0].unsupported).toBe(false);
    expect(doc.campaign.adGroups[0].ads[1].unsupported).toBe(true);
    expect(doc.campaign.adGroups[0].ads[1].base.headlines).toHaveLength(0);
  });
  it("attaches keywords/ads to the RIGHT ad group by adGroup.id", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    expect(doc.campaign.adGroups[0].ads).toHaveLength(2);
  });
  it("output round-trips through parseEditDoc (schema-valid by construction)", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    expect(() => parseEditDoc(doc)).not.toThrow();
  });

  // v2.7 status/cpc/negatives mapping (spec §b)
  it("maps ad_group_criterion.status onto each baseKeywords row (positive and negative alike)", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    const [positive, negative] = doc.campaign.adGroups[0].baseKeywords;
    expect(positive.status).toBe("ENABLED");
    expect(positive.negative).toBe(false);
    expect(negative.status).toBe("ENABLED");
    expect(negative.negative).toBe(true);
  });
  it("no baseKeywords row carries a desiredStatus on load (operator hasn't proposed anything yet)", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    expect(doc.campaign.adGroups[0].baseKeywords.every((k) => k.desiredStatus === undefined)).toBe(true);
  });
  it("throws with a Spanish message on an unrecognized keyword status", () => {
    const bad: RawCampaignTree = {
      ...TREE,
      keywords: [{ adGroupCriterion: { resourceName: "customers/123/adGroupCriteria/7~1", negative: false, status: "UNKNOWN", keyword: { text: "kw", matchType: "PHRASE" } }, adGroup: { id: "7" } }],
    };
    expect(() => buildEditDoc(bad, "123", "2026-07-07T12:00:00.000Z")).toThrow(/palabra clave/);
  });
  it("maps ad_group.cpc_bid_micros into base.cpcBidMicros and seeds desired with the same value", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    expect(doc.campaign.adGroups[0].base.cpcBidMicros).toBe(800_000); // string micros → number
    expect(doc.campaign.adGroups[0].desired.cpcBidMicros).toBe(800_000); // seeded = base
  });
  it("maps a missing/null cpc_bid_micros (smart-bidding ad group) to null, not 0", () => {
    const noCpc: RawCampaignTree = {
      ...TREE,
      adGroups: [{ adGroup: { id: "7", resourceName: "customers/123/adGroups/7", name: "G", status: "ENABLED", cpcBidMicros: null } }],
    };
    const doc = buildEditDoc(noCpc, "123", "2026-07-07T12:00:00.000Z");
    expect(doc.campaign.adGroups[0].base.cpcBidMicros).toBeNull();
    expect(doc.campaign.adGroups[0].desired.cpcBidMicros).toBeNull();
  });
  it("maps campaignNegatives rows into campaign.baseNegatives (resourceName/text/matchType→match)", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    expect(doc.campaign.baseNegatives).toEqual([
      { resourceName: "customers/123/campaignCriteria/5~1", text: "descuento", match: "BROAD" },
    ]);
    expect(doc.campaign.removeNegatives).toEqual([]);
  });
  it("blast-bound refine rejects an over-cap doc built from the tree and then mutated past EDIT_BATCH_MAX", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    const template = doc.campaign.adGroups[0].baseKeywords[0];
    doc.campaign.adGroups[0].baseKeywords = Array.from({ length: EDIT_BATCH_MAX + 1 }, (_, i) => ({
      ...template,
      resourceName: `customers/123/adGroupCriteria/7~${i}`,
      negative: false,
      status: "ENABLED" as const,
      desiredStatus: "PAUSED" as const,
    }));
    expect(() => parseEditDoc(doc)).toThrow();
  });
});

// v2.7 final-review regression: smart-bidding campaigns report cpc_bid_micros "0";
// seeding desired=base with a sub-floor value must NOT brick the doc's own parse.
describe("buildEditDoc — sub-floor live CPC coercion", () => {
  it("cpc_bid_micros '0' coerces to null (puja automática) and the doc parses", () => {
    const tree = JSON.parse(JSON.stringify(TREE)) as RawCampaignTree;
    (tree.adGroups[0] as { adGroup: Record<string, unknown> }).adGroup.cpcBidMicros = "0";
    const doc = buildEditDoc(tree, "123", "2026-07-08T12:00:00.000Z");
    expect(doc.campaign.adGroups[0].base.cpcBidMicros).toBeNull();
    expect(doc.campaign.adGroups[0].desired.cpcBidMicros).toBeNull();
    const { parseEditDoc } = require("../edit/schema");
    expect(() => parseEditDoc(doc)).not.toThrow();
  });
  it("cpc_bid_micros 9999 (sub-floor) also coerces to null; 10000 passes through", () => {
    const t1 = JSON.parse(JSON.stringify(TREE)) as RawCampaignTree;
    (t1.adGroups[0] as { adGroup: Record<string, unknown> }).adGroup.cpcBidMicros = "9999";
    expect(buildEditDoc(t1, "123", "2026-07-08T12:00:00.000Z").campaign.adGroups[0].base.cpcBidMicros).toBeNull();
    const t2 = JSON.parse(JSON.stringify(TREE)) as RawCampaignTree;
    (t2.adGroups[0] as { adGroup: Record<string, unknown> }).adGroup.cpcBidMicros = "10000";
    expect(buildEditDoc(t2, "123", "2026-07-08T12:00:00.000Z").campaign.adGroups[0].base.cpcBidMicros).toBe(10_000);
  });
});
