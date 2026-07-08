import { describe, it, expect } from "bun:test";
import { parseBlueprint, type CcBlueprintDoc } from "../blueprint/schema";
import type { PatchTarget } from "../patch/apply";
import {
  GET_DOC_ARRAY_CAP,
  MAX_PROPOSALS,
  trimDocForTool,
  executeProposePatch,
} from "../patch/tool-executors";

// ---------------------------------------------------------------------------
// Fixtures — a minimal, valid create-blueprint doc (mirrors patch-apply.test.ts).
// ---------------------------------------------------------------------------

function createDoc(): CcBlueprintDoc {
  return parseBlueprint({
    network: "google_ads",
    campaign: {
      nodeId: "n-campaign", tempId: "t-campaign", name: "Campaña Sonrisa",
      channel: "SEARCH", status: "PAUSED",
      budget: { nodeId: "n-budget", tempId: "t-budget", dailyMicros: 350_000_000 },
      bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
      geo: { countryCodes: ["MX"], presenceOnly: true },
      languageCode: "es",
      adGroups: [{
        nodeId: "n-adgroup", tempId: "t-adgroup", name: "Implantes",
        keywords: [{ text: "implantes dentales cdmx", match: "PHRASE" }],
        negatives: [],
        ads: [{
          nodeId: "n-ad", tempId: "t-ad", finalUrl: "https://clinicasonrisa.mx/implantes",
          headlines: [{ text: "Implantes en CDMX" }, { text: "Valoración Gratis" }, { text: "Clínica Sonrisa" }],
          descriptions: [{ text: "Recupera tu sonrisa con especialistas certificados." }, { text: "Agenda sin costo hoy." }],
        }],
      }],
    },
  });
}

function target(): PatchTarget {
  return { docKind: "google_create", doc: createDoc() };
}

// ---------------------------------------------------------------------------
// trimDocForTool
// ---------------------------------------------------------------------------

describe("trimDocForTool", () => {
  it("leaves a small doc byte-identical (no _truncado noise)", () => {
    const doc = createDoc();
    const trimmed = trimDocForTool(doc) as Record<string, unknown>;
    expect(trimmed._truncado).toBeUndefined();
    expect(trimmed).toEqual(doc as unknown as Record<string, unknown>);
  });

  it("caps an oversized array at GET_DOC_ARRAY_CAP and notes the cut", () => {
    const doc = createDoc();
    const big = Array.from({ length: GET_DOC_ARRAY_CAP + 5 }, (_, i) => ({ text: `kw${i}`, match: "PHRASE" as const }));
    const withBigArray = { ...doc, campaign: { ...doc.campaign, adGroups: [{ ...doc.campaign.adGroups[0], keywords: big }] } };

    const trimmed = trimDocForTool(withBigArray) as { campaign: { adGroups: Array<{ keywords: unknown[] }> }; _truncado: string[] };

    expect(trimmed.campaign.adGroups[0].keywords).toHaveLength(GET_DOC_ARRAY_CAP);
    expect(trimmed._truncado.length).toBeGreaterThan(0);
    expect(trimmed._truncado[0]).toContain(`${GET_DOC_ARRAY_CAP + 5} elementos`);
  });

  it("caps an over-long string and notes the cut", () => {
    const doc = createDoc();
    const longUrl = `https://x.mx/${"a".repeat(3000)}`;
    const withLongString = { ...doc, campaign: { ...doc.campaign, name: longUrl } };

    const trimmed = trimDocForTool(withLongString) as { campaign: { name: string }; _truncado: string[] };

    expect(trimmed.campaign.name.length).toBeLessThan(longUrl.length);
    expect(trimmed._truncado.some((n) => n.includes("recortado"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeProposePatch
// ---------------------------------------------------------------------------

describe("executeProposePatch", () => {
  it("rejects an invalid patch (unknown node) with es-MX errors, self-correctable", () => {
    const outcome = executeProposePatch(
      target(),
      "google_create",
      { summary: "Cambiar algo", ops: [{ nodeId: "no-existe", field: "name", value: "x", rationale: "porque sí" }] },
      0
    );
    expect(outcome.status).toBe("invalid");
    if (outcome.status === "invalid") {
      expect(outcome.errors.length).toBeGreaterThan(0);
      expect(outcome.errors[0].message).toContain("no-existe");
    }
  });

  it("rejects malformed args (missing summary/ops) before touching applyBlueprintPatch", () => {
    const outcome = executeProposePatch(target(), "google_create", { ops: [] }, 0);
    expect(outcome.status).toBe("invalid");
  });

  it("accepts a valid single-op patch and derives per-op rationale", () => {
    const outcome = executeProposePatch(
      target(),
      "google_create",
      {
        summary: "Subir el presupuesto diario",
        ops: [{ nodeId: "n-budget", field: "dailyMicros", value: 500_000_000, rationale: "más presupuesto para escalar" }],
      },
      0
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.proposal.summary).toBe("Subir el presupuesto diario");
      expect(outcome.proposal.ops).toHaveLength(1);
      expect(outcome.proposal.rationale).toEqual([
        { nodeId: "n-budget", field: "dailyMicros", rationale: "más presupuesto para escalar" },
      ]);
    }
  });

  it("never mutates the target doc (dry run)", () => {
    const t = target();
    const before = JSON.stringify(t.doc);
    executeProposePatch(
      t,
      "google_create",
      { summary: "Subir presupuesto", ops: [{ nodeId: "n-budget", field: "dailyMicros", value: 999_000_000, rationale: "x" }] },
      0
    );
    expect(JSON.stringify(t.doc)).toBe(before);
  });

  it("caps at MAX_PROPOSALS — further calls return 'limit' without validating", () => {
    const atCap = executeProposePatch(
      target(),
      "google_create",
      { summary: "válido", ops: [{ nodeId: "n-budget", field: "dailyMicros", value: 400_000_000, rationale: "x" }] },
      MAX_PROPOSALS
    );
    expect(atCap.status).toBe("limit");

    // Even a garbage patch at cap returns "limit", not "invalid" — the cap short-circuits first.
    const garbageAtCap = executeProposePatch(target(), "google_create", { garbage: true }, MAX_PROPOSALS);
    expect(garbageAtCap.status).toBe("limit");
  });

  it("below cap, a valid patch still succeeds", () => {
    const outcome = executeProposePatch(
      target(),
      "google_create",
      { summary: "válido", ops: [{ nodeId: "n-budget", field: "dailyMicros", value: 400_000_000, rationale: "x" }] },
      MAX_PROPOSALS - 1
    );
    expect(outcome.status).toBe("ok");
  });
});
