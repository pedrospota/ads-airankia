import { describe, it, expect } from "bun:test";
import { parseBlueprint, type CcBlueprintDoc } from "../blueprint/schema";
import { parseEditDoc, type GoogleSearchEditDoc } from "../edit/schema";
import { applyBlueprintPatch, type ApplyPatchResult } from "../patch/apply";
import {
  MAX_PATCH_OPS,
  MAX_PROV_ENTRIES,
  WRITABLE_FIELDS,
  readProv,
  stampProv,
  clearProv,
  deriveAiMarkers,
  sanitizeProv,
  attachProvenance,
  type BlueprintPatch,
  type PatchOp,
  type ProvenanceMap,
} from "../patch/schema";

// ---------------------------------------------------------------------------
// Fixtures
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

function editDoc(): GoogleSearchEditDoc {
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

function op(partial: Partial<PatchOp> & Pick<PatchOp, "nodeId" | "field" | "value">): PatchOp {
  return { rationale: "propuesto por el copiloto", ...partial };
}

function createPatch(ops: PatchOp[], summary = "Ajustes de campaña propuestos"): BlueprintPatch {
  return { docKind: "google_create", summary, ops };
}
function editPatch(ops: PatchOp[], summary = "Ajustes de edición propuestos"): BlueprintPatch {
  return { docKind: "google_edit", summary, ops };
}

function expectOk(result: ApplyPatchResult): Extract<ApplyPatchResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  return result;
}
function expectFail(result: ApplyPatchResult): Extract<ApplyPatchResult, { ok: false }> {
  if (result.ok) throw new Error("expected failure, got ok");
  return result;
}

// ---------------------------------------------------------------------------
// WRITABLE_FIELDS registry — exact contents per spec §a
// ---------------------------------------------------------------------------

