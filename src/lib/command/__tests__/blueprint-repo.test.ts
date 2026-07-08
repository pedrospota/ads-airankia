import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBlueprint, getBlueprint, saveBlueprintDoc, compileBlueprintToActions, approveBlueprint, setBlueprintStatus,
  type BlueprintRepoDeps, type CcBlueprintRow,
} from "../blueprint/repo";
import type { CcActionRow } from "../actions-repo";
import { CC_SETTINGS_DEFAULTS } from "../types";

// Edit-doc fixture (Task 5): same shape as edit-schema.test.ts/edit-diff.test.ts's baseDoc(),
// with the campaign's desired.dailyBudgetMicros bumped so it diffs to exactly one
// budget_update action. Kept as raw `unknown` (not run through parseEditDoc here) since
// blueprint.doc is untyped jsonb — compileBlueprintToActions itself is what must parse it.
function editDocWithBudgetChange(loadedAt = new Date().toISOString()) {
  return {
    docType: "google_search_edit_v1", network: "google_ads", accountRef: "123",
    loadedAt,
    campaign: {
      resourceName: "customers/123/campaigns/5", id: "5",
      base: {
        name: "C", status: "ENABLED", dailyBudgetMicros: 350_000_000,
        budgetResourceName: "customers/123/campaignBudgets/9", budgetShared: false, currency: "USD",
      },
      desired: { status: "ENABLED", dailyBudgetMicros: 500_000_000 },
      newNegatives: [],
      adGroups: [{
        resourceName: "customers/123/adGroups/7", id: "7",
        base: { name: "G", status: "ENABLED", cpcBidMicros: null }, desired: { status: "ENABLED", cpcBidMicros: null },
        baseKeywords: [{ text: "kw", match: "PHRASE", negative: false, resourceName: "customers/123/adGroupCriteria/7~1", status: "ENABLED" }],
        newKeywords: [], newAds: [],
        ads: [{
          resourceName: "customers/123/adGroupAds/7~11", unsupported: false,
          base: {
            status: "ENABLED", finalUrl: "https://x.com",
            headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }], descriptions: [{ text: "D1" }, { text: "D2" }],
          },
          replacement: null,
        }],
      }],
    },
  };
}

// Task 4: same shape as editDocWithBudgetChange, plus an ad-group pause (a SECOND,
// unrelated diffEditDoc action, entityRef = the ad group's `id`) so a test can assert `_ai`
// source-stamping is per-row, not blueprint-wide — only the entityRef(s) listed in `_ai` get
// 'copiloto', the other row stays 'manual'. `ai` rides along as the raw `_ai` sibling exactly
// like the edit PUT route's attachProvenance would leave it (compileBlueprintToActions reads
// it off raw jsonb, never through parseEditDoc, which doesn't declare it).
function editDocWithBudgetChangeAndAdGroupPause(ai?: string[], loadedAt = new Date().toISOString()) {
  const doc = editDocWithBudgetChange(loadedAt);
  doc.campaign.adGroups[0].desired.status = "PAUSED";
  return ai ? { ...doc, _ai: ai } : doc;
}

// Same node-graph shape as blueprint-compile.test.ts's fixture (already proven to satisfy
// blueprintDocSchema + compile()): budget → campaign → ad_group → keywords → ad = 5 actions.
function docFixture(ai?: string[]) {
  return {
    network: "google_ads",
    campaign: {
      nodeId: "c1", tempId: "campaign:2", name: "Camp", channel: "SEARCH", status: "PAUSED",
      budget: { nodeId: "b1", tempId: "budget:1", dailyMicros: 350_000_000 },
      bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
      geo: { countryCodes: ["MX"], presenceOnly: true },
      adGroups: [
        {
          nodeId: "g1", tempId: "ad_group:3", name: "AG",
          keywords: [{ text: "kw", match: "PHRASE" }],
          negatives: [{ text: "gratis", match: "PHRASE" }],
          ads: [
            {
              nodeId: "a1", tempId: "ad:4", finalUrl: "https://x.mx/a",
              headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }],
              descriptions: [{ text: "D1" }, { text: "D2" }],
            },
          ],
        },
      ],
    },
    ...(ai ? { _ai: ai } : {}),
  };
}

