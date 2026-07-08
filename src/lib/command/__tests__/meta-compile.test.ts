import { describe, it, expect } from "bun:test";
import { compileMeta } from "../blueprint/meta-compile";
import { parseMetaBlueprint } from "../blueprint/meta-schema";

describe("compileMeta", () => {
  it("emits create_campaign→create_adset→create_ad in seq order", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    });
    const actions = compileMeta(d, "bp-1");
    expect(actions.map((x) => x.actionType)).toEqual([
      "create_campaign",
      "create_adset",
      "create_ad",
    ]);
    expect(actions.map((x) => x.seq)).toEqual([0, 1, 2]);
  });

  it("threads tmp: parent refs correctly", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    });
    const actions = compileMeta(d, "bp-1");
    const campaign = actions.find((x) => x.actionType === "create_campaign")!;
    const adset = actions.find((x) => x.actionType === "create_adset")!;
    const ad = actions.find((x) => x.actionType === "create_ad")!;

    expect(adset.payload).toHaveProperty("campaignRef", "tmp:campaign:1");
    expect(ad.payload).toHaveProperty("adsetRef", "tmp:adset:1");
  });

  it("campaign is PAUSED with OUTCOME_TRAFFIC objective and AUCTION buyingType", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    });
    const actions = compileMeta(d, "bp-1");
    const campaign = actions.find((x) => x.actionType === "create_campaign")!;
    const payload = campaign.payload as any;
    expect(payload.status).toBe("PAUSED");
    expect(payload.objective).toBe("OUTCOME_TRAFFIC");
    expect(payload.buyingType).toBe("AUCTION");
  });

  it("campaign specialAdCategories is always empty array", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    });
    const actions = compileMeta(d, "bp-1");
    const campaign = actions.find((x) => x.actionType === "create_campaign")!;
    const payload = campaign.payload as any;
    expect(payload.specialAdCategories).toEqual([]);
  });

  it("adset is PAUSED with correct optimization goal, billing event, and bid strategy", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    });
    const actions = compileMeta(d, "bp-1");
    const adset = actions.find((x) => x.actionType === "create_adset")!;
    const payload = adset.payload as any;
    expect(payload.status).toBe("PAUSED");
    expect(payload.optimizationGoal).toBe("LINK_CLICKS");
    expect(payload.billingEvent).toBe("IMPRESSIONS");
    expect(payload.bidStrategy).toBe("LOWEST_COST_WITHOUT_CAP");
  });

  it("ad is ACTIVE with correct creative structure", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
                headline: "Amazing",
                description: "Cool",
                callToActionType: "LEARN_MORE",
              },
            ],
          },
        ],
      },
    });
    const actions = compileMeta(d, "bp-1");
    const ad = actions.find((x) => x.actionType === "create_ad")!;
    const payload = ad.payload as any;
    expect(payload.status).toBe("ACTIVE");
    expect(payload.creative.link).toBe("https://example.com");
    expect(payload.creative.message).toBe("Check this out!");
    expect(payload.creative.headline).toBe("Amazing");
    expect(payload.creative.description).toBe("Cool");
    expect(payload.creative.callToActionType).toBe("LEARN_MORE");
  });

  it("recKey is deterministic and has bp- prefix", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    });
    const actions1 = compileMeta(d, "bp-1");
    const actions2 = compileMeta(d, "bp-1");
    expect(actions1[0].recKey).toBe(actions2[0].recKey);
    expect(actions1[0].recKey).toMatch(/^bp-/);
    expect(actions1[0].recKey).not.toBe(compileMeta(d, "bp-2")[0].recKey);
  });

  it("two ads emit two create_ad rows with separate tempIds", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
              {
                nodeId: "ad2",
                tempId: "ad:2",
                name: "Ad 2",
                link: "https://example.com/page2",
                message: "Another one!",
              },
            ],
          },
        ],
      },
    });
    const actions = compileMeta(d, "bp-1");
    const ads = actions.filter((x) => x.actionType === "create_ad");
    expect(ads).toHaveLength(2);
    expect(ads[0].localRef).toBe("ad:1");
    expect(ads[1].localRef).toBe("ad:2");
    expect(ads[0].entityRef).toBe("tmp:ad:1");
    expect(ads[1].entityRef).toBe("tmp:ad:2");
  });

  it("duplicate tempId across campaign/adset/ads throws", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "dup:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "dup:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    });
    expect(() => compileMeta(d, "bp-1")).toThrow("tempId duplicado");
  });

  it("duplicate tempId among ads throws", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "dup:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
              {
                nodeId: "ad2",
                tempId: "dup:1",
                name: "Ad 2",
                link: "https://example.com/page2",
                message: "Another one!",
              },
            ],
          },
        ],
      },
    });
    expect(() => compileMeta(d, "bp-1")).toThrow("tempId duplicado");
  });

  it("targeting is passed through correctly", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["MX", "US"],
              ageMin: 25,
              ageMax: 55,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    });
    const actions = compileMeta(d, "bp-1");
    const adset = actions.find((x) => x.actionType === "create_adset")!;
    const payload = adset.payload as any;
    expect(payload.targeting.countryCodes).toEqual(["MX", "US"]);
    expect(payload.targeting.ageMin).toBe(25);
    expect(payload.targeting.ageMax).toBe(55);
  });

  it("dailyBudgetMicros is passed through correctly", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 50_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    });
    const actions = compileMeta(d, "bp-1");
    const adset = actions.find((x) => x.actionType === "create_adset")!;
    const payload = adset.payload as any;
    expect(payload.dailyBudgetMicros).toBe(50_000_000);
  });

  it("localRef and entityRef match tempIds correctly", () => {
    const d = parseMetaBlueprint({
      network: "meta_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:1",
        name: "Test Campaign",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        adsets: [
          {
            nodeId: "as1",
            tempId: "adset:1",
            name: "Test Adset",
            status: "PAUSED",
            dailyBudgetMicros: 10_000_000,
            targeting: {
              countryCodes: ["US"],
              ageMin: 18,
              ageMax: 65,
            },
            ads: [
              {
                nodeId: "ad1",
                tempId: "ad:1",
                name: "Ad 1",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    });
    const actions = compileMeta(d, "bp-1");
    const campaign = actions.find((x) => x.actionType === "create_campaign")!;
    const adset = actions.find((x) => x.actionType === "create_adset")!;
    const ad = actions.find((x) => x.actionType === "create_ad")!;

    expect(campaign.localRef).toBe("campaign:1");
    expect(campaign.entityRef).toBe("tmp:campaign:1");
    expect(adset.localRef).toBe("adset:1");
    expect(adset.entityRef).toBe("tmp:adset:1");
    expect(ad.localRef).toBe("ad:1");
    expect(ad.entityRef).toBe("tmp:ad:1");
  });
});