describe("WRITABLE_FIELDS registry", () => {
  it("matches the spec's google_create field lists exactly", () => {
    expect([...WRITABLE_FIELDS.google_create.campaign].sort()).toEqual(["bidding", "geo", "languageCode", "name"]);
    expect([...WRITABLE_FIELDS.google_create.budget].sort()).toEqual(["dailyMicros"]);
    expect([...WRITABLE_FIELDS.google_create.adGroup].sort()).toEqual(["keywords", "name", "negatives"]);
    expect([...WRITABLE_FIELDS.google_create.ad].sort()).toEqual(["descriptions", "finalUrl", "headlines", "path1", "path2"]);
    expect([...WRITABLE_FIELDS.google_create.baseKeyword]).toEqual([]);
  });
  it("matches the spec's google_edit field lists exactly (the mergeEditDoc-lifted set)", () => {
    expect([...WRITABLE_FIELDS.google_edit.campaign].sort()).toEqual(["desired.dailyBudgetMicros", "desired.status", "newNegatives", "removeNegatives"]);
    expect([...WRITABLE_FIELDS.google_edit.adGroup].sort()).toEqual(["desired.cpcBidMicros", "desired.status", "newAds", "newKeywords"]);
    expect([...WRITABLE_FIELDS.google_edit.baseKeyword]).toEqual(["desiredStatus"]);
    expect([...WRITABLE_FIELDS.google_edit.ad]).toEqual(["replacement"]);
    expect([...WRITABLE_FIELDS.google_edit.budget]).toEqual([]);
  });
  it("never lists status/channel/nodeId/tempId as writable anywhere in google_create", () => {
    const forbidden = ["status", "channel", "nodeId", "tempId"];
    for (const kind of Object.keys(WRITABLE_FIELDS.google_create) as Array<keyof typeof WRITABLE_FIELDS.google_create>) {
      for (const f of WRITABLE_FIELDS.google_create[kind]) expect(forbidden).not.toContain(f);
    }
  });
  it("never lists base*/resourceName/id/loadedAt as writable anywhere in google_edit", () => {
    const forbidden = ["base", "resourceName", "id", "loadedAt", "baseKeywords", "baseNegatives", "unsupported", "status"];
    for (const kind of Object.keys(WRITABLE_FIELDS.google_edit) as Array<keyof typeof WRITABLE_FIELDS.google_edit>) {
      for (const f of WRITABLE_FIELDS.google_edit[kind]) expect(forbidden).not.toContain(f);
    }
  });

  // Fail-closed: the builder has no BuilderState slot for ad-group CPC, so an accepted
  // create-doc patch on adGroup.cpcMicros would silently vanish on the next buildDoc() while
  // its `_prov` key kept mislabeling the field as AI-authored. Re-add once BuilderState loads
  // it — the edit-doc side already supports the equivalent via desired.cpcBidMicros below.
  it("rejects a create-doc patch on adGroup field cpcMicros — not writable (no BuilderState slot)", () => {
    const doc = createDoc();
    const result = expectFail(applyBlueprintPatch(
      { docKind: "google_create", doc },
      createPatch([op({ nodeId: doc.campaign.adGroups[0].nodeId, field: "cpcMicros", value: 900_000 })])
    ));
    expect(result.errors[0].message).toContain("cpcMicros");
    expect(result.errors[0].message).toContain("no se puede modificar");
  });

  it("edit-side desired.cpcBidMicros stays writable and unaffected by the create-side cpcMicros removal", () => {
    expect(WRITABLE_FIELDS.google_edit.adGroup).toContain("desired.cpcBidMicros");
    const doc = editDoc();
    const ag = doc.campaign.adGroups[0];
    const result = expectOk(applyBlueprintPatch(
      { docKind: "google_edit", doc },
      editPatch([op({ nodeId: ag.resourceName, field: "desired.cpcBidMicros", value: 900_000 })])
    ));
    expect((result.doc as GoogleSearchEditDoc).campaign.adGroups[0].desired.cpcBidMicros).toBe(900_000);
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — patch shape
// ---------------------------------------------------------------------------

describe("applyBlueprintPatch — rule 1: patch shape", () => {
  it("rejects more than MAX_PATCH_OPS ops", () => {
    const doc = createDoc();
    const ops = Array.from({ length: MAX_PATCH_OPS + 1 }, () => op({ nodeId: doc.campaign.nodeId, field: "name", value: "x" }));
    expect(applyBlueprintPatch({ docKind: "google_create", doc }, createPatch(ops)).ok).toBe(false);
  });
  it("accepts exactly MAX_PATCH_OPS ops (boundary)", () => {
    const doc = createDoc();
    const ops = Array.from({ length: MAX_PATCH_OPS }, () => op({ nodeId: doc.campaign.nodeId, field: "name", value: "Campaña Actualizada" }));
    expect(applyBlueprintPatch({ docKind: "google_create", doc }, createPatch(ops)).ok).toBe(true);
  });
  it("rejects zero ops", () => {
    const doc = createDoc();
    expect(applyBlueprintPatch({ docKind: "google_create", doc }, createPatch([])).ok).toBe(false);
  });
  it("rejects a rationale over 300 chars", () => {
    const doc = createDoc();
    const ops = [op({ nodeId: doc.campaign.nodeId, field: "name", value: "x", rationale: "r".repeat(301) })];
    expect(applyBlueprintPatch({ docKind: "google_create", doc }, createPatch(ops)).ok).toBe(false);
  });
  it("rejects a summary over 160 chars", () => {
    const doc = createDoc();
    const ops = [op({ nodeId: doc.campaign.nodeId, field: "name", value: "x" })];
    expect(applyBlueprintPatch({ docKind: "google_create", doc }, createPatch(ops, "s".repeat(161))).ok).toBe(false);
  });
  it("rejects when the patch docKind doesn't match the target's", () => {
    const doc = createDoc();
    const patch = editPatch([op({ nodeId: "campaign", field: "desired.status", value: "PAUSED" })]);
    expect(applyBlueprintPatch({ docKind: "google_create", doc }, patch).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — node resolution (unknown node)
// ---------------------------------------------------------------------------

describe("applyBlueprintPatch — rule 2: unknown node", () => {
  it("create: rejects an unknown nodeId", () => {
    const doc = createDoc();
    const result = expectFail(applyBlueprintPatch({ docKind: "google_create", doc }, createPatch([op({ nodeId: "does-not-exist", field: "name", value: "x" })])));
    expect(result.errors[0].message).toContain("nodo");
  });
  it("edit: rejects an unknown nodeId", () => {
    const doc = editDoc();
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: "customers/999/adGroups/1", field: "desired.status", value: "PAUSED" })]));
    expect(result.ok).toBe(false);
  });
  it("edit: rejects desiredStatus targeting a keyword row that doesn't exist (the mergeEditDoc invariant, enforced here by node resolution)", () => {
    const doc = editDoc();
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: "customers/123/adGroupCriteria/7~999", field: "desiredStatus", value: "PAUSED" })]));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — every server-owned field rejected (create)
// ---------------------------------------------------------------------------

describe("applyBlueprintPatch — rule 3: server-owned fields rejected (create)", () => {
  const doc = createDoc();
  const targets: Array<{ label: string; nodeId: string; field: string; value: unknown }> = [
    { label: "campaign.status", nodeId: doc.campaign.nodeId, field: "status", value: "ENABLED" },
    { label: "campaign.channel", nodeId: doc.campaign.nodeId, field: "channel", value: "DISPLAY" },
    { label: "campaign.nodeId", nodeId: doc.campaign.nodeId, field: "nodeId", value: "hacked" },
    { label: "campaign.tempId", nodeId: doc.campaign.nodeId, field: "tempId", value: "hacked" },
    { label: "budget.nodeId", nodeId: doc.campaign.budget.nodeId, field: "nodeId", value: "hacked" },
    { label: "budget.tempId", nodeId: doc.campaign.budget.nodeId, field: "tempId", value: "hacked" },
    { label: "adGroup.nodeId", nodeId: doc.campaign.adGroups[0].nodeId, field: "nodeId", value: "hacked" },
    { label: "adGroup.tempId", nodeId: doc.campaign.adGroups[0].nodeId, field: "tempId", value: "hacked" },
    { label: "ad.nodeId", nodeId: doc.campaign.adGroups[0].ads[0].nodeId, field: "nodeId", value: "hacked" },
    { label: "ad.tempId", nodeId: doc.campaign.adGroups[0].ads[0].nodeId, field: "tempId", value: "hacked" },
  ];
  for (const t of targets) {
    it(`rejects ${t.label}`, () => {
      const result = applyBlueprintPatch({ docKind: "google_create", doc: createDoc() }, createPatch([op({ nodeId: t.nodeId, field: t.field, value: t.value })]));
      expect(result.ok).toBe(false);
    });
  }
});

describe("applyBlueprintPatch — rule 3: server-owned fields rejected (edit)", () => {
  const doc = editDoc();
  const ag = doc.campaign.adGroups[0];
  const kwRow = ag.baseKeywords[0];
  const adRow = ag.ads[0];
  const targets: Array<{ label: string; nodeId: string; field: string; value: unknown }> = [
    { label: "campaign.resourceName", nodeId: "campaign", field: "resourceName", value: "hacked" },
    { label: "campaign.id", nodeId: "campaign", field: "id", value: "999" },
    { label: "campaign.base", nodeId: "campaign", field: "base", value: {} },
    { label: "campaign.loadedAt", nodeId: "campaign", field: "loadedAt", value: "2099-01-01T00:00:00.000Z" },
    { label: "campaign.baseNegatives", nodeId: "campaign", field: "baseNegatives", value: [] },
    { label: "adGroup.resourceName", nodeId: ag.resourceName, field: "resourceName", value: "hacked" },
    { label: "adGroup.id", nodeId: ag.resourceName, field: "id", value: "999" },
    { label: "adGroup.base", nodeId: ag.resourceName, field: "base", value: {} },
    { label: "baseKeyword.status", nodeId: kwRow.resourceName, field: "status", value: "PAUSED" },
    { label: "baseKeyword.text", nodeId: kwRow.resourceName, field: "text", value: "robada" },
    { label: "baseKeyword.match", nodeId: kwRow.resourceName, field: "match", value: "BROAD" },
    { label: "baseKeyword.negative", nodeId: kwRow.resourceName, field: "negative", value: true },
    { label: "baseKeyword.resourceName", nodeId: kwRow.resourceName, field: "resourceName", value: "hacked" },
    { label: "ad.resourceName", nodeId: adRow.resourceName, field: "resourceName", value: "hacked" },
    { label: "ad.unsupported", nodeId: adRow.resourceName, field: "unsupported", value: true },
    { label: "ad.base", nodeId: adRow.resourceName, field: "base", value: {} },
  ];
  for (const t of targets) {
    it(`rejects ${t.label}`, () => {
      const result = applyBlueprintPatch({ docKind: "google_edit", doc: editDoc() }, editPatch([op({ nodeId: t.nodeId, field: t.field, value: t.value })]));
      expect(result.ok).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Rule 3 — prototype-chain field names must fail closed, never throw
// ---------------------------------------------------------------------------

describe("applyBlueprintPatch — rule 3: prototype-chain field names never crash the chokepoint", () => {
  const protoFields = ["__proto__", "constructor", "toString"];

  for (const field of protoFields) {
    it(`create: field "${field}" returns ok:false instead of throwing`, () => {
      const doc = createDoc();
      let result: ApplyPatchResult | undefined;
      expect(() => {
        result = applyBlueprintPatch({ docKind: "google_create", doc }, createPatch([op({ nodeId: doc.campaign.nodeId, field, value: "x" })]));
      }).not.toThrow();
      const failed = expectFail(result as ApplyPatchResult);
      expect(failed.errors[0].message).toContain(field);
    });

    it(`edit: field "${field}" returns ok:false instead of throwing`, () => {
      const doc = editDoc();
      let result: ApplyPatchResult | undefined;
      expect(() => {
        result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: "campaign", field, value: "x" })]));
      }).not.toThrow();
      const failed = expectFail(result as ApplyPatchResult);
      expect(failed.errors[0].message).toContain(field);
    });
  }
});

// ---------------------------------------------------------------------------
// Rule 3 — value rejected by the field's own real sub-schema
// ---------------------------------------------------------------------------

describe("applyBlueprintPatch — rule 3: value vs sub-schema", () => {
  it("create: rejects a 31-char headline", () => {
    const doc = createDoc();
    const bad = [{ text: "x".repeat(31) }, { text: "b" }, { text: "c" }];
    const result = applyBlueprintPatch({ docKind: "google_create", doc }, createPatch([op({ nodeId: doc.campaign.adGroups[0].ads[0].nodeId, field: "headlines", value: bad })]));
    expect(result.ok).toBe(false);
  });
  it("create: rejects a budget below the MICROS_PER_UNIT floor", () => {
    const doc = createDoc();
    const result = applyBlueprintPatch({ docKind: "google_create", doc }, createPatch([op({ nodeId: doc.campaign.budget.nodeId, field: "dailyMicros", value: 1 })]));
    expect(result.ok).toBe(false);
  });
  it("create: rejects a wrong-typed bidding value", () => {
    const doc = createDoc();
    const result = applyBlueprintPatch({ docKind: "google_create", doc }, createPatch([op({ nodeId: doc.campaign.nodeId, field: "bidding", value: { strategy: "NOT_REAL" } })]));
    expect(result.ok).toBe(false);
  });
  it("create: rejects empty geo.countryCodes (fail-closed)", () => {
    const doc = createDoc();
    const result = applyBlueprintPatch({ docKind: "google_create", doc }, createPatch([op({ nodeId: doc.campaign.nodeId, field: "geo", value: { countryCodes: [], presenceOnly: true } })]));
    expect(result.ok).toBe(false);
  });
  it("create: rejects a non-URL finalUrl", () => {
    const doc = createDoc();
    const result = applyBlueprintPatch({ docKind: "google_create", doc }, createPatch([op({ nodeId: doc.campaign.adGroups[0].ads[0].nodeId, field: "finalUrl", value: "not-a-url" })]));
    expect(result.ok).toBe(false);
  });
  it("create: rejects a zero-keyword array (adGroup.keywords requires min 1)", () => {
    const doc = createDoc();
    const result = applyBlueprintPatch({ docKind: "google_create", doc }, createPatch([op({ nodeId: doc.campaign.adGroups[0].nodeId, field: "keywords", value: [] })]));
    expect(result.ok).toBe(false);
  });
  it("edit: rejects cpcBidMicros below the 10_000-micros floor", () => {
    const doc = editDoc();
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: doc.campaign.adGroups[0].resourceName, field: "desired.cpcBidMicros", value: 9_999 })]));
    expect(result.ok).toBe(false);
  });
  it("edit: rejects dailyBudgetMicros below the floor", () => {
    const doc = editDoc();
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: "campaign", field: "desired.dailyBudgetMicros", value: 1 })]));
    expect(result.ok).toBe(false);
  });
  it("edit: rejects a bad desired.status enum", () => {
    const doc = editDoc();
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: "campaign", field: "desired.status", value: "REMOVED" })]));
    expect(result.ok).toBe(false);
  });
  it("edit: rejects a replacement missing required fields", () => {
    const doc = editDoc();
    const adRow = doc.campaign.adGroups[0].ads[0];
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: adRow.resourceName, field: "replacement", value: { tempId: "t1" } })]));
    expect(result.ok).toBe(false);
  });
  it("edit: rejects newKeywords with a malformed entry (missing text)", () => {
    const doc = editDoc();
    const ag = doc.campaign.adGroups[0];
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: ag.resourceName, field: "newKeywords", value: [{ match: "EXACT" }] })]));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — edit invariants
// ---------------------------------------------------------------------------