function baseBlueprint(over: Partial<CcBlueprintRow> = {}): CcBlueprintRow {
  return {
    id: "bp1", workspaceId: "w1", createdBy: "op@x.com", network: "google_ads",
    accountRef: "123", connectionId: null, doc: docFixture(), status: "draft", error: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  } as CcBlueprintRow;
}

// Meta doc fixture (Task 6): same node-graph shape proven valid by meta-compile.test.ts's
// fixtures against metaBlueprintDocSchema + compileMeta(): campaign → adset → ad = 3 actions.
function metaDocFixture(dailyBudgetMicros = 10_000_000) {
  return {
    network: "meta_ads",
    campaign: {
      nodeId: "c1", tempId: "campaign:1", name: "Meta Camp", status: "PAUSED", objective: "OUTCOME_TRAFFIC",
      adsets: [
        {
          nodeId: "as1", tempId: "adset:1", name: "Meta Adset", status: "PAUSED",
          dailyBudgetMicros,
          targeting: { countryCodes: ["MX"], ageMin: 18, ageMax: 65 },
          ads: [
            { nodeId: "ad1", tempId: "ad:1", name: "Ad 1", link: "https://example.com", message: "Check this out!" },
          ],
        },
      ],
    },
  };
}

function baseMetaBlueprint(over: Partial<CcBlueprintRow> = {}): CcBlueprintRow {
  return {
    id: "bp1", workspaceId: "w1", createdBy: "op@x.com", network: "meta_ads",
    accountRef: "act_123", connectionId: null, doc: metaDocFixture(), status: "draft", error: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  } as CcBlueprintRow;
}

function baseAction(over: Record<string, unknown> = {}): CcActionRow {
  return {
    id: "a1", workspaceId: "w1", createdBy: "op@x.com", network: "google_ads",
    connectionId: null, accountRef: "123", entityKind: "campaign", entityRef: "tmp:budget:1",
    entityName: null, actionType: "create_budget", payload: {}, expected: null,
    source: "manual", recKey: null, rationale: null, evidence: null,
    status: "proposed", approvedBy: null, approvedAt: null, executedAt: null,
    gateResults: null, error: null, blueprintId: "bp1", seq: 0, localRef: "budget:1", resultRef: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  } as CcActionRow;
}

/** In-memory fake of BlueprintRepoDeps, backed by two Maps (mirrors plan-runner.test.ts's
 * store pattern) — never touches adsDb. */
