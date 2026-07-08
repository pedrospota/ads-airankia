import { describe, it, expect } from "bun:test";
import { executeAction, rollbackAction, type ExecutorDeps } from "../executor";
import { CC_SETTINGS_DEFAULTS, type EntitySnapshot, type NetworkAdapter, type CcInternalActionType, type CcSettingsValues } from "../types";

function snapshot(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return { entityKind: "campaign", entityRef: "111", status: "ENABLED",
    dailyBudgetMicros: 10_000_000, budgetResourceName: "customers/1/campaignBudgets/7",
    learningPhase: "STABLE", conversions30d: 5, spend30dMicros: 1_000_000, ...over };
}

function fakeAdapter(over: Partial<NetworkAdapter> = {}): NetworkAdapter {
  return {
    network: "google_ads",
    capabilities: () => ({ read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives"] }),
    listCampaigns: async () => [],
    snapshot: async () => snapshot(),
    validate: async () => ({ ok: true }),
    execute: async () => ({ operation: "campaigns:mutate", request: { a: 1 }, response: { ok: true }, resourceNames: [] }),
    buildRollback: () => ({ action: { actionType: "enable", entityKind: "campaign", entityRef: "111", payload: {} }, note: "reactivar" }),
    ...over,
  };
}

function baseAction(over: Record<string, unknown> = {}) {
  return {
    id: "a1", workspaceId: "w1", createdBy: "op@x.com", network: "google_ads",
    connectionId: "c1", accountRef: "123", entityKind: "campaign", entityRef: "111",
    entityName: "Marca", actionType: "pause", payload: {}, expected: null,
    source: "manual", recKey: null, rationale: null, evidence: null,
    status: "approved", approvedBy: "op@x.com", approvedAt: new Date(), executedAt: null,
    gateResults: null, error: null, createdAt: new Date(), updatedAt: new Date(), ...over,
  };
}

function fakeDeps(over: Partial<ExecutorDeps> = {}): ExecutorDeps & { log: string[]; transitions: Array<[string, unknown]> } {
  const log: string[] = [];
  const transitions: Array<[string, unknown]> = [];
  const action = baseAction();
  const deps: ExecutorDeps & { log: string[]; transitions: Array<[string, unknown]> } = {
    log, transitions,
    repo: {
      getAction: async () => action as never,
      transitionAction: async (_row, to, patch) => { log.push(`transition:${to}`); transitions.push([to, patch]); },
      insertExecution: async (v) => { log.push(`insertExec:${v.status}:${v.validateOnly ? "dry" : "real"}`); return { id: "e1", ...v } as never; },
      updateExecution: async (_id, patch) => { log.push(`updateExec:${patch.status}`); },
      countExecutedToday: async () => 0,
      latestDoneExecution: async () => ({
        id: "e1", actionId: "a1", attempt: 1, network: "google_ads", accountRef: "123",
        operation: "campaigns:mutate", requestHash: "h", validateOnly: false,
        before: snapshot(), request: {}, response: {}, after: null,
        rollbackRecipe: { action: { actionType: "enable", entityKind: "campaign", entityRef: "111", payload: {} }, note: "reactivar" },
        status: "done", actor: "op@x.com", createdAt: new Date(), updatedAt: new Date(),
      }) as never,
      createAction: async (v) => ({ ...baseAction(), ...v, id: "a2" }) as never,
    },
    adapters: { for: () => fakeAdapter() },
    settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS }) },
    auth: { resolve: async () => ({ googleRefreshToken: "rt" }) },
    dryRun: false,
    now: () => new Date("2026-07-07T12:00:00Z"),
    ...over,
  };
  return deps;
}

