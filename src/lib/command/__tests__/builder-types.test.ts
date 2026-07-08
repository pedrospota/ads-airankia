import { describe, it, expect } from "bun:test";
import {
  buildDoc,
  stateFromDoc,
  microsToUnits,
  unitsToMicros,
  newBuilderIds,
  initialBuilderState,
  type BuilderState,
} from "@/app/command/crear/builder-types";
import { MICROS_PER_UNIT } from "@/lib/command/types";

describe("stateFromDoc bijection", () => {
  describe("round-trip: state → doc → state", () => {
    it("fully-populated state with TARGET_CPA bidding reproduces all writable fields", () => {
      const ids = newBuilderIds();

      // Create a fully-populated BuilderState with all non-default values
      const original: BuilderState = {
        accountRef: "customer/123/customerId/456",
        goal: "ventas",
        campaignName: "Black Friday 2026",
        dailyAmount: "500",
        bidding: "TARGET_CPA",
        targetCpaAmount: "45.50",
        targetRoas: "",
        countryCodes: ["MX", "US", "ES"],
        presenceOnly: false,
        languageCode: "es",
        groupName: "Conversiones Altas",
        keywords: [
          { text: "zapatos negros", match: "EXACT" },
          { text: "zapatos", match: "PHRASE" },
          { text: "calzado", match: "BROAD" },
        ],
        negatives: [
          { text: "gratis", match: "EXACT" },
          { text: "descuentos", match: "PHRASE" },
        ],
        finalUrl: "https://example.com/shoes",
        headlines: [
          "Zapatos Negros Premium",
          "Envío Gratis a Todo México",
          "Hasta 40% Descuento",
          "Compra Segura Garantizada",
          "Mejor Precio Garantizado",
        ],
        descriptions: [
          "Calidad premium con garantía de satisfacción al 100%.",
          "Envío rápido en 24-48 horas a tu domicilio.",
          "Elige entre 500+ modelos de zapatos en stock.",
        ],
        path1: "compra-segura",
        path2: "envio-gratis",
      };

      // Build doc from state
      const doc = buildDoc(original, ids);

      // Reconstruct state from doc
      const reconstructed = stateFromDoc(doc, original);

      // Assert field-by-field equality for writable fields
      expect(reconstructed.campaignName).toBe(original.campaignName);
      expect(reconstructed.dailyAmount).toBe(original.dailyAmount);
      expect(reconstructed.bidding).toBe(original.bidding);
      // Money values normalize through Number conversion (45.50 → 45.5)
      expect(Number(reconstructed.targetCpaAmount)).toBe(Number(original.targetCpaAmount));
      expect(reconstructed.targetRoas).toBe(original.targetRoas);
      expect(reconstructed.countryCodes).toEqual(original.countryCodes);
      expect(reconstructed.presenceOnly).toBe(original.presenceOnly);
      expect(reconstructed.languageCode).toBe(original.languageCode);
      expect(reconstructed.groupName).toBe(original.groupName);
      expect(reconstructed.keywords).toEqual(original.keywords);
      expect(reconstructed.negatives).toEqual(original.negatives);
      expect(reconstructed.finalUrl).toBe(original.finalUrl);
      expect(reconstructed.headlines).toEqual(original.headlines);
      expect(reconstructed.descriptions).toEqual(original.descriptions);
      expect(reconstructed.path1).toBe(original.path1);
      expect(reconstructed.path2).toBe(original.path2);

      // Verify prev-only fields are preserved
      expect(reconstructed.accountRef).toBe(original.accountRef);
      expect(reconstructed.goal).toBe(original.goal);
    });

    it("round-trip with TARGET_ROAS bidding", () => {
      const ids = newBuilderIds();
      const original: BuilderState = {
        accountRef: "customer/789/customerId/999",
        goal: "trafico",
        campaignName: "ROAS Campaign",
        dailyAmount: "1000",
        bidding: "TARGET_ROAS",
        targetCpaAmount: "",
        targetRoas: "3.5",
        countryCodes: ["AR"],
        presenceOnly: true,
        languageCode: "pt",
        groupName: "ROAS Group",
        keywords: [{ text: "marketing", match: "BROAD" }],
        negatives: [],
        finalUrl: "https://example.com",
        headlines: ["Title 1", "Title 2", "Title 3"],
        descriptions: ["Desc 1", "Desc 2"],
        path1: "",
        path2: "",
      };

      const doc = buildDoc(original, ids);
      const reconstructed = stateFromDoc(doc, original);

      expect(reconstructed.bidding).toBe("TARGET_ROAS");
      expect(reconstructed.targetRoas).toBe("3.5");
      expect(reconstructed.targetCpaAmount).toBe("");
      expect(reconstructed.headlines).toEqual(original.headlines);
      expect(reconstructed.descriptions).toEqual(original.descriptions);
    });

    it("round-trip with MAXIMIZE_CONVERSIONS (default) bidding", () => {
      const ids = newBuilderIds();
      const original: BuilderState = {
        accountRef: "customer/111/customerId/222",
        goal: "leads",
        campaignName: "Leads Campaign",
        dailyAmount: "250.75",
        bidding: "MAXIMIZE_CONVERSIONS",
        targetCpaAmount: "",
        targetRoas: "",
        countryCodes: ["CL", "CO"],
        presenceOnly: false,
        languageCode: "en",
        groupName: "Leads Group",
        keywords: [{ text: "contacto", match: "PHRASE" }],
        negatives: [{ text: "spam", match: "BROAD" }],
        finalUrl: "https://example.com/contact",
        headlines: ["Get in Touch", "Free Quote", "Expert Help"],
        descriptions: ["24/7 Support", "No Hidden Fees"],
        path1: "contact",
        path2: "quote",
      };

      const doc = buildDoc(original, ids);
      const reconstructed = stateFromDoc(doc, original);

      expect(reconstructed.bidding).toBe("MAXIMIZE_CONVERSIONS");
      expect(reconstructed.targetCpaAmount).toBe("");
      expect(reconstructed.targetRoas).toBe("");
    });

    it("preserves prev-only fields across round-trip", () => {
      const ids = newBuilderIds();
      const original = initialBuilderState("customer/999/customerId/888");
      const modified = { ...original, campaignName: "Modified Campaign" };

      const doc = buildDoc(modified, ids);
      const reconstructed = stateFromDoc(doc, modified);

      // prev-only fields should be preserved
      expect(reconstructed.accountRef).toBe(modified.accountRef);
      expect(reconstructed.goal).toBe(modified.goal);
    });

    it("defaults languageCode when doc lacks it", () => {
      const ids = newBuilderIds();
      let original: BuilderState = initialBuilderState("customer/123/customerId/456");
      original.languageCode = ""; // empty causes buildDoc to omit it from doc

      const doc = buildDoc(original, ids);
      // doc.campaign.languageCode will be undefined

      original.languageCode = ""; // reset to empty as per buildDoc input
      const reconstructed = stateFromDoc(doc, original);

      // stateFromDoc should default to DEFAULT_LANGUAGE
      expect(reconstructed.languageCode).toBe("es"); // DEFAULT_LANGUAGE
    });

    it("handles empty path1/path2 in round-trip", () => {
      const ids = newBuilderIds();
      const original: BuilderState = initialBuilderState("customer/123/customerId/456");
      original.campaignName = "Test";
      original.groupName = "Test Group";
      original.keywords = [{ text: "test", match: "BROAD" }];
      original.finalUrl = "https://example.com";
      original.headlines = ["Title 1", "Title 2", "Title 3"];
      original.descriptions = ["Desc 1", "Desc 2"];
      original.path1 = "";
      original.path2 = "";

      const doc = buildDoc(original, ids);
      const reconstructed = stateFromDoc(doc, original);

      expect(reconstructed.path1).toBe("");
      expect(reconstructed.path2).toBe("");
    });
  });

  describe("stateFromDoc with doc modifications", () => {
    it("reflects headline modifications from the doc", () => {
      const ids = newBuilderIds();
      const original: BuilderState = {
        accountRef: "customer/123/customerId/456",
        goal: "ventas",
        campaignName: "Test Campaign",
        dailyAmount: "500",
        bidding: "MAXIMIZE_CONVERSIONS",
        targetCpaAmount: "",
        targetRoas: "",
        countryCodes: ["MX"],
        presenceOnly: true,
        languageCode: "es",
        groupName: "Test Group",
        keywords: [{ text: "test", match: "BROAD" }],
        negatives: [],
        finalUrl: "https://example.com",
        headlines: ["Original 1", "Original 2", "Original 3"],
        descriptions: ["Desc 1", "Desc 2"],
        path1: "",
        path2: "",
      };

      const doc = buildDoc(original, ids);

      // Modify the doc's headlines (simulating an AI patch)
      doc.campaign.adGroups[0].ads[0].headlines = [
        { text: "Modified 1", pinnedField: undefined },
        { text: "Modified 2", pinnedField: undefined },
        { text: "Modified 3", pinnedField: undefined },
      ];

      const reconstructed = stateFromDoc(doc, original);

      expect(reconstructed.headlines).toEqual(["Modified 1", "Modified 2", "Modified 3"]);
      // Other fields should remain from original
      expect(reconstructed.campaignName).toBe(original.campaignName);
    });

    it("reflects campaign name modification from the doc", () => {
      const ids = newBuilderIds();
      const original = initialBuilderState("customer/123/customerId/456");
      original.campaignName = "Original Name";
      original.groupName = "Test Group";
      original.keywords = [{ text: "test", match: "BROAD" }];
      original.finalUrl = "https://example.com";
      original.headlines = ["H1", "H2", "H3"];
      original.descriptions = ["D1", "D2"];

      const doc = buildDoc(original, ids);

      // Modify campaign name in doc
      doc.campaign.name = "New Campaign Name";

      const reconstructed = stateFromDoc(doc, original);

      expect(reconstructed.campaignName).toBe("New Campaign Name");
      expect(reconstructed.groupName).toBe(original.groupName);
    });

    it("reflects budget modification from the doc", () => {
      const ids = newBuilderIds();
      const original = initialBuilderState("customer/123/customerId/456");
      original.campaignName = "Test";
      original.groupName = "Test Group";
      original.keywords = [{ text: "test", match: "BROAD" }];
      original.finalUrl = "https://example.com";
      original.headlines = ["H1", "H2", "H3"];
      original.descriptions = ["D1", "D2"];
      original.dailyAmount = "500";

      const doc = buildDoc(original, ids);

      // Modify budget in doc (to 750 currency units = 750 * MICROS_PER_UNIT micros)
      doc.campaign.budget.dailyMicros = 750 * MICROS_PER_UNIT;

      const reconstructed = stateFromDoc(doc, original);

      expect(reconstructed.dailyAmount).toBe("750");
    });

    it("reflects bidding strategy change from doc", () => {
      const ids = newBuilderIds();
      const original = initialBuilderState("customer/123/customerId/456");
      original.campaignName = "Test";
      original.groupName = "Test Group";
      original.keywords = [{ text: "test", match: "BROAD" }];
      original.finalUrl = "https://example.com";
      original.headlines = ["H1", "H2", "H3"];
      original.descriptions = ["D1", "D2"];
      original.bidding = "MAXIMIZE_CONVERSIONS";

      let doc = buildDoc(original, ids);

      // Modify to TARGET_CPA
      doc.campaign.bidding = {
        strategy: "TARGET_CPA",
        targetCpaMicros: 50 * MICROS_PER_UNIT,
      };

      let reconstructed = stateFromDoc(doc, original);
      expect(reconstructed.bidding).toBe("TARGET_CPA");
      expect(reconstructed.targetCpaAmount).toBe("50");

      // Modify back to MAXIMIZE_CONVERSIONS
      doc.campaign.bidding = { strategy: "MAXIMIZE_CONVERSIONS" };
      reconstructed = stateFromDoc(doc, original);
      expect(reconstructed.bidding).toBe("MAXIMIZE_CONVERSIONS");
      expect(reconstructed.targetCpaAmount).toBe("");
    });
  });

  describe("microsToUnits conversion", () => {
    it("converts micros to units correctly", () => {
      expect(microsToUnits(0)).toBe("0");
      expect(microsToUnits(MICROS_PER_UNIT)).toBe("1");
      expect(microsToUnits(500 * MICROS_PER_UNIT)).toBe("500");
      expect(microsToUnits(45.5 * MICROS_PER_UNIT)).toBe("45.5");
    });

    it("is the inverse of unitsToMicros", () => {
      const testValues = ["0", "1", "100", "500.75", "45.5", "1234.567"];
      testValues.forEach((val) => {
        const micros = unitsToMicros(val);
        const reconstructed = microsToUnits(micros);
        expect(reconstructed).toBe(val);
      });
    });

    it("handles fractional amounts", () => {
      const result = microsToUnits(Math.round(99.99 * MICROS_PER_UNIT));
      expect(Number(result)).toBeCloseTo(99.99, 1);
    });
  });

  describe("edge cases", () => {
    it("handles minimal valid state", () => {
      const ids = newBuilderIds();
      const minimal: BuilderState = {
        accountRef: null,
        goal: "leads",
        campaignName: "Minimal",
        dailyAmount: "1",
        bidding: "MAXIMIZE_CONVERSIONS",
        targetCpaAmount: "",
        targetRoas: "",
        countryCodes: ["MX"],
        presenceOnly: true,
        languageCode: "es",
        groupName: "Group",
        keywords: [{ text: "kw", match: "BROAD" }],
        negatives: [],
        finalUrl: "https://minimal.com",
        headlines: ["H1", "H2", "H3"],
        descriptions: ["D1", "D2"],
        path1: "",
        path2: "",
      };

      const doc = buildDoc(minimal, ids);
      const reconstructed = stateFromDoc(doc, minimal);

      expect(reconstructed).toEqual(minimal);
    });

    it("handles many keywords and negatives", () => {
      const ids = newBuilderIds();
      const original = initialBuilderState("customer/123/customerId/456");
      original.campaignName = "Test";
      original.groupName = "Test Group";
      original.finalUrl = "https://example.com";
      original.headlines = ["H1", "H2", "H3"];
      original.descriptions = ["D1", "D2"];

      // Add many keywords and negatives
      original.keywords = Array.from({ length: 10 }, (_, i) => ({
        text: `keyword${i}`,
        match: (["EXACT", "PHRASE", "BROAD"] as const)[i % 3],
      }));
      original.negatives = Array.from({ length: 5 }, (_, i) => ({
        text: `negative${i}`,
        match: (["EXACT", "PHRASE", "BROAD"] as const)[i % 3],
      }));

      const doc = buildDoc(original, ids);
      const reconstructed = stateFromDoc(doc, original);

      expect(reconstructed.keywords).toEqual(original.keywords);
      expect(reconstructed.negatives).toEqual(original.negatives);
    });

    it("handles many headlines and descriptions", () => {
      const ids = newBuilderIds();
      const original = initialBuilderState("customer/123/customerId/456");
      original.campaignName = "Test";
      original.groupName = "Test Group";
      original.keywords = [{ text: "test", match: "BROAD" }];
      original.finalUrl = "https://example.com";

      // Add max headlines and descriptions
      original.headlines = Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`);
      original.descriptions = Array.from({ length: 4 }, (_, i) => `Description ${i + 1}`);

      const doc = buildDoc(original, ids);
      const reconstructed = stateFromDoc(doc, original);

      expect(reconstructed.headlines).toEqual(original.headlines);
      expect(reconstructed.descriptions).toEqual(original.descriptions);
    });

    it("handles multiple country codes", () => {
      const ids = newBuilderIds();
      const original = initialBuilderState("customer/123/customerId/456");
      original.campaignName = "Test";
      original.groupName = "Test Group";
      original.keywords = [{ text: "test", match: "BROAD" }];
      original.finalUrl = "https://example.com";
      original.headlines = ["H1", "H2", "H3"];
      original.descriptions = ["D1", "D2"];
      original.countryCodes = ["MX", "US", "ES", "AR", "CO", "CL", "PE"];

      const doc = buildDoc(original, ids);
      const reconstructed = stateFromDoc(doc, original);

      expect(reconstructed.countryCodes).toEqual(original.countryCodes);
    });
  });
});