function makeHarness(blueprints: CcBlueprintRow[] = [], actions: CcActionRow[] = []) {
  const bpStore = new Map<string, CcBlueprintRow>(blueprints.map((b) => [b.id, { ...b }]));
  const actionStore = new Map<string, CcActionRow>(actions.map((a) => [a.id, { ...a }]));
  // Records each insertActions() call's row count, so tests can assert the compile path
  // does one batched insert instead of one insert per compiled row.
  const insertActionsCalls: number[] = [];
  let nextId = 1;

  const deps: BlueprintRepoDeps = {
    insertBlueprint: async (values) => {
      const row = {
        id: `bp-${nextId++}`, connectionId: null, error: null, status: "draft",
        createdAt: new Date(), updatedAt: new Date(), ...values,
      } as CcBlueprintRow;
      bpStore.set(row.id, row);
      return row;
    },
    selectBlueprint: async (id, workspaceIds) => {
      const row = bpStore.get(id);
      if (!row || !workspaceIds.includes(row.workspaceId)) return null;
      return row;
    },
    updateBlueprintDoc: async (id, doc, workspaceIds) => {
      const row = bpStore.get(id);
      if (!row || !workspaceIds.includes(row.workspaceId) || row.status !== "draft") return null;
      Object.assign(row, { doc, updatedAt: new Date() });
      return row;
    },
    updateBlueprintStatus: async (id, status, workspaceIds, error) => {
      const row = bpStore.get(id);
      if (!row || !workspaceIds.includes(row.workspaceId)) return null;
      Object.assign(row, { status, error, updatedAt: new Date() });
      return row;
    },
    listActionsByBlueprint: async (blueprintId) =>
      [...actionStore.values()].filter((a) => a.blueprintId === blueprintId),
    deleteProposedActionsByBlueprint: async (blueprintId, workspaceId) => {
      for (const [id, a] of actionStore) {
        if (a.blueprintId === blueprintId && a.status === "proposed" && a.workspaceId === workspaceId) {
          actionStore.delete(id);
        }
      }
    },
    insertActions: async (values) => {
      insertActionsCalls.push(values.length);
      const rows = values.map((values_) => ({
        id: `a-${nextId++}`, entityName: null, expected: null, rationale: null, evidence: null,
        approvedBy: null, approvedAt: null, executedAt: null, gateResults: null, error: null, resultRef: null,
        createdAt: new Date(), updatedAt: new Date(), ...values_,
      } as CcActionRow));
      for (const row of rows) actionStore.set(row.id, row);
      return rows;
    },
    approveProposedActions: async (blueprintId, workspaceId, approver, now) => {
      const out: CcActionRow[] = [];
      for (const a of actionStore.values()) {
        if (a.blueprintId === blueprintId && a.status === "proposed" && a.workspaceId === workspaceId) {
          Object.assign(a, { status: "approved", approvedBy: approver, approvedAt: now, updatedAt: now });
          out.push(a);
        }
      }
      return out;
    },
  };

  return { deps, bpStore, actionStore, insertActionsCalls };
}

describe("createBlueprint / getBlueprint / saveBlueprintDoc", () => {
  it("creates a draft, reads it back scoped, and hides it outside the caller's workspaces", async () => {
    const { deps } = makeHarness();
    const created = await createBlueprint(
      { workspaceId: "w1", createdBy: "op@x.com", network: "google_ads", accountRef: "123", doc: docFixture() },
      deps
    );
    expect(created.status).toBe("draft");

    const fetched = await getBlueprint(created.id, ["w1"], deps);
    expect(fetched?.id).toBe(created.id);
    expect(await getBlueprint(created.id, ["other-ws"], deps)).toBeNull();
  });

  it("saveBlueprintDoc updates the doc while draft, and no-ops once the blueprint has moved on", async () => {
    const { deps, bpStore } = makeHarness([baseBlueprint()]);
    const updated = await saveBlueprintDoc("bp1", docFixture(["ad:4"]), ["w1"], deps);
    expect(updated?.doc).toMatchObject({ _ai: ["ad:4"] });

    bpStore.get("bp1")!.status = "approved";
    const blocked = await saveBlueprintDoc("bp1", docFixture(), ["w1"], deps);
    expect(blocked).toBeNull();
  });
});