describe("applyBlueprintPatch — rule 4: edit invariants mirrored from mergeEditDoc", () => {
  it("rejects removeNegatives referencing a resourceName foreign to baseNegatives", () => {
    const doc = editDoc();
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: "campaign", field: "removeNegatives", value: ["customers/999/campaignCriteria/999~1"] })]));
    expect(result.ok).toBe(false);
  });
  it("accepts removeNegatives when every resourceName is a known baseNegative", () => {
    const doc = editDoc();
    const rn = doc.campaign.baseNegatives[0].resourceName;
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: "campaign", field: "removeNegatives", value: [rn] })]));
    expect(result.ok).toBe(true);
  });
  it("rejects a mixed removeNegatives array (one known + one foreign)", () => {
    const doc = editDoc();
    const rn = doc.campaign.baseNegatives[0].resourceName;
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: "campaign", field: "removeNegatives", value: [rn, "customers/999/campaignCriteria/999~1"] })]));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — full-doc re-parse / blast bound via patch
// ---------------------------------------------------------------------------

describe("applyBlueprintPatch — rule 5: EDIT_BATCH_MAX blast bound fires on the whole doc", () => {
  function editDocWithManyKeywords(preChangedCount: number, freshCount: number): GoogleSearchEditDoc {
    const doc = editDoc();
    const changed = Array.from({ length: preChangedCount }, (_, i) => ({
      text: "kw", match: "PHRASE" as const, negative: false,
      resourceName: `customers/123/adGroupCriteria/7~changed-${i}`,
      status: "ENABLED" as const, desiredStatus: "PAUSED" as const,
    }));
    const fresh = Array.from({ length: freshCount }, (_, i) => ({
      text: "kw", match: "PHRASE" as const, negative: false,
      resourceName: `customers/123/adGroupCriteria/7~fresh-${i}`,
      status: "ENABLED" as const,
    }));
    doc.campaign.adGroups[0].baseKeywords = [...changed, ...fresh];
    return doc;
  }

  it("EDIT_BATCH_MAX overflow through desiredStatus ops rejects the whole patch", () => {
    const preChanged = 95;
    const freshCount = 10;
    const doc = editDocWithManyKeywords(preChanged, freshCount);
    const before = structuredClone(doc);
    const ops = Array.from({ length: freshCount }, (_, i) =>
      op({ nodeId: `customers/123/adGroupCriteria/7~fresh-${i}`, field: "desiredStatus", value: "PAUSED" })
    );
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch(ops));
    expect(result.ok).toBe(false);
    expect(doc).toEqual(before); // input untouched even on a rule-5 rejection
  });

  it("stays under the bound when the total stays at or below EDIT_BATCH_MAX", () => {
    const preChanged = 90;
    const freshCount = 10; // 90 + 10 = 100, exactly at the cap
    const doc = editDocWithManyKeywords(preChanged, freshCount);
    const ops = Array.from({ length: freshCount }, (_, i) =>
      op({ nodeId: `customers/123/adGroupCriteria/7~fresh-${i}`, field: "desiredStatus", value: "PAUSED" })
    );
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch(ops));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ALL-OR-NOTHING
// ---------------------------------------------------------------------------

describe("applyBlueprintPatch — ALL-OR-NOTHING", () => {
  it("create: one bad op among three rejects the whole patch and leaves the input doc untouched", () => {
    const doc = createDoc();
    const before = structuredClone(doc);
    const ops = [
      op({ nodeId: doc.campaign.nodeId, field: "name", value: "Nueva Campaña" }),
      op({ nodeId: doc.campaign.budget.nodeId, field: "dailyMicros", value: 400_000_000 }),
      op({ nodeId: doc.campaign.nodeId, field: "status", value: "ENABLED" }), // server-owned — the bad op
    ];
    const result = applyBlueprintPatch({ docKind: "google_create", doc }, createPatch(ops));
    expect(result.ok).toBe(false);
    expect(doc).toEqual(before);
  });

  it("edit: one bad op among three rejects the whole patch and leaves the input doc untouched", () => {
    const doc = editDoc();
    const before = structuredClone(doc);
    const kwRow = doc.campaign.adGroups[0].baseKeywords[0];
    const ag = doc.campaign.adGroups[0];
    const ops = [
      op({ nodeId: kwRow.resourceName, field: "desiredStatus", value: "PAUSED" }),
      op({ nodeId: ag.resourceName, field: "desired.cpcBidMicros", value: 900_000 }),
      op({ nodeId: "campaign", field: "removeNegatives", value: ["customers/999/campaignCriteria/999~1"] }), // foreign — the bad op
    ];
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch(ops));
    expect(result.ok).toBe(false);
    expect(doc).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

// applyBlueprintPatch's PatchTarget param is a union, so ApplyPatchResult['doc'] is the
// full CcBlueprintDoc | GoogleSearchEditDoc union regardless of which member was passed in
// (TS doesn't narrow a non-generic function's return type by call-site argument shape).
// These thin wrappers narrow it back for the docKind-specific happy-path assertions below.
function applyCreateOk(doc: CcBlueprintDoc, patch: BlueprintPatch): CcBlueprintDoc {
  const result = expectOk(applyBlueprintPatch({ docKind: "google_create", doc }, patch));
  return result.doc as CcBlueprintDoc;
}
function applyEditOk(doc: GoogleSearchEditDoc, patch: BlueprintPatch): GoogleSearchEditDoc {
  const result = expectOk(applyBlueprintPatch({ docKind: "google_edit", doc }, patch));
  return result.doc as GoogleSearchEditDoc;
}

describe("applyBlueprintPatch — happy paths (create)", () => {
  it("changes the budget dailyMicros", () => {
    const doc = createDoc();
    const before = structuredClone(doc);
    const result = expectOk(applyBlueprintPatch({ docKind: "google_create", doc }, createPatch([op({ nodeId: doc.campaign.budget.nodeId, field: "dailyMicros", value: 500_000_000 })])));
    expect((result.doc as CcBlueprintDoc).campaign.budget.dailyMicros).toBe(500_000_000);
    expect(result.touched).toEqual([{ nodeId: doc.campaign.budget.nodeId, field: "dailyMicros" }]);
    expect(doc).toEqual(before); // input untouched even on success
  });

  it("swaps ad headlines", () => {
    const doc = createDoc();
    const newHeadlines = [{ text: "Nuevo título 1" }, { text: "Nuevo título 2" }, { text: "Nuevo título 3" }];
    const outDoc = applyCreateOk(doc, createPatch([op({ nodeId: doc.campaign.adGroups[0].ads[0].nodeId, field: "headlines", value: newHeadlines })]));
    expect(outDoc.campaign.adGroups[0].ads[0].headlines).toEqual(newHeadlines);
  });

  it("adds a keyword", () => {
    const doc = createDoc();
    const newKeywords = [...doc.campaign.adGroups[0].keywords, { text: "dentista cdmx", match: "BROAD" as const }];
    const outDoc = applyCreateOk(doc, createPatch([op({ nodeId: doc.campaign.adGroups[0].nodeId, field: "keywords", value: newKeywords })]));
    expect(outDoc.campaign.adGroups[0].keywords).toHaveLength(2);
  });
});

describe("applyBlueprintPatch — happy paths (edit)", () => {
  it("pauses an existing keyword", () => {
    const doc = editDoc();
    const kwRow = doc.campaign.adGroups[0].baseKeywords[0];
    const outDoc = applyEditOk(doc, editPatch([op({ nodeId: kwRow.resourceName, field: "desiredStatus", value: "PAUSED" })]));
    const row = outDoc.campaign.adGroups[0].baseKeywords.find((k) => k.resourceName === kwRow.resourceName);
    expect(row?.desiredStatus).toBe("PAUSED");
  });

  it("changes ad-group CPC bid", () => {
    const doc = editDoc();
    const ag = doc.campaign.adGroups[0];
    const outDoc = applyEditOk(doc, editPatch([op({ nodeId: ag.resourceName, field: "desired.cpcBidMicros", value: 900_000 })]));
    expect(outDoc.campaign.adGroups[0].desired.cpcBidMicros).toBe(900_000);
  });

  it("removes a campaign negative", () => {
    const doc = editDoc();
    const rn = doc.campaign.baseNegatives[0].resourceName;
    const outDoc = applyEditOk(doc, editPatch([op({ nodeId: "campaign", field: "removeNegatives", value: [rn] })]));
    expect(outDoc.campaign.removeNegatives).toEqual([rn]);
  });

  it("touched reports the CANONICAL id, not the raw op.nodeId — the 'campaign' alias normalizes to the real resourceName", () => {
    const doc = editDoc();
    const result = expectOk(applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: "campaign", field: "desired.status", value: "PAUSED" })])));
    expect(result.touched).toEqual([{ nodeId: doc.campaign.resourceName, field: "desired.status" }]);
  });

  it("touched reports the resourceName unchanged when the op already addressed it directly", () => {
    const doc = editDoc();
    const ag = doc.campaign.adGroups[0];
    const result = expectOk(applyBlueprintPatch({ docKind: "google_edit", doc }, editPatch([op({ nodeId: ag.resourceName, field: "desired.cpcBidMicros", value: 900_000 })])));
    expect(result.touched).toEqual([{ nodeId: ag.resourceName, field: "desired.cpcBidMicros" }]);
  });
});

