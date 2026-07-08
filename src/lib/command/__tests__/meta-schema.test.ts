import { describe, it, expect } from "bun:test";
import { parseMetaBlueprint } from "../blueprint/meta-schema";
import { MICROS_PER_UNIT } from "../types";

describe("Meta blueprint schema", () => {
  const validDoc = {
    network: "meta_ads",
    campaign: {
      nodeId: "c1",
      tempId: "temp_c1",
      name: "Test Campaign",
      status: "PAUSED",
      objective: "OUTCOME_TRAFFIC",
      adsets: [
        {
          nodeId: "as1",
          tempId: "temp_as1",
          name: "Test Adset",
          status: "PAUSED",
          dailyBudgetMicros: 10_000_000, // 10 USD
          targeting: {
            countryCodes: ["US"],
            ageMin: 18,
            ageMax: 65,
          },
          ads: [
            {
              nodeId: "ad1",
              tempId: "temp_ad1",
              name: "Test Ad",
              link: "https://example.com",
              message: "Check this out!",
              headline: "Amazing",
              description: "Super cool",
              callToActionType: "LEARN_MORE",
              imageUrl: "https://example.com/image.jpg",
            },
          ],
        },
      ],
    },
  };

  it("should parse a valid Meta blueprint document", () => {
    const result = parseMetaBlueprint(validDoc);
    expect(result.network).toBe("meta_ads");
    expect(result.campaign.status).toBe("PAUSED");
    expect(result.campaign.adsets).toHaveLength(1);
    expect(result.campaign.adsets[0].ads).toHaveLength(1);
  });

  it("should reject wrong network literal", () => {
    const doc = { ...validDoc, network: "google_ads" };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should reject non-PAUSED campaign status", () => {
    const doc = {
      ...validDoc,
      campaign: { ...validDoc.campaign, status: "ACTIVE" },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should reject non-PAUSED adset status", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            status: "ACTIVE",
          },
        ],
      },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should reject budget below MICROS_PER_UNIT (cents-as-micros)", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            dailyBudgetMicros: 3500, // Below minimum
          },
        ],
      },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should reject budget not multiple of MICROS_PER_MINOR_UNIT", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            dailyBudgetMicros: 35_000_001, // Not multiple of 10,000
          },
        ],
      },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should reject EU country code", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            targeting: {
              countryCodes: ["ES"],
              ageMin: 18,
              ageMax: 65,
            },
          },
        ],
      },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should reject ageMin > ageMax", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            targeting: {
              countryCodes: ["US"],
              ageMin: 65,
              ageMax: 18,
            },
          },
        ],
      },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should reject message > 125 chars", () => {
    const longMessage = "a".repeat(126);
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            ads: [
              {
                ...validDoc.campaign.adsets[0].ads[0],
                message: longMessage,
              },
            ],
          },
        ],
      },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should reject http (non-https) imageUrl", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            ads: [
              {
                ...validDoc.campaign.adsets[0].ads[0],
                imageUrl: "http://example.com/image.jpg",
              },
            ],
          },
        ],
      },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should reject zero ads", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            ads: [],
          },
        ],
      },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should reject two adsets (length must be 1)", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          validDoc.campaign.adsets[0],
          validDoc.campaign.adsets[0],
        ],
      },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should allow message of exactly 125 chars", () => {
    const message = "a".repeat(125);
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            ads: [
              {
                ...validDoc.campaign.adsets[0].ads[0],
                message,
              },
            ],
          },
        ],
      },
    };
    const result = parseMetaBlueprint(doc);
    expect(result.campaign.adsets[0].ads[0].message).toHaveLength(125);
  });

  it("should allow headline of exactly 40 chars", () => {
    const headline = "a".repeat(40);
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            ads: [
              {
                ...validDoc.campaign.adsets[0].ads[0],
                headline,
              },
            ],
          },
        ],
      },
    };
    const result = parseMetaBlueprint(doc);
    expect(result.campaign.adsets[0].ads[0].headline).toHaveLength(40);
  });

  it("should allow description of exactly 30 chars", () => {
    const description = "a".repeat(30);
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            ads: [
              {
                ...validDoc.campaign.adsets[0].ads[0],
                description,
              },
            ],
          },
        ],
      },
    };
    const result = parseMetaBlueprint(doc);
    expect(result.campaign.adsets[0].ads[0].description).toHaveLength(30);
  });

  it("should allow all supported country codes", () => {
    const countryCodes: Array<"MX" | "US" | "AR" | "CO" | "CL" | "PE"> = [
      "MX",
      "US",
      "AR",
      "CO",
      "CL",
      "PE",
    ];
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            targeting: {
              countryCodes,
              ageMin: 18,
              ageMax: 65,
            },
          },
        ],
      },
    };
    const result = parseMetaBlueprint(doc);
    expect(result.campaign.adsets[0].targeting.countryCodes).toEqual(countryCodes);
  });

  it("should reject empty countryCodes array", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            targeting: {
              countryCodes: [],
              ageMin: 18,
              ageMax: 65,
            },
          },
        ],
      },
    };
    expect(() => parseMetaBlueprint(doc)).toThrow();
  });

  it("should allow imageUrl to be optional", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            ads: [
              {
                nodeId: "ad1",
                tempId: "temp_ad1",
                name: "Test Ad",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    };
    const result = parseMetaBlueprint(doc);
    expect(result.campaign.adsets[0].ads[0].imageUrl).toBeUndefined();
  });

  it("should allow headline and description to be optional", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            ads: [
              {
                nodeId: "ad1",
                tempId: "temp_ad1",
                name: "Test Ad",
                link: "https://example.com",
                message: "Check this out!",
              },
            ],
          },
        ],
      },
    };
    const result = parseMetaBlueprint(doc);
    expect(result.campaign.adsets[0].ads[0].headline).toBeUndefined();
    expect(result.campaign.adsets[0].ads[0].description).toBeUndefined();
  });

  it("should allow default age ranges when not provided", () => {
    const doc = {
      ...validDoc,
      campaign: {
        ...validDoc.campaign,
        adsets: [
          {
            ...validDoc.campaign.adsets[0],
            targeting: {
              countryCodes: ["US"],
            },
          },
        ],
      },
    };
    const result = parseMetaBlueprint(doc);
    expect(result.campaign.adsets[0].targeting.ageMin).toBe(18);
    expect(result.campaign.adsets[0].targeting.ageMax).toBe(65);
  });

  it("should allow all valid callToActionTypes", () => {
    const types: Array<
      "LEARN_MORE" | "CONTACT_US" | "SHOP_NOW" | "SIGN_UP" | "GET_QUOTE"
    > = ["LEARN_MORE", "CONTACT_US", "SHOP_NOW", "SIGN_UP", "GET_QUOTE"];
    for (const callToActionType of types) {
      const doc = {
        ...validDoc,
        campaign: {
          ...validDoc.campaign,
          adsets: [
            {
              ...validDoc.campaign.adsets[0],
              ads: [
                {
                  ...validDoc.campaign.adsets[0].ads[0],
                  callToActionType,
                },
              ],
            },
          ],
        },
      };
      const result = parseMetaBlueprint(doc);
      expect(result.campaign.adsets[0].ads[0].callToActionType).toBe(
        callToActionType
      );
    }
  });
});