describe("compileBlueprintToActions", () => {
  it("inserts one action row per compiled action, with blueprintId/seq/localRef/recKey set and source 'manual'", async () => {
    const { deps, actionStore } = makeHarness([baseBlueprint()]);
    const rows = await compileBlueprintToActions("bp1", ["w1"], deps);

    expect(rows.length).toBe(5); // budget, campaign, ad_group, keywords, ad
    expect(rows.every((r) => r.blueprintId === "bp1")).toBe(true);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.every((r) => typeof r.localRef === "string" && r.localRef.length > 0)).toBe(true);
    expect(rows.every((r) => typeof r.recKey === "string" && r.recKey.length > 0)).toBe(true);
    expect(rows.every((r) => r.status === "proposed")).toBe(true);
    expect(rows.every((r) => r.source === "manual")).toBe(true);
    expect(actionStore.size).toBe(5);
  });

  it("marks source 'copiloto' only on the action whose localRef is listed in doc._ai", async () => {
    const { deps } = makeHarness([baseBlueprint({ doc: docFixture(["ad_group:3"]) })]);
    const rows = await compileBlueprintToActions("bp1", ["w1"], deps);

    const adGroupRow = rows.find((r) => r.actionType === "create_ad_group")!;
    expect(adGroupRow.source).toBe("copiloto");
    // The keywords action has a *different* localRef ("ad_group:3:kw") — proves exact
    // localRef matching, not a prefix match.
    const keywordsRow = rows.find((r) => r.actionType === "create_keywords")!;
    expect(keywordsRow.source).toBe("manual");
    expect(rows.filter((r) => r.source === "copiloto")).toHaveLength(1);
  });

  it("replaces a prior still-proposed compile instead of doubling rows", async () => {
    const { deps, actionStore } = makeHarness([baseBlueprint()]);
    await compileBlueprintToActions("bp1", ["w1"], deps);
    expect(actionStore.size).toBe(5);

    const second = await compileBlueprintToActions("bp1", ["w1"], deps);
    expect(second).toHaveLength(5);
    expect(actionStore.size).toBe(5);
  });

  it("refuses to recompile once an action has moved past 'proposed'", async () => {
    const approvedAction = baseAction({ id: "a1", status: "approved" });
    const { deps } = makeHarness([baseBlueprint()], [approvedAction]);
    await expect(compileBlueprintToActions("bp1", ["w1"], deps)).rejects.toThrow();
  });

  it("inserts all compiled rows via a single batched insert call, not one per row", async () => {
    const { deps, insertActionsCalls } = makeHarness([baseBlueprint()]);
    const rows = await compileBlueprintToActions("bp1", ["w1"], deps);

    expect(insertActionsCalls).toEqual([5]); // one call, carrying all 5 rows
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.every((r) => typeof r.localRef === "string" && r.localRef.length > 0)).toBe(true);
  });
});

describe("compileBlueprintToActions — edit-doc branch (Task 5)", () => {
  const WS = "w1";

  it("edit doc compiles via diffEditDoc and rows carry expected + entityName", async () => {
    const { deps } = makeHarness([baseBlueprint({ doc: editDocWithBudgetChange() })]);
    const rows = await compileBlueprintToActions("bp1", [WS], deps);

    expect(rows).toHaveLength(1);
    expect(rows[0].actionType).toBe("budget_update");
    expect(rows[0].expected).toEqual({ dailyBudgetMicros: 350_000_000 });
    expect(rows[0].entityName).toBeTruthy();
    expect(rows[0].recKey?.startsWith("ed-")).toBe(true);
  });

  it("edit doc with a stale baseline (>60 min) refuses to compile", async () => {
    const staleLoadedAt = new Date(Date.now() - 61 * 60_000).toISOString();
    const { deps } = makeHarness([baseBlueprint({ doc: editDocWithBudgetChange(staleLoadedAt) })]);

    await expect(compileBlueprintToActions("bp1", [WS], deps)).rejects.toThrow(/caducado/);
  });

  it("create docs still compile through the v2 path (branch mis-detection guard)", async () => {
    const { deps } = makeHarness([baseBlueprint({ doc: docFixture() })]);
    const rows = await compileBlueprintToActions("bp1", [WS], deps);

    expect(rows[0].recKey?.startsWith("bp-")).toBe(true); // create compiler, not the edit one
  });
});

