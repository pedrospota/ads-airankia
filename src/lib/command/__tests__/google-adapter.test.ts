import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { googleAdapter } from "../networks/google";
import type { EntitySnapshot } from "../types";

const AUTH = { googleRefreshToken: "rt-1", googleLoginCustomerId: "9999999999" };
let calls: Array<{ url: string; init?: RequestInit }> = [];
let responder: (url: string, init?: RequestInit) => unknown = () => ({});
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  process.env.GOOGLE_ADS_CLIENT_ID = "cid";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "devtok";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(responder(url, init)), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

function before(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return { entityKind: "campaign", entityRef: "111", status: "ENABLED",
    dailyBudgetMicros: 10_000_000, budgetResourceName: "customers/123/campaignBudgets/77", ...over };
}

describe("googleAdapter", () => {
  it("capabilities: write on when refresh token present", () => {
    expect(googleAdapter.capabilities(AUTH).write).toBe(true);
    expect(googleAdapter.capabilities({}).write).toBe(false);
  });

  it("snapshot parses structure + sums 30d metrics", async () => {
    responder = (url, init) => {
      const q = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
      if (q.includes("segments.date DURING LAST_30_DAYS")) {
        return { results: [
          { metrics: { conversions: 2.5, costMicros: "3000000" } },
          { metrics: { conversions: 1.5, costMicros: "2000000" } },
        ] };
      }
      return { results: [{
        campaign: { id: "111", name: "Marca", status: "ENABLED", campaignBudget: "customers/123/campaignBudgets/77" },
        campaignBudget: { amountMicros: "10000000" },
        customer: { currencyCode: "USD" },
      }] };
    };
    const snap = await googleAdapter.snapshot(AUTH, "123", "campaign", "111");
    expect(snap.status).toBe("ENABLED");
    expect(snap.dailyBudgetMicros).toBe(10_000_000);
    expect(snap.budgetResourceName).toBe("customers/123/campaignBudgets/77");
    expect(snap.conversions30d).toBe(4);
    expect(snap.spend30dMicros).toBe(5_000_000);
    // headers carry developer token + login-customer-id
    const gaqlCall = calls.find(c => c.url.includes("googleAds:search"));
    const h = gaqlCall?.init?.headers as Record<string, string>;
    expect(h["developer-token"]).toBe("devtok");
    expect(h["login-customer-id"]).toBe("9999999999");
  });

  it("validate sends the same mutate body with validateOnly:true", async () => {
    responder = () => ({});
    const res = await googleAdapter.validate!(AUTH, "123",
      { actionType: "budget_update", entityKind: "campaign", entityRef: "111", payload: { newDailyBudgetMicros: 12_000_000 } }, before());
    expect(res.ok).toBe(true);
    const call = calls.find(c => c.url.endsWith("campaignBudgets:mutate"));
    const body = JSON.parse(String(call?.init?.body));
    expect(body.validateOnly).toBe(true);
    expect(body.operations[0].update.amountMicros).toBe("12000000");
    expect(body.operations[0].updateMask).toBe("amountMicros");
  });

  it("execute budget_update mutates without validateOnly and hashes request", async () => {
    responder = () => ({ results: [{ resourceName: "customers/123/campaignBudgets/77" }] });
    const exec = await googleAdapter.execute(AUTH, "123",
      { actionType: "budget_update", entityKind: "campaign", entityRef: "111", payload: { newDailyBudgetMicros: 12_000_000 } }, before());
    expect(exec.operation).toBe("campaignBudgets:mutate");
    const body = JSON.parse(String(calls.find(c => c.url.endsWith("campaignBudgets:mutate"))?.init?.body));
    expect(body.validateOnly).toBeUndefined();
  });

  it("execute pause targets campaigns:mutate with status update", async () => {
    responder = () => ({ results: [{ resourceName: "customers/123/campaigns/111" }] });
    await googleAdapter.execute(AUTH, "123",
      { actionType: "pause", entityKind: "campaign", entityRef: "111", payload: {} }, before());
    const body = JSON.parse(String(calls.find(c => c.url.endsWith("campaigns:mutate"))?.init?.body));
    expect(body.operations[0].update.status).toBe("PAUSED");
    expect(body.operations[0].updateMask).toBe("status");
  });

  it("add_negatives creates negative criteria and captures resourceNames", async () => {
    responder = () => ({ results: [
      { resourceName: "customers/123/campaignCriteria/111~1" },
      { resourceName: "customers/123/campaignCriteria/111~2" },
    ] });
    const exec = await googleAdapter.execute(AUTH, "123",
      { actionType: "add_negatives", entityKind: "campaign", entityRef: "111",
        payload: { negatives: [{ text: "gratis", match: "PHRASE" }, { text: "empleo", match: "BROAD" }] } }, before());
    expect(exec.resourceNames).toHaveLength(2);
    const body = JSON.parse(String(calls.find(c => c.url.endsWith("campaignCriteria:mutate"))?.init?.body));
    expect(body.partialFailure).toBe(true);
    expect(body.operations[0].create.negative).toBe(true);
    expect(body.operations[0].create.keyword).toEqual({ text: "gratis", matchType: "PHRASE" });
  });

  it("buildRollback inverts budget/pause/enable/add_negatives", () => {
    const b = before();
    expect(googleAdapter.buildRollback(
      { actionType: "budget_update", entityKind: "campaign", entityRef: "111", payload: { newDailyBudgetMicros: 12_000_000 } },
      b, { operation: "campaignBudgets:mutate", request: {}, response: {} }
    )?.action.payload).toEqual({ newDailyBudgetMicros: 10_000_000 });
    expect(googleAdapter.buildRollback(
      { actionType: "pause", entityKind: "campaign", entityRef: "111", payload: {} },
      b, { operation: "campaigns:mutate", request: {}, response: {} }
    )?.action.actionType).toBe("enable");
    expect(googleAdapter.buildRollback(
      { actionType: "add_negatives", entityKind: "campaign", entityRef: "111", payload: { negatives: [] } },
      b, { operation: "campaignCriteria:mutate", request: {}, response: {}, resourceNames: ["rn1"] }
    )?.action).toEqual({ actionType: "remove_negatives", entityKind: "campaign", entityRef: "111", payload: { resourceNames: ["rn1"] } });
  });
});
