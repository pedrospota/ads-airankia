import { describe, it, expect } from "bun:test";
import { blueprintDocSchema, parseBlueprint } from "../blueprint/schema";

function validDoc() {
  return {
    network: "google_ads",
    campaign: {
      nodeId: "c1", tempId: "campaign:2", name: "Sonrisa — Búsqueda MX",
      channel: "SEARCH", status: "PAUSED",
      budget: { nodeId: "b1", tempId: "budget:1", dailyMicros: 350_000_000 },
      bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
      geo: { countryCodes: ["MX"], presenceOnly: true },
      adGroups: [{
        nodeId: "g1", tempId: "ad_group:3", name: "Implantes",
        keywords: [{ text: "implantes dentales cdmx", match: "PHRASE" }],
        negatives: [{ text: "gratis", match: "PHRASE" }],
        ads: [{
          nodeId: "a1", tempId: "ad:4", finalUrl: "https://clinicasonrisa.mx/implantes",
          headlines: [{ text: "Implantes en CDMX" }, { text: "Valoración Gratis" }, { text: "Clínica Sonrisa" }],
          descriptions: [{ text: "Recupera tu sonrisa con especialistas certificados." }, { text: "Agenda sin costo hoy." }],
        }],
      }],
    },
  };
}

describe("blueprintDocSchema", () => {
  it("accepts a valid Google Search blueprint", () => {
    expect(() => parseBlueprint(validDoc())).not.toThrow();
  });
  it("rejects a non-PAUSED campaign", () => {
    const d = validDoc(); d.campaign.status = "ENABLED";
    expect(() => parseBlueprint(d)).toThrow();
  });
  it("rejects empty geo (fail-closed)", () => {
    const d = validDoc(); d.campaign.geo.countryCodes = [];
    expect(() => parseBlueprint(d)).toThrow();
  });
  it("rejects fewer than 3 headlines", () => {
    const d = validDoc(); d.campaign.adGroups[0].ads[0].headlines = [{ text: "Solo uno" }];
    expect(() => parseBlueprint(d)).toThrow();
  });
  it("rejects a headline over 30 chars", () => {
    const d = validDoc(); d.campaign.adGroups[0].ads[0].headlines[0] = { text: "x".repeat(31) };
    expect(() => parseBlueprint(d)).toThrow();
  });
  it("rejects an ad group with zero keywords", () => {
    const d = validDoc(); d.campaign.adGroups[0].keywords = [];
    expect(() => parseBlueprint(d)).toThrow();
  });
});