describe("compileBlueprintToActions — edit-doc _ai source stamping (Task 4)", () => {
  const WS = "w1";

  it("an edit doc whose raw _ai lists the campaign id stamps ONLY the budget row 'copiloto'; the unrelated ad-group pause row stays 'manual'", async () => {
    const doc = editDocWithBudgetChangeAndAdGroupPause(["5"]); // campaign.id === "5"
    const { deps } = makeHarness([baseBlueprint({ doc })]);
    const rows = await compileBlueprintToActions("bp1", [WS], deps);

    expect(rows).toHaveLength(2);
    const budgetRow = rows.find((r) => r.actionType === "budget_update")!;
    expect(budgetRow.entityRef).toBe("5");
    expect(budgetRow.source).toBe("copiloto");

    const pauseRow = rows.find((r) => r.actionType === "pause")!;
    expect(pauseRow.entityRef).toBe("7"); // the ad group's id, not "5" — exact match, not blueprint-wide
    expect(pauseRow.source).toBe("manual");
  });

  it("an edit doc with no _ai sibling compiles every row 'manual' (regression: absence never accidentally stamps 'copiloto')", async () => {
    const doc = editDocWithBudgetChangeAndAdGroupPause();
    const { deps } = makeHarness([baseBlueprint({ doc })]);
    const rows = await compileBlueprintToActions("bp1", [WS], deps);

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === "manual")).toBe(true);
  });

  it("an _ai entry that matches no compiled row's entityRef stamps nothing 'copiloto' (stale/foreign marker, fails closed)", async () => {
    const doc = editDocWithBudgetChangeAndAdGroupPause(["does-not-match-anything"]);
    const { deps } = makeHarness([baseBlueprint({ doc })]);
    const rows = await compileBlueprintToActions("bp1", [WS], deps);

    expect(rows.every((r) => r.source === "manual")).toBe(true);
  });
});

describe("compileBlueprintToActions — meta network branch (Task 6)", () => {
  const WS = "w1";

  it("a meta blueprint compiles via compileMeta: 3 rows in order, recKey 'bp-', connectionId null, source manual", async () => {
    const { deps, actionStore } = makeHarness([baseMetaBlueprint()]);
    const rows = await compileBlueprintToActions("bp1", [WS], deps);

    expect(rows.map((r) => r.actionType)).toEqual(["create_campaign", "create_adset", "create_ad"]);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(rows.every((r) => r.blueprintId === "bp1")).toBe(true);
    expect(rows.every((r) => typeof r.recKey === "string" && r.recKey!.startsWith("bp-"))).toBe(true);
    expect(rows.every((r) => r.connectionId === null)).toBe(true);
    expect(rows.every((r) => r.source === "manual")).toBe(true);
    expect(rows.every((r) => r.status === "proposed")).toBe(true);
    expect(actionStore.size).toBe(3);
  });

  it("three-way dispatch: a google create doc still compiles via the google path", async () => {
    const { deps } = makeHarness([baseBlueprint()]);
    const rows = await compileBlueprintToActions("bp1", [WS], deps);

    expect(rows).toHaveLength(5); // budget, campaign, ad_group, keywords, ad
    expect(rows.map((r) => r.actionType)).toEqual([
      "create_budget", "create_campaign", "create_ad_group", "create_keywords", "create_ad",
    ]);
  });

  it("three-way dispatch: an edit doc still routes to the differ, not the meta or google compiler", async () => {
    const { deps } = makeHarness([baseBlueprint({ doc: editDocWithBudgetChange() })]);
    const rows = await compileBlueprintToActions("bp1", [WS], deps);

    expect(rows).toHaveLength(1);
    expect(rows[0].actionType).toBe("budget_update");
    expect(rows[0].recKey?.startsWith("ed-")).toBe(true);
  });
});

