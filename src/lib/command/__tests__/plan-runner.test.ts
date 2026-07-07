import { describe, it, expect } from "bun:test";
import {
  resolvePayload,
  executeBlueprint,
  rollbackBlueprint,
  type PlanRunnerRepo,
} from "../blueprint/plan-runner";
import type { ExecutorDeps } from "../executor";
import { CC_SETTINGS_DEFAULTS, type EntitySnapshot, type NetworkAdapter, type CcActionInput, type ExecuteResult } from "../types";

describe("resolvePayload (placeholders-only invariant)", () => {
  it("substitutes tmp: refs and touches nothing else", () => {
    const out = resolvePayload({ budgetRef: "tmp:budget:1", name: "C", status: "PAUSED" }, { "budget:1": "customers/1/campaignBudgets/9" });
    expect(out).toEqual({ budgetRef: "customers/1/campaignBudgets/9", name: "C", status: "PAUSED" });
  });
  it("leaves non-tmp values byte-identical", () => {
    const p = { adGroupRef: "tmp:ad_group:3", keywords: [{ text: "kw", match: "PHRASE" }] };
    const out = resolvePayload(p, { "ad_group:3": "customers/1/adGroups/7" });
    expect(out.keywords).toEqual(p.keywords);
  });
  it("throws if a tmp ref is unresolved", () => {
    expect(() => resolvePayload({ budgetRef: "tmp:budget:1" }, {})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// executeBlueprint / rollbackBlueprint sequencing — in-memory fakes mirroring
// executor.test.ts's fakeDeps pattern, plus a fake repo2 (PlanRunnerRepo) backed
// by the SAME in-memory action store (mirrors the real world: both interfaces
// are views over the one cc_actions table).
// ---------------------------------------------------------------------------

function snapshot(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return { entityKind: "campaign", entityRef: "111", status: "UNKNOWN", ...over };
}

const ALL_ACTION_TYPES = [
  "create_budget", "create_campaign", "create_ad_group", "create_keywords", "create_ad", "remove_entity",
];

function fakeAdapter(over: Partial<NetworkAdapter> = {}): NetworkAdapter {
  return {
    network: "google_ads",
    capabilities: () => ({ read: true, write: true, actionTypes: ALL_ACTION_TYPES as never }),
    listCampaigns: async () => [],
    snapshot: async () => snapshot(),
    validate: async () => ({ ok: true }),
    execute: async (_auth, _accountRef, input: CcActionInput): Promise<ExecuteResult> => {
      if (input.actionType === "create_budget") {
        return { operation: "campaignBudgets:mutate", request: {}, response: {}, resourceNames: ["customers/1/campaignBudgets/9"] };
      }
      if (input.actionType === "create_campaign") {
        return { operation: "campaigns:mutate", request: {}, response: {}, resourceNames: ["customers/1/campaigns/5"] };
      }
      return { operation: "x:mutate", request: {}, response: {}, resourceNames: [] };
    },
    buildRollback: () => null,
    ...over,
  };
}

function baseAction(over: Record<string, unknown> = {}) {
  return {
    id: "a1", workspaceId: "w1", createdBy: "op@x.com", network: "google_ads",
    connectionId: null, accountRef: "123", entityKind: "campaign", entityRef: "tmp:budget:1",
    entityName: null, actionType: "create_budget", payload: { name: "Presupuesto", amountMicros: 5_000_000 },
    expected: null, source: "manual", recKey: null, rationale: null, evidence: null,
    status: "approved", approvedBy: "op@x.com", approvedAt: new Date(), executedAt: null,
    gateResults: null, error: null, blueprintId: "bp1", seq: 0, localRef: "budget:1", resultRef: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  };
}

interface HarnessOpts {
  executedToday?: number;
  maxPerDay?: number;
  failActionType?: string;
}

function makeHarness(actions: Array<Record<string, unknown>>, opts: HarnessOpts = {}) {
  const store = new Map<string, Record<string, unknown>>(actions.map((a) => [a.id as string, { ...a }]));
  const log: string[] = [];
  const resolvedCalls: Array<{ id: string; payload: unknown; resultRef?: string }> = [];

  const deps: ExecutorDeps = {
    repo: {
      getAction: async (id) => (store.get(id) ?? null) as never,
      transitionAction: async (row, to, patch) => {
        const cur = store.get(row.id);
        if (cur) Object.assign(cur, patch, { status: to });
        log.push(`transition:${row.id}:${to}`);
      },
      insertExecution: async (v) => ({ id: `e-${v.actionId as string}`, ...v }) as never,
      updateExecution: async () => {},
      countExecutedToday: async () => opts.executedToday ?? 0,
      latestDoneExecution: async (actionId) => {
        const row = store.get(actionId);
        if (!row) return null;
        const rr = (row.resultRef as string | null) ?? "customers/1/x/1";
        return {
          id: `le-${actionId}`, actionId, attempt: 1, network: "google_ads", accountRef: row.accountRef,
          operation: "x", requestHash: "h", validateOnly: false, before: snapshot(), request: {}, response: {},
          after: null,
          rollbackRecipe: {
            action: { actionType: "remove_entity", entityKind: row.entityKind, entityRef: rr, payload: { resourceNames: [rr] } },
            note: "revertir",
          },
          status: "done", actor: "op@x.com", createdAt: new Date(), updatedAt: new Date(),
        } as never;
      },
      createAction: async (v) => ({ ...baseAction(), ...v, id: "new" }) as never,
    },
    adapters: {
      for: () => fakeAdapter(
        opts.failActionType
          ? {
              execute: async (_auth, _accountRef, input: CcActionInput) => {
                if (input.actionType === opts.failActionType) throw new Error(`boom: ${input.actionType}`);
                if (input.actionType === "create_budget") {
                  return { operation: "campaignBudgets:mutate", request: {}, response: {}, resourceNames: ["customers/1/campaignBudgets/9"] };
                }
                if (input.actionType === "create_campaign") {
                  return { operation: "campaigns:mutate", request: {}, response: {}, resourceNames: ["customers/1/campaigns/5"] };
                }
                return { operation: "x:mutate", request: {}, response: {}, resourceNames: [] };
              },
            }
          : {}
      ),
    },
    settings: {
      get: async () => ({
        ...CC_SETTINGS_DEFAULTS,
        maxActionsPerAccountDay: opts.maxPerDay ?? 20,
        allowedActionTypes: ["create_budget", "create_campaign", "create_ad_group", "create_keywords", "create_ad"] as never,
      }),
    },
    auth: { resolve: async () => ({ googleRefreshToken: "rt" }) },
    dryRun: false,
    now: () => new Date("2026-07-07T12:00:00Z"),
  };

  const repo2: PlanRunnerRepo = {
    listActionsByBlueprint: async (blueprintId) =>
      [...store.values()].filter((a) => a.blueprintId === blueprintId) as never,
    updateActionResolved: async (id, payload, resultRef) => {
      resolvedCalls.push({ id, payload, resultRef });
      const cur = store.get(id);
      if (!cur) return;
      if (resultRef === undefined) {
        if (cur.status !== "approved") return; // mirrors the real Drizzle optimistic guard
        cur.payload = payload;
      } else {
        cur.payload = payload;
        cur.resultRef = resultRef;
      }
    },
  };

  return { deps, repo2, store, log, resolvedCalls };
}

describe("executeBlueprint", () => {
  it("happy path: executes per seq in order, threads tmp: refs between actions, stamps result_ref", async () => {
    const budget = baseAction({ id: "a1", seq: 0, localRef: "budget:1", actionType: "create_budget", entityRef: "tmp:budget:1" });
    const campaign = baseAction({
      id: "a2", seq: 1, localRef: "campaign:1", actionType: "create_campaign", entityRef: "tmp:campaign:1",
      payload: {
        name: "C", status: "PAUSED", channel: "SEARCH", budgetRef: "tmp:budget:1",
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, geoTargetIds: ["MX"], presenceOnly: false,
      },
    });
    const { deps, repo2, store, resolvedCalls } = makeHarness([budget, campaign]);

    const out = await executeBlueprint("bp1", "op@x.com", ["w1"], deps, repo2);

    expect(out.ok).toBe(true);
    expect(store.get("a1")?.status).toBe("executed");
    expect(store.get("a2")?.status).toBe("executed");
    expect(store.get("a1")?.resultRef).toBe("customers/1/campaignBudgets/9");
    expect(store.get("a2")?.resultRef).toBe("customers/1/campaigns/5");

    // The pre-execute persist call for the campaign (no resultRef yet) must carry the
    // budgetRef already resolved from action a1's result — proving refMap threading.
    const preExecutePersist = resolvedCalls.find((c) => c.id === "a2" && c.resultRef === undefined);
    expect((preExecutePersist?.payload as { budgetRef?: string } | undefined)?.budgetRef).toBe("customers/1/campaignBudgets/9");
  });

  it("stops on first failure and returns failedSeq; does not continue to later actions", async () => {
    const budget = baseAction({ id: "a1", seq: 0, localRef: "budget:1", actionType: "create_budget", entityRef: "tmp:budget:1" });
    const campaign = baseAction({
      id: "a2", seq: 1, localRef: "campaign:1", actionType: "create_campaign", entityRef: "tmp:campaign:1",
      payload: {
        name: "C", status: "PAUSED", channel: "SEARCH", budgetRef: "tmp:budget:1",
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, geoTargetIds: ["MX"], presenceOnly: false,
      },
    });
    const { deps, repo2, store } = makeHarness([budget, campaign], { failActionType: "create_campaign" });

    const out = await executeBlueprint("bp1", "op@x.com", ["w1"], deps, repo2);

    expect(out.ok).toBe(false);
    expect(out.failedSeq).toBe(1);
    expect(store.get("a1")?.status).toBe("executed");
    expect(store.get("a2")?.status).toBe("failed");
  });

  it("pre-check refuses the whole plan when size + executedToday exceeds the daily cap, before executing anything", async () => {
    const budget = baseAction({ id: "a1", seq: 0, localRef: "budget:1", actionType: "create_budget", entityRef: "tmp:budget:1" });
    const campaign = baseAction({
      id: "a2", seq: 1, localRef: "campaign:1", actionType: "create_campaign", entityRef: "tmp:campaign:1",
      payload: {
        name: "C", status: "PAUSED", channel: "SEARCH", budgetRef: "tmp:budget:1",
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, geoTargetIds: ["MX"], presenceOnly: false,
      },
    });
    const { deps, repo2, store } = makeHarness([budget, campaign], { executedToday: 19, maxPerDay: 20 });

    const out = await executeBlueprint("bp1", "op@x.com", ["w1"], deps, repo2);

    expect(out.ok).toBe(false);
    expect(out.failedSeq).toBe(-1);
    expect(out.error).toContain("cupo diario");
    expect(store.get("a1")?.status).toBe("approved");
    expect(store.get("a2")?.status).toBe("approved");
  });

  it("resume: skips already-executed actions and seeds refMap from their stored result_ref", async () => {
    const budget = baseAction({
      id: "a1", seq: 0, localRef: "budget:1", actionType: "create_budget", entityRef: "tmp:budget:1",
      status: "executed", resultRef: "customers/1/campaignBudgets/42",
    });
    const campaign = baseAction({
      id: "a2", seq: 1, localRef: "campaign:1", actionType: "create_campaign", entityRef: "tmp:campaign:1",
      payload: {
        name: "C", status: "PAUSED", channel: "SEARCH", budgetRef: "tmp:budget:1",
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, geoTargetIds: ["MX"], presenceOnly: false,
      },
    });
    const { deps, repo2, store, log } = makeHarness([budget, campaign]);

    const out = await executeBlueprint("bp1", "op@x.com", ["w1"], deps, repo2);

    expect(out.ok).toBe(true);
    // a1 was never re-transitioned (skipped, not re-executed).
    expect(log.some((l) => l.startsWith("transition:a1:"))).toBe(false);
    // a2's real created resourceName, proving refMap was seeded from a1.result_ref (42), not re-executed (9).
    expect(store.get("a2")?.resultRef).toBe("customers/1/campaigns/5");
    expect(store.get("a2")?.payload).toMatchObject({ budgetRef: "customers/1/campaignBudgets/42" });
  });
});

describe("rollbackBlueprint", () => {
  it("rolls back executed actions in reverse seq order (children before parents)", async () => {
    const budget = baseAction({
      id: "a1", seq: 0, localRef: "budget:1", actionType: "create_budget", entityRef: "tmp:budget:1",
      status: "executed", resultRef: "customers/1/campaignBudgets/9",
    });
    const campaign = baseAction({
      id: "a2", seq: 1, localRef: "campaign:1", actionType: "create_campaign", entityRef: "tmp:campaign:1",
      status: "executed", resultRef: "customers/1/campaigns/5",
      payload: {
        name: "C", status: "PAUSED", channel: "SEARCH", budgetRef: "customers/1/campaignBudgets/9",
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, geoTargetIds: ["MX"], presenceOnly: false,
      },
    });
    const { deps, repo2, log } = makeHarness([budget, campaign]);

    const out = await rollbackBlueprint("bp1", "op@x.com", ["w1"], deps, repo2);

    expect(out.ok).toBe(true);
    const order = log
      .filter((l) => l.endsWith(":rolled_back"))
      .map((l) => l.split(":")[1]);
    expect(order).toEqual(["a2", "a1"]);
  });
});