// ---------------------------------------------------------------------------
// Provenance helpers
// ---------------------------------------------------------------------------

describe("provenance helpers", () => {
  it("readProv strips non-'ia' values and non-object garbage", () => {
    expect(readProv({ _prov: { "a:name": "ia", "b:name": "manual", "c:name": 1 } })).toEqual({ "a:name": "ia" });
    expect(readProv({ _prov: "not-an-object" })).toEqual({});
    expect(readProv({ _prov: ["ia"] })).toEqual({});
    expect(readProv({})).toEqual({});
    expect(readProv(null)).toEqual({});
  });

  it("stampProv adds keys with value 'ia', purely (doesn't mutate the input map)", () => {
    const original: ProvenanceMap = { "a:name": "ia" };
    const next = stampProv(original, ["b:field", "c:field"]);
    expect(next).toEqual({ "a:name": "ia", "b:field": "ia", "c:field": "ia" });
    expect(original).toEqual({ "a:name": "ia" }); // unchanged
  });

  it("clearProv removes a key, purely (doesn't mutate the input map); no-ops on a missing key", () => {
    const original: ProvenanceMap = { "a:name": "ia", "b:field": "ia" };
    const next = clearProv(original, "a:name");
    expect(next).toEqual({ "b:field": "ia" });
    expect(original).toEqual({ "a:name": "ia", "b:field": "ia" }); // unchanged
    expect(clearProv(original, "does-not-exist")).toEqual(original);
  });

  it("deriveAiMarkers (create): maps prov nodeIds to the nodes' compile-time tempIds", () => {
    const doc = createDoc();
    const prov: ProvenanceMap = {
      [`${doc.campaign.budget.nodeId}:dailyMicros`]: "ia",
      [`${doc.campaign.adGroups[0].ads[0].nodeId}:headlines`]: "ia",
    };
    const markers = deriveAiMarkers(doc, prov).sort();
    expect(markers).toEqual([doc.campaign.adGroups[0].ads[0].tempId, doc.campaign.budget.tempId].sort());
  });

  it("deriveAiMarkers (create): ignores keys whose node no longer exists in the doc", () => {
    const doc = createDoc();
    const prov: ProvenanceMap = { "stale-node-id:name": "ia" };
    expect(deriveAiMarkers(doc, prov)).toEqual([]);
  });

  it("deriveAiMarkers (edit): keys by diff.ts's entityRef literal (campaign.id / group.id) — NOT resourceName — normalizing the 'campaign' alias too", () => {
    const doc = editDoc();
    const prov: ProvenanceMap = {
      "campaign:desired.status": "ia",
      [`${doc.campaign.adGroups[0].resourceName}:desired.cpcBidMicros`]: "ia",
    };
    const markers = deriveAiMarkers(doc, prov).sort();
    expect(markers).toEqual([doc.campaign.id, doc.campaign.adGroups[0].id].sort());
  });

  it("deriveAiMarkers (edit): dedupes multiple 'ia' fields on the same node into one marker", () => {
    const doc = editDoc();
    const ag = doc.campaign.adGroups[0];
    const prov: ProvenanceMap = {
      [`${ag.resourceName}:desired.status`]: "ia",
      [`${ag.resourceName}:desired.cpcBidMicros`]: "ia",
    };
    expect(deriveAiMarkers(doc, prov)).toEqual([ag.id]);
  });

  it("deriveAiMarkers (edit): campaign desired.dailyBudgetMicros + a baseKeyword desiredStatus -> [campaign.id, group.id] (batched keyword action's entityRef is the GROUP id, not the keyword row's resourceName)", () => {
    const doc = editDoc();
    const ag = doc.campaign.adGroups[0];
    const kwRow = ag.baseKeywords[0];
    const prov: ProvenanceMap = {
      "campaign:desired.dailyBudgetMicros": "ia",
      [`${kwRow.resourceName}:desiredStatus`]: "ia",
    };
    const markers = deriveAiMarkers(doc, prov).sort();
    expect(markers).toEqual([doc.campaign.id, ag.id].sort());
  });

  it("deriveAiMarkers (edit): adGroup.newKeywords -> the create_keywords action's entityRef `tmp:kw:${group.id}`", () => {
    const doc = editDoc();
    const ag = doc.campaign.adGroups[0];
    const prov: ProvenanceMap = { [`${ag.resourceName}:newKeywords`]: "ia" };
    expect(deriveAiMarkers(doc, prov)).toEqual([`tmp:kw:${ag.id}`]);
  });

  it("deriveAiMarkers (edit): ad.replacement marks BOTH the create (tmp:tempId) and the old ad's pause (resourceName) when the old ad was ENABLED", () => {
    const doc = editDoc();
    const ag = doc.campaign.adGroups[0];
    const adRow = ag.ads[0];
    expect(adRow.base.status).toBe("ENABLED");
    const withReplacement: GoogleSearchEditDoc = structuredClone(doc);
    withReplacement.campaign.adGroups[0].ads[0].replacement = {
      tempId: "t-new-ad", finalUrl: "https://x.com/new",
      headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }],
      descriptions: [{ text: "D1" }, { text: "D2" }],
    };
    const prov: ProvenanceMap = { [`${adRow.resourceName}:replacement`]: "ia" };
    const markers = deriveAiMarkers(withReplacement, prov).sort();
    expect(markers).toEqual([adRow.resourceName, "tmp:t-new-ad"].sort());
  });

  it("deriveAiMarkers (create): adGroup.keywords -> the create_keywords action's localRef `${tempId}:kw`, not the bare adGroup tempId", () => {
    const doc = createDoc();
    const ag = doc.campaign.adGroups[0];
    const prov: ProvenanceMap = { [`${ag.nodeId}:keywords`]: "ia" };
    expect(deriveAiMarkers(doc, prov)).toEqual([`${ag.tempId}:kw`]);
  });

  it("deriveAiMarkers (create): adGroup.negatives -> the same create_keywords `:kw` localRef as keywords", () => {
    const doc = createDoc();
    const ag = doc.campaign.adGroups[0];
    const prov: ProvenanceMap = { [`${ag.nodeId}:negatives`]: "ia" };
    expect(deriveAiMarkers(doc, prov)).toEqual([`${ag.tempId}:kw`]);
  });

  it("deriveAiMarkers (create): adGroup.name -> the bare adGroup tempId (create_ad_group's own localRef, distinct from :kw)", () => {
    const doc = createDoc();
    const ag = doc.campaign.adGroups[0];
    const prov: ProvenanceMap = { [`${ag.nodeId}:name`]: "ia" };
    expect(deriveAiMarkers(doc, prov)).toEqual([ag.tempId]);
  });

  describe("sanitizeProv", () => {
    it("keeps a key that resolves to a writable field of the merged doc", () => {
      const doc = editDoc();
      const ag = doc.campaign.adGroups[0];
      const key = `${ag.resourceName}:desired.status`;
      expect(sanitizeProv(doc, { [key]: "ia" })).toEqual({ [key]: "ia" });
    });

    it("drops a prototype-chain field name (__proto__) instead of treating it as a valid writable field", () => {
      const doc = editDoc();
      expect(sanitizeProv(doc, { "campaign:__proto__": "ia" })).toEqual({});
    });

    it("drops a key whose field is not writable (e.g. resourceName, base)", () => {
      const doc = editDoc();
      const ag = doc.campaign.adGroups[0];
      const raw = { [`${ag.resourceName}:resourceName`]: "ia", [`campaign:base`]: "ia" };
      expect(sanitizeProv(doc, raw)).toEqual({});
    });

    it("drops a key whose node no longer exists in the merged doc", () => {
      const doc = editDoc();
      expect(sanitizeProv(doc, { "customers/999/adGroups/1:desired.status": "ia" })).toEqual({});
    });

    it("drops a key whose value isn't exactly 'ia'", () => {
      const doc = editDoc();
      const ag = doc.campaign.adGroups[0];
      expect(sanitizeProv(doc, { [`${ag.resourceName}:desired.status`]: "manual" })).toEqual({});
    });

    it("drops garbage input (non-object, array, null)", () => {
      const doc = editDoc();
      expect(sanitizeProv(doc, "not-an-object")).toEqual({});
      expect(sanitizeProv(doc, ["ia"])).toEqual({});
      expect(sanitizeProv(doc, null)).toEqual({});
    });

    it("caps at MAX_PROV_ENTRIES raw entries by position — a valid key beyond the cap is dropped", () => {
      const doc = editDoc();
      const validKey = `${doc.campaign.resourceName}:desired.status`;
      const raw: Record<string, string> = {};
      for (let i = 0; i < MAX_PROV_ENTRIES; i++) raw[`garbage-node-${i}:garbage-field`] = "ia";
      raw[validKey] = "ia"; // the (MAX_PROV_ENTRIES + 1)-th inserted key
      const result = sanitizeProv(doc, raw);
      expect(Object.keys(result)).toHaveLength(0);
      expect(result[validKey]).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// attachProvenance — the edit PUT route's re-attach composition (Task 4, spec §b "the one
// real plumbing change"): sanitizeProv -> deriveAiMarkers -> spread onto the merged doc.
// ---------------------------------------------------------------------------

describe("attachProvenance", () => {
  it("valid keys survive the merge round-trip: _prov keeps them and _ai derives from them", () => {
    const doc = editDoc();
    const ag = doc.campaign.adGroups[0];
    const key = `${ag.resourceName}:desired.status`;
    const result = attachProvenance(doc, { [key]: "ia" });
    expect(result._prov).toEqual({ [key]: "ia" });
    expect(result._ai).toEqual([ag.id]);
    // The doc's own fields ride along unchanged — this is a spread onto the merged doc, not
    // a replacement of it.
    expect(result.campaign.resourceName).toBe(doc.campaign.resourceName);
    expect(result.campaign.adGroups[0].desired).toEqual(ag.desired);
  });

  it("drops unknown and prototype-chain keys via sanitizeProv before deriving _ai (they never reach the output)", () => {
    const doc = editDoc();
    const result = attachProvenance(doc, {
      "campaign:__proto__": "ia",
      "does-not-exist:field": "ia",
      "campaign:resourceName": "ia", // a real but non-writable field
    });
    expect("_prov" in result).toBe(false);
    expect("_ai" in result).toBe(false);
  });

  it("empty -> no siblings: rawProv undefined/null/garbage returns the merged doc as-is, with no _prov/_ai keys at all", () => {
    const doc = editDoc();
    for (const raw of [undefined, null, "not-an-object", ["ia"]]) {
      const result = attachProvenance(doc, raw);
      expect(result).toEqual(doc);
      expect("_prov" in result).toBe(false);
      expect("_ai" in result).toBe(false);
    }
  });

  it("mixes surviving and dropped keys: only the surviving key's node/field appears in _prov and feeds _ai", () => {
    const doc = editDoc();
    const ag = doc.campaign.adGroups[0];
    const validKey = `${ag.resourceName}:desired.cpcBidMicros`;
    const result = attachProvenance(doc, {
      [validKey]: "ia",
      "ghost-node:field": "ia",
      [`${ag.resourceName}:resourceName`]: "ia", // real node, non-writable field
    });
    expect(result._prov).toEqual({ [validKey]: "ia" });
    expect(result._ai).toEqual([ag.id]);
  });
});