describe("approveBlueprint", () => {
  it("bulk-transitions all proposed actions to approved (stamped) and sets the blueprint to approved", async () => {
    const { deps, actionStore } = makeHarness([baseBlueprint()]);
    await compileBlueprintToActions("bp1", ["w1"], deps);

    const updated = await approveBlueprint("bp1", "approver@x.com", ["w1"], deps);

    expect(updated?.status).toBe("approved");
    expect(actionStore.size).toBe(5);
    for (const a of actionStore.values()) {
      expect(a.status).toBe("approved");
      expect(a.approvedBy).toBe("approver@x.com");
      expect(a.approvedAt).toBeInstanceOf(Date);
    }
  });

  it("returns null outside the caller's workspaces and touches nothing", async () => {
    const { deps, actionStore } = makeHarness([baseBlueprint()]);
    await compileBlueprintToActions("bp1", ["w1"], deps);

    const out = await approveBlueprint("bp1", "approver@x.com", ["other-ws"], deps);
    expect(out).toBeNull();
    for (const a of actionStore.values()) expect(a.status).toBe("proposed");
  });
});

describe("setBlueprintStatus", () => {
  it("moves the blueprint through executing/executed/failed, workspace-scoped", async () => {
    const { deps, bpStore } = makeHarness([baseBlueprint({ status: "approved" })]);

    await setBlueprintStatus("bp1", "executing", ["w1"], undefined, deps);
    expect(bpStore.get("bp1")?.status).toBe("executing");

    const failed = await setBlueprintStatus("bp1", "failed", ["w1"], "boom", deps);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");

    // A subsequent successful transition clears the stale error.
    const executed = await setBlueprintStatus("bp1", "executed", ["w1"], undefined, deps);
    expect(executed?.status).toBe("executed");
    expect(executed?.error).toBeNull();
  });

  it("returns null and changes nothing outside the caller's workspaces", async () => {
    const { deps, bpStore } = makeHarness([baseBlueprint({ status: "approved" })]);
    const out = await setBlueprintStatus("bp1", "executing", ["other-ws"], undefined, deps);
    expect(out).toBeNull();
    expect(bpStore.get("bp1")?.status).toBe("approved");
  });
});

// Meta-EDIT doc fixture (meta-edit plan Task 4): same shape as
// meta-edit-schema.test.ts's baseDoc(), with one adset budget bump + one ad
// pause so it diffs to exactly two rows. Raw `unknown` on purpose —
// compileBlueprintToActions itself must parse it.
function metaEditDocWithChanges(loadedAt = new Date().toISOString()) {
  return {
    docType: "meta_edit_v1", network: "meta_ads", accountRef: "act_123",
    loadedAt,
    campaign: {
      id: "111",
      base: { name: "C", status: "ENABLED", effectiveStatus: "ACTIVE",
              dailyBudgetMicros: null, lifetimeBudgetMicros: null, currency: "MXN" },
      desired: { status: "ENABLED", dailyBudgetMicros: null },
      adsets: [{
        id: "222",
        base: { name: "AS", status: "ENABLED", effectiveStatus: "ACTIVE",
                dailyBudgetMicros: 20_000_000, lifetimeBudgetMicros: null, learningPhase: "STABLE" },
        desired: { status: "ENABLED", dailyBudgetMicros: 24_000_000 },
        ads: [{ id: "333", base: { name: "Ad 1", status: "ENABLED", effectiveStatus: "ACTIVE" }, desired: { status: "PAUSED" } }],
      }],
    },
  };
}

function baseMetaEditBlueprint(over: Partial<CcBlueprintRow> = {}): CcBlueprintRow {
  return baseMetaBlueprint({ doc: metaEditDocWithChanges(), ...over });
}

