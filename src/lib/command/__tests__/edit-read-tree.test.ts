import { describe, it, expect } from "bun:test";
import { buildEditDoc } from "../edit/read-tree";
import { parseEditDoc } from "../edit/schema";
import type { RawCampaignTree } from "../networks/google";

const TREE: RawCampaignTree = {
  campaign: { campaign: { id: "5", resourceName: "customers/123/campaigns/5", name: "C", status: "ENABLED", advertisingChannelType: "SEARCH", campaignBudget: "customers/123/campaignBudgets/9" },
              campaignBudget: { amountMicros: "350000000", explicitlyShared: false }, customer: { currencyCode: "USD" } },
  adGroups: [{ adGroup: { id: "7", resourceName: "customers/123/adGroups/7", name: "G", status: "ENABLED" } }],
  keywords: [{ adGroupCriterion: { resourceName: "customers/123/adGroupCriteria/7~1", negative: false, keyword: { text: "kw", matchType: "PHRASE" } }, adGroup: { id: "7" } }],
  ads: [
    { adGroupAd: { resourceName: "customers/123/adGroupAds/7~11", status: "ENABLED",
        ad: { type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://x.com"],
          responsiveSearchAd: { headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }], descriptions: [{ text: "D1" }, { text: "D2" }], path1: "ofertas" } } }, adGroup: { id: "7" } },
    { adGroupAd: { resourceName: "customers/123/adGroupAds/7~12", status: "ENABLED", ad: { type: "EXPANDED_TEXT_AD" } }, adGroup: { id: "7" } },
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
    expect(doc.campaign.adGroups[0].baseKeywords).toHaveLength(1);
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
});