describe("executeAction", () => {
  it("happy path: gates pass → executing → ledger pending → done → executed", async () => {
    const deps = fakeDeps();
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(true);
    expect(deps.log).toEqual([
      "transition:executing",
      "insertExec:pending:real",
      "updateExec:done",
      "transition:executed",
    ]);
  });

  it("blocked by gate: keeps approved, persists gate results, no ledger write", async () => {
    const deps = fakeDeps({ settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS, executionsPaused: true }) } });
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(false);
    expect(out.blocked?.some(g => g.id === "KILL_SWITCH")).toBe(true);
    expect(deps.log.some(l => l.startsWith("insertExec"))).toBe(false);
    expect(deps.log).not.toContain("transition:executing");
    // Positively confirm the whole point of the approved-self-loop: gate_results IS
    // persisted (self-transition fires) with the gates as its payload.
    expect(deps.log).toContain("transition:approved");
    const approvedPatch = deps.transitions.find(([to]) => to === "approved")?.[1] as { gateResults?: unknown } | undefined;
    expect(Array.isArray(approvedPatch?.gateResults)).toBe(true);
  });

  it("safety net: a throw in the mutation window (pre-network) fails the action, never strands it in executing", async () => {
    const deps = fakeDeps();
    deps.repo.insertExecution = async () => { throw new Error("ledger DB blip"); };
    let out: Awaited<ReturnType<typeof executeAction>> | undefined;
    // Must NOT throw out of executeAction (that would leave the action stuck in 'executing').
    await expect((async () => { out = await executeAction("a1", "op@x.com", ["w1"], deps); })()).resolves.toBeUndefined();
    expect(out!.ok).toBe(false);
    expect(out!.error).toContain("blip");
    // Transitioned to executing, then force-failed out of limbo (not left hanging).
    expect(deps.log).toContain("transition:executing");
    expect(deps.log).toContain("transition:failed");
  });

  it("CC_DRY_RUN: records validate-only ledger row, action stays approved", async () => {
    const deps = fakeDeps({ dryRun: true });
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(deps.log).toEqual(["insertExec:done:dry"]);
  });

  it("network failure → ledger failed + action failed with error", async () => {
    const deps = fakeDeps({
      adapters: { for: () => fakeAdapter({ execute: async () => { throw new Error("boom 500"); } }) },
    });
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(false);
    expect(deps.log).toEqual([
      "transition:executing",
      "insertExec:pending:real",
      "updateExec:failed",
      "transition:failed",
    ]);
  });

  it("refuses non-approved status", async () => {
    const deps = fakeDeps();
    deps.repo.getAction = async () => baseAction({ status: "proposed" }) as never;
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("aprobada");
  });

  it("rejects a non-create action whose entityRef still carries a tmp: placeholder (BUG 1a regression)", async () => {
    // compile.ts (the real blueprint compiler) stamps refs as `tmp:<localRef>` —
    // four chars, no "e". The executor's guard must match that prefix, or it's
    // inert against every real ref that could reach a non-create action.
    const deps = fakeDeps();
    deps.repo.getAction = async () => baseAction({ actionType: "pause", entityRef: "tmp:campaign:2" }) as never;
    await expect(executeAction("a1", "op@x.com", ["w1"], deps)).rejects.toThrow(
      "Ref temporal en acción no-create: pause tmp:campaign:2"
    );
  });

  it("create actions use a synthetic before (no snapshot call) and still gate", async () => {
    const deps = fakeDeps();
    deps.repo.getAction = async () => baseAction({ status: "approved", actionType: "create_budget", entityRef: "temp:budget:1", payload: { name: "b", amountMicros: 5_000_000 } }) as never;
    let snapCalled = false;
    deps.adapters = { for: () => fakeAdapter({
      capabilities: () => ({ read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives", "create_budget"] }),
      snapshot: async () => { snapCalled = true; throw new Error("should not snapshot a temp entity"); }
    }) };
    deps.settings = { get: async () => ({ ...CC_SETTINGS_DEFAULTS, allowedActionTypes: ["create_budget"] as CcInternalActionType[] } as CcSettingsValues) };
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(snapCalled).toBe(false);
    expect(out.ok).toBe(true);
  });

  it("create_adset (Meta) uses a synthetic before (no snapshot call) and still gate", async () => {
    const deps = fakeDeps();
    deps.repo.getAction = async () => baseAction({
      status: "approved", network: "meta_ads", actionType: "create_adset",
      entityKind: "adset", entityRef: "tmp:as:1",
      payload: {
        name: "as", status: "PAUSED", campaignRef: "tmp:c:1", dailyBudgetMicros: 35_000_000,
        optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", bidStrategy: "LOWEST_COST_WITHOUT_CAP",
        targeting: { countryCodes: ["MX"], ageMin: 18, ageMax: 65 },
      },
    }) as never;
    let snapCalled = false;
    deps.adapters = { for: () => fakeAdapter({
      network: "meta_ads",
      capabilities: () => ({ read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives", "create_adset"] }),
      snapshot: async () => { snapCalled = true; throw new Error("should not snapshot a temp entity"); }
    }) };
    deps.settings = { get: async () => ({ ...CC_SETTINGS_DEFAULTS, allowedActionTypes: ["create_adset"] as CcInternalActionType[] } as CcSettingsValues) };
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(snapCalled).toBe(false);
    expect(out.ok).toBe(true);
  });

  it("remove_entity (create-rollback) uses a synthetic before, never snapshot() on the live resourceName", async () => {
    // remove_entity's entityRef is a full resourceName (customers/x/campaigns/y),
    // not a numeric id — snapshot() expects a numeric id and would throw.
    const deps = fakeDeps();
    deps.repo.getAction = async () =>
      baseAction({
        status: "approved", actionType: "remove_entity",
        entityRef: "customers/123/campaigns/5",
        payload: { resourceNames: ["customers/123/campaigns/5"] },
      }) as never;
    let snapCalled = false;
    deps.adapters = {
      for: () => fakeAdapter({
        capabilities: () => ({ read: true, write: true, actionTypes: ["remove_entity"] }),
        snapshot: async () => { snapCalled = true; throw new Error("should not snapshot a live resourceName as if it were numeric"); },
      }),
    };
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(snapCalled).toBe(false);
    expect(out.ok).toBe(true);
  });
});

describe("rollbackAction", () => {
  it("executes inverse recipe and marks rolled_back", async () => {
    const deps = fakeDeps();
    deps.repo.getAction = async () => baseAction({ status: "executed" }) as never;
    const out = await rollbackAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(true);
    expect(deps.log).toContain("transition:rolled_back");
    expect(deps.log.filter(l => l.startsWith("insertExec"))).toHaveLength(1);
  });

  it("PROMOTION-SAFETY PIN (v2.7 risk #1): rollback of an executed add_negatives action (recipe = remove_negatives) EXECUTES even when remove_negatives is NOT in settings.allowedActionTypes", async () => {
    // remove_negatives was promoted out of INTERNAL_ACTION_TYPES in v2.7 — it now
    // faces ACTION_ALLOWED like any user verb. But its use as the internal
    // rollback-of-add_negatives must keep working regardless of the operator's
    // allow-list, because rollbackAction's hard-blocker filter (executor.ts)
    // excludes ACTION_ALLOWED. This pins that coupling: if the filter list ever
    // grows to include ACTION_ALLOWED, this test fails loudly.
    const deps = fakeDeps({
      settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS, allowedActionTypes: ["budget_update", "pause", "enable"] as CcSettingsValues["allowedActionTypes"] }) },
    });
    deps.repo.getAction = async () =>
      baseAction({ status: "executed", actionType: "add_negatives", entityKind: "campaign", payload: { negatives: [{ text: "gratis", match: "PHRASE" }] } }) as never;
    deps.repo.latestDoneExecution = async () => ({
      id: "e1", actionId: "a1", attempt: 1, network: "google_ads", accountRef: "123",
      operation: "campaignCriteria:mutate", requestHash: "h", validateOnly: false,
      before: snapshot(), request: {}, response: {}, after: null,
      rollbackRecipe: {
        action: { actionType: "remove_negatives", entityKind: "campaign", entityRef: "111", payload: { resourceNames: ["customers/123/campaignCriteria/111~9"] } },
        note: "Eliminar 1 negativa creada.",
      },
      status: "done", actor: "op@x.com", createdAt: new Date(), updatedAt: new Date(),
    }) as never;
    // Sanity: the fake adapter's capability list DOES include remove_negatives
    // (CAPABILITY is a hard blocker and must legitimately pass), but settings
    // above deliberately excludes it — that's the gap this test proves is safe.
    const out = await rollbackAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(true);
    expect(deps.log).toContain("transition:rolled_back");
  });
});