describe("compileBlueprintToActions — meta-edit docType branch", () => {
  const WS = "w1";

  it("meta-edit doc compiles via diffMetaEditDoc: 'me-' recKeys, connectionId null, source manual, expected + rationale set", async () => {
    const { deps } = makeHarness([baseMetaEditBlueprint()]);
    const rows = await compileBlueprintToActions("bp1", [WS], deps);

    expect(rows.map((r) => r.actionType)).toEqual(["pause", "budget_update"]); // A before B
    expect(rows.every((r) => r.recKey?.startsWith("me-"))).toBe(true);
    expect(rows.every((r) => r.connectionId === null)).toBe(true);
    expect(rows.every((r) => r.source === "manual")).toBe(true);
    expect(rows.every((r) => r.status === "proposed")).toBe(true);
    const budget = rows.find((r) => r.actionType === "budget_update")!;
    expect(budget.entityRef).toBe("222");
    expect(budget.expected).toEqual({ dailyBudgetMicros: 20_000_000 });
    expect(budget.rationale).toContain("«AS»");
  });

  it("risk #1 regression: four-way dispatch is unchanged — google edit 'ed-', meta CREATE 'bp-', google create 'bp-'", async () => {
    const gEdit = makeHarness([baseBlueprint({ doc: editDocWithBudgetChange() })]);
    expect((await compileBlueprintToActions("bp1", [WS], gEdit.deps))[0].recKey?.startsWith("ed-")).toBe(true);

    const mCreate = makeHarness([baseMetaBlueprint()]);
    const mRows = await compileBlueprintToActions("bp1", [WS], mCreate.deps);
    expect(mRows.map((r) => r.actionType)).toEqual(["create_campaign", "create_adset", "create_ad"]);
    expect(mRows.every((r) => r.recKey?.startsWith("bp-"))).toBe(true);

    const gCreate = makeHarness([baseBlueprint()]);
    expect(await compileBlueprintToActions("bp1", [WS], gCreate.deps)).toHaveLength(5);
  });

  it("risk #9: stale meta-edit baseline (>60 min) refuses BEFORE deleting existing proposed actions", async () => {
    const staleLoadedAt = new Date(Date.now() - 61 * 60_000).toISOString();
    const existing = baseAction({ id: "a1", blueprintId: "bp1", status: "proposed" });
    const { deps, actionStore } = makeHarness(
      [baseMetaEditBlueprint({ doc: metaEditDocWithChanges(staleLoadedAt) })], [existing]
    );

    await expect(compileBlueprintToActions("bp1", [WS], deps)).rejects.toThrow(/caducado/);
    expect(actionStore.size).toBe(1); // the doomed recompile wiped nothing
  });

  it("meta-edit doc with zero diffs throws 'No hay cambios que aplicar.'", async () => {
    const doc = metaEditDocWithChanges();
    doc.campaign.adsets[0].desired.dailyBudgetMicros = 20_000_000; // back to base
    doc.campaign.adsets[0].ads[0].desired.status = "ENABLED";
    const { deps } = makeHarness([baseMetaEditBlueprint({ doc })]);
    await expect(compileBlueprintToActions("bp1", [WS], deps)).rejects.toThrow(/No hay cambios/);
  });
});

describe("zero-migration guard (meta-edit risk #11)", () => {
  // Meta edit ships with ZERO migrations because budget_update|pause|enable are
  // already in every cc_settings default. These assertions turn that assumption
  // into a tripwire: if a future migration/default change drops one of the three
  // verbs, meta edit silently bricks at ACTION_ALLOWED — fail here instead.
  const VERBS = ["budget_update", "pause", "enable"] as const;

  it("CC_SETTINGS_DEFAULTS (types.ts, mirrored by schema.ts's Drizzle default) allows the three meta-edit verbs", () => {
    for (const v of VERBS) expect(CC_SETTINGS_DEFAULTS.allowedActionTypes).toContain(v);
  });

  it("the migrate route's 007 CREATE TABLE default and 010 cumulative default both carry the three verbs", () => {
    const src = readFileSync(join(import.meta.dir, "../../../app/api/migrate/route.ts"), "utf8");
    const defaults = src.match(/\["budget_update","pause","enable"[^\]]*\]/g) ?? [];
    // 007 CREATE TABLE default, 008 UPDATE+DEFAULT, 009 DEFAULT, 010 UPDATE(partial)+DEFAULT.
    expect(defaults.length).toBeGreaterThanOrEqual(4);
    for (const d of defaults) for (const v of VERBS) expect(d).toContain(`"${v}"`);
  });
});
