import { describe, it, expect } from "bun:test";
import { compile, type CompiledAction } from "../blueprint/compile";
import { parseBlueprint } from "../blueprint/schema";

function doc() {
  return parseBlueprint({
    network: "google_ads",
    campaign: {
      nodeId: "c1",
      tempId: "campaign:2",
      name: "Camp",
      channel: "SEARCH",
      status: "PAUSED",
      budget: { nodeId: "b1", tempId: "budget:1", dailyMicros: 350_000_000 },
      bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
      geo: { countryCodes: ["MX"], presenceOnly: true },
      adGroups: [
        {
          nodeId: "g1",
          tempId: "ad_group:3",
          name: "AG",
          keywords: [{ text: "kw", match: "PHRASE" }],
          negatives: [{ text: "gratis", match: "PHRASE" }],
          ads: [
            {
              nodeId: "a1",
              tempId: "ad:4",
              finalUrl: "https://x.mx/a",
              headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }],
              descriptions: [{ text: "D1" }, { text: "D2" }],
            },
          ],
        },
      ],
    },
  });
}

describe("compile", () => {
  it("emits budget→campaign→ad_group→keywords→ad in seq order", () => {
    const a = compile(doc(), "bp-1");
    expect(a.map((x) => x.actionType)).toEqual([
      "create_budget",
      "create_campaign",
      "create_ad_group",
      "create_keywords",
      "create_ad",
    ]);
    expect(a.map((x) => x.seq)).toEqual([0, 1, 2, 3, 4]);
  });
  it("threads tmp: parent refs", () => {
    const a = compile(doc(), "bp-1");
    const campaign = a.find((x) => x.actionType === "create_campaign")!;
    expect((campaign.payload as { budgetRef: string }).budgetRef).toBe(
      "tmp:budget:1"
    );
    const group = a.find((x) => x.actionType === "create_ad_group")!;
    expect((group.payload as { campaignRef: string }).campaignRef).toBe(
      "tmp:campaign:2"
    );
    const kws = a.find((x) => x.actionType === "create_keywords")!;
    expect((kws.payload as { adGroupRef: string }).adGroupRef).toBe(
      "tmp:ad_group:3"
    );
    const ad = a.find((x) => x.actionType === "create_ad")!;
    expect((ad.payload as { adGroupRef: string }).adGroupRef).toBe(
      "tmp:ad_group:3"
    );
  });
  it("campaign create is PAUSED and carries geo + bidding", () => {
    const c = compile(doc(), "bp-1").find(
      (x) => x.actionType === "create_campaign"
    )!;
    const p = c.payload as { status: string; geoTargetIds: string[]; bidding: unknown };
    expect(p.status).toBe("PAUSED");
    expect(p.geoTargetIds).toEqual(["MX"]);
    expect(p.bidding).toEqual({ strategy: "MAXIMIZE_CONVERSIONS" });
  });
  it("keywords action bundles keywords + negatives", () => {
    const k = compile(doc(), "bp-1").find(
      (x) => x.actionType === "create_keywords"
    )!;
    const p = k.payload as { keywords: Array<{ negative?: boolean }> };
    expect(p.keywords.some((x) => x.negative)).toBe(true);
    expect(p.keywords.some((x) => !x.negative)).toBe(true);
  });
  it("stable recKey per (blueprintId, seq)", () => {
    expect(compile(doc(), "bp-1")[0].recKey).toBe(
      compile(doc(), "bp-1")[0].recKey
    );
    expect(compile(doc(), "bp-1")[0].recKey).not.toBe(
      compile(doc(), "bp-2")[0].recKey
    );
  });
  it("languageCode es maps to languageId 1003", () => {
    const blueprint = parseBlueprint({
      network: "google_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:2",
        name: "Camp",
        channel: "SEARCH",
        status: "PAUSED",
        budget: { nodeId: "b1", tempId: "budget:1", dailyMicros: 350_000_000 },
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
        geo: { countryCodes: ["MX"], presenceOnly: true },
        languageCode: "es",
        adGroups: [
          {
            nodeId: "g1",
            tempId: "ad_group:3",
            name: "AG",
            keywords: [{ text: "kw", match: "PHRASE" }],
            negatives: [],
            ads: [
              {
                nodeId: "a1",
                tempId: "ad:4",
                finalUrl: "https://x.mx/a",
                headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }],
                descriptions: [{ text: "D1" }, { text: "D2" }],
              },
            ],
          },
        ],
      },
    });
    const c = compile(blueprint, "bp-1").find(
      (x) => x.actionType === "create_campaign"
    )!;
    const p = c.payload as { languageId?: string };
    expect(p.languageId).toBe("1003");
  });
  it("unmapped languageCode throws", () => {
    const blueprint = parseBlueprint({
      network: "google_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:2",
        name: "Camp",
        channel: "SEARCH",
        status: "PAUSED",
        budget: { nodeId: "b1", tempId: "budget:1", dailyMicros: 350_000_000 },
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
        geo: { countryCodes: ["MX"], presenceOnly: true },
        languageCode: "xx",
        adGroups: [
          {
            nodeId: "g1",
            tempId: "ad_group:3",
            name: "AG",
            keywords: [{ text: "kw", match: "PHRASE" }],
            negatives: [],
            ads: [
              {
                nodeId: "a1",
                tempId: "ad:4",
                finalUrl: "https://x.mx/a",
                headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }],
                descriptions: [{ text: "D1" }, { text: "D2" }],
              },
            ],
          },
        ],
      },
    });
    expect(() => compile(blueprint, "bp-1")).toThrow("Idioma no soportado: xx");
  });
  it("omitted languageCode yields no languageId key", () => {
    const blueprint = parseBlueprint({
      network: "google_ads",
      campaign: {
        nodeId: "c1",
        tempId: "campaign:2",
        name: "Camp",
        channel: "SEARCH",
        status: "PAUSED",
        budget: { nodeId: "b1", tempId: "budget:1", dailyMicros: 350_000_000 },
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
        geo: { countryCodes: ["MX"], presenceOnly: true },
        adGroups: [
          {
            nodeId: "g1",
            tempId: "ad_group:3",
            name: "AG",
            keywords: [{ text: "kw", match: "PHRASE" }],
            negatives: [],
            ads: [
              {
                nodeId: "a1",
                tempId: "ad:4",
                finalUrl: "https://x.mx/a",
                headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }],
                descriptions: [{ text: "D1" }, { text: "D2" }],
              },
            ],
          },
        ],
      },
    });
    const c = compile(blueprint, "bp-1").find(
      (x) => x.actionType === "create_campaign"
    )!;
    const p = c.payload as { languageId?: string };
    expect(p.languageId).toBeUndefined();
  });
});
