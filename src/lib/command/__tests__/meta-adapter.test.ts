import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { metaAdapter, metaAccountRefs } from "../networks/meta";
import type { EntitySnapshot } from "../types";

let calls: Array<{ url: string; init?: RequestInit }> = [];
let responder: (url: string) => unknown = () => ({});
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  process.env.META_SYSTEM_USER_TOKEN = "meta-token";
  process.env.META_AD_ACCOUNT_IDS = "act_1, act_2";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return new Response(JSON.stringify(responder(url)), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.META_SYSTEM_USER_TOKEN;
  delete process.env.META_AD_ACCOUNT_IDS;
  delete process.env.META_APP_SECRET;
});

function before(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return { entityKind: "adset", entityRef: "555", status: "ENABLED", dailyBudgetMicros: 20_000_000, ...over };
}

describe("metaAdapter", () => {
  it("capabilities off without token, on with token (no negatives)", () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    const off = metaAdapter.capabilities({});
    expect(off.write).toBe(false);
    expect(off.reason).toContain("META_SYSTEM_USER_TOKEN");
    process.env.META_SYSTEM_USER_TOKEN = "meta-token";
    const on = metaAdapter.capabilities({});
    expect(on.write).toBe(true);
    expect(on.actionTypes).not.toContain("add_negatives");
  });

  it("metaAccountRefs parses the allowlist", () => {
    expect(metaAccountRefs()).toEqual(["act_1", "act_2"]);
  });

  it("snapshot converts daily_budget cents → micros and maps learning stage", async () => {
    responder = (url) => {
      if (url.includes("/insights")) return { data: [{ spend: "150.25", actions: [{ action_type: "purchase", value: "3" }, { action_type: "lead", value: "2" }] }] };
      return { id: "555", name: "Adset X", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000", learning_stage_info: { status: "LEARNING" } };
    };
    const snap = await metaAdapter.snapshot({}, "act_1", "adset", "555");
    expect(snap.dailyBudgetMicros).toBe(20_000_000); // 2000 cents
    expect(snap.status).toBe("ENABLED");             // ACTIVE → ENABLED
    expect(snap.learningPhase).toBe("LEARNING");
    expect(snap.conversions30d).toBe(5);
    expect(snap.spend30dMicros).toBe(150_250_000);   // 150.25 → micros
  });

  it("execute budget_update posts daily_budget in minor units", async () => {
    responder = () => ({ success: true });
    await metaAdapter.execute({}, "act_1",
      { actionType: "budget_update", entityKind: "adset", entityRef: "555", payload: { newDailyBudgetMicros: 30_000_000 } }, before());
    const call = calls.find(c => c.url.endsWith("/555"));
    const body = String(call?.init?.body);
    expect(body).toContain("daily_budget=3000");
  });

  it("execute pause posts status=PAUSED; enable posts ACTIVE", async () => {
    responder = () => ({ success: true });
    await metaAdapter.execute({}, "act_1", { actionType: "pause", entityKind: "campaign", entityRef: "777", payload: {} }, before());
    expect(String(calls.at(-1)?.init?.body)).toContain("status=PAUSED");
    await metaAdapter.execute({}, "act_1", { actionType: "enable", entityKind: "campaign", entityRef: "777", payload: {} }, before());
    expect(String(calls.at(-1)?.init?.body)).toContain("status=ACTIVE");
  });

  it("adds appsecret_proof to snapshot (GET) calls when META_APP_SECRET is set, omits it when unset", async () => {
    responder = (url) => {
      if (url.includes("/insights")) return { data: [] };
      return { id: "555", name: "Adset X", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000" };
    };
    process.env.META_APP_SECRET = "app-secret";
    await metaAdapter.snapshot({}, "act_1", "adset", "555");
    const entityCall = calls.find((c) => c.url.includes("/555?"));
    expect(entityCall?.url).toMatch(/[?&]appsecret_proof=[0-9a-f]{64}(&|$)/);

    calls = [];
    delete process.env.META_APP_SECRET;
    await metaAdapter.snapshot({}, "act_1", "adset", "555");
    const entityCallNoSecret = calls.find((c) => c.url.includes("/555?"));
    expect(entityCallNoSecret?.url).not.toContain("appsecret_proof");
  });

  it("adds appsecret_proof to execute (POST) calls when META_APP_SECRET is set, omits it when unset", async () => {
    responder = () => ({ success: true });
    process.env.META_APP_SECRET = "app-secret";
    await metaAdapter.execute({}, "act_1",
      { actionType: "pause", entityKind: "campaign", entityRef: "777", payload: {} }, before());
    const call = calls.at(-1);
    expect(call?.url).toMatch(/\/777\?appsecret_proof=[0-9a-f]{64}$/);
    expect(String(call?.init?.body)).toContain("status=PAUSED");

    calls = [];
    delete process.env.META_APP_SECRET;
    await metaAdapter.execute({}, "act_1",
      { actionType: "pause", entityKind: "campaign", entityRef: "777", payload: {} }, before());
    const callNoSecret = calls.at(-1);
    expect(callNoSecret?.url).not.toContain("appsecret_proof");
    expect(callNoSecret?.url.endsWith("/777")).toBe(true);
  });

  it("buildRollback inverts pause/enable/budget", () => {
    expect(metaAdapter.buildRollback(
      { actionType: "pause", entityKind: "campaign", entityRef: "777", payload: {} }, before(),
      { operation: "POST /777", request: {}, response: {} }
    )?.action.actionType).toBe("enable");
    expect(metaAdapter.buildRollback(
      { actionType: "budget_update", entityKind: "adset", entityRef: "555", payload: { newDailyBudgetMicros: 30_000_000 } }, before(),
      { operation: "POST /555", request: {}, response: {} }
    )?.action.payload).toEqual({ newDailyBudgetMicros: 20_000_000 });
  });
});
