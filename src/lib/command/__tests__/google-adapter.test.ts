import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { googleAdapter } from "../networks/google";
import type { CcInternalActionType, EntitySnapshot } from "../types";

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

function synthBefore(): EntitySnapshot {
  return { entityKind: "campaign", entityRef: "temp:x", status: "UNKNOWN" };
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

  it("capabilities include the create family + remove_entity", () => {
    const caps = googleAdapter.capabilities(AUTH);
    (["create_budget", "create_campaign", "create_ad_group", "create_keywords", "create_ad", "remove_entity"] as CcInternalActionType[]).forEach((t) =>
      expect(caps.actionTypes).toContain(t));
  });

  it("create_budget → campaignBudgets:mutate create with amountMicros string", async () => {
    responder = () => ({ results: [{ resourceName: "customers/123/campaignBudgets/9" }] });
    const exec = await googleAdapter.execute(AUTH, "123",
      { actionType: "create_budget", entityKind: "campaign", entityRef: "temp:budget:1", payload: { name: "B", amountMicros: 350_000_000 } },
      synthBefore());
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith("campaignBudgets:mutate"))?.init?.body));
    expect(body.operations[0].create.amountMicros).toBe("350000000");
    expect(exec.resourceNames?.[0]).toBe("customers/123/campaignBudgets/9");
  });

  it("create_campaign create is PAUSED + SEARCH + references the resolved budget", async () => {
    responder = (url) => {
      if (url.endsWith("campaigns:mutate")) return { results: [{ resourceName: "customers/123/campaigns/5" }] };
      return { results: [{ resourceName: "customers/123/campaignCriteria/5~1" }] };
    };
    await googleAdapter.execute(AUTH, "123", {
      actionType: "create_campaign", entityKind: "campaign", entityRef: "temp:campaign:2",
      payload: {
        name: "C", status: "PAUSED", channel: "SEARCH", budgetRef: "customers/123/campaignBudgets/9",
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, geoTargetIds: ["MX"], presenceOnly: true,
      },
    }, synthBefore());
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith("campaigns:mutate"))?.init?.body));
    expect(body.operations[0].create.status).toBe("PAUSED");
    expect(body.operations[0].create.advertisingChannelType).toBe("SEARCH");
    expect(body.operations[0].create.campaignBudget).toBe("customers/123/campaignBudgets/9");
  });

  it("create_campaign execute issues a second campaignCriteria:mutate for geo + language", async () => {
    responder = (url) => {
      if (url.endsWith("campaigns:mutate")) return { results: [{ resourceName: "customers/123/campaigns/5" }] };
      if (url.endsWith("campaignCriteria:mutate")) return { results: [{ resourceName: "customers/123/campaignCriteria/5~1" }] };
      return {};
    };
    const exec = await googleAdapter.execute(AUTH, "123", {
      actionType: "create_campaign", entityKind: "campaign", entityRef: "temp:campaign:2",
      payload: {
        name: "C", status: "PAUSED", channel: "SEARCH", budgetRef: "customers/123/campaignBudgets/9",
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, geoTargetIds: ["MX"], presenceOnly: true,
      },
    }, synthBefore());
    const criteriaCall = calls.find((c) => c.url.endsWith("campaignCriteria:mutate"));
    expect(criteriaCall).toBeDefined();
    const body = JSON.parse(String(criteriaCall?.init?.body));
    expect(body.operations[0].create.campaign).toBe("customers/123/campaigns/5");
    expect(body.operations[0].create.location.geoTargetConstant).toBe("geoTargetConstants/2484");
    // campaign resourceName must be index 0 (children resolve tmp: refs against it)
    expect(exec.resourceNames?.[0]).toBe("customers/123/campaigns/5");
    expect(exec.resourceNames).toContain("customers/123/campaignCriteria/5~1");
  });

  it("validate() handles remove_entity (else create-rollback is permanently blocked)", async () => {
    responder = () => ({});
    const res = await googleAdapter.validate!(AUTH, "123",
      { actionType: "remove_entity", entityKind: "campaign", entityRef: "customers/123/campaigns/5", payload: { resourceNames: ["customers/123/campaigns/5"] } },
      synthBefore());
    expect(res.ok).toBe(true);
  });

  it("buildRollback for a create returns remove_entity with the created resourceNames (never null)", () => {
    const r = googleAdapter.buildRollback(
      { actionType: "create_campaign", entityKind: "campaign", entityRef: "temp:campaign:2", payload: {} as never },
      synthBefore(), { operation: "campaigns:mutate", request: {}, response: {}, resourceNames: ["customers/123/campaigns/5"] });
    expect(r?.action.actionType).toBe("remove_entity");
    expect((r?.action.payload as { resourceNames: string[] }).resourceNames).toEqual(["customers/123/campaigns/5"]);
  });
});
