import { describe, it, expect } from "bun:test";
import {
  createBlueprint, getBlueprint, saveBlueprintDoc, compileBlueprintToActions, approveBlueprint, setBlueprintStatus,
  type BlueprintRepoDeps, type CcBlueprintRow,
} from "../blueprint/repo";
import type { CcActionRow } from "../actions-repo";

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
