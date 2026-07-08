import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { googleAdapter, readCampaignTree } from "../networks/google";
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

  it("v2.7: capabilities include update_keyword_status + update_cpc", () => {
    const caps = googleAdapter.capabilities(AUTH);
    expect(caps.actionTypes).toContain("update_keyword_status");
    expect(caps.actionTypes).toContain("update_cpc");
  });

  describe("v2.7 update_keyword_status", () => {
    it("execute → adGroupCriteria:mutate with one status-updateMask op per keyword", async () => {
      responder = () => ({ results: [
        { resourceName: "customers/123/adGroupCriteria/10~1" },
        { resourceName: "customers/123/adGroupCriteria/10~2" },
      ] });
      const exec = await googleAdapter.execute(AUTH, "123", {
        actionType: "update_keyword_status", entityKind: "ad_group", entityRef: "10",
        payload: { status: "PAUSED", keywords: [
          { resourceName: "customers/123/adGroupCriteria/10~1", text: "zapatos" },
          { resourceName: "customers/123/adGroupCriteria/10~2", text: "botas" },
        ] },
      }, before());
      expect(exec.operation).toBe("adGroupCriteria:mutate");
      const body = JSON.parse(String(calls.find((c) => c.url.endsWith("adGroupCriteria:mutate"))?.init?.body));
      expect(body.operations).toHaveLength(2);
      expect(body.operations[0]).toEqual({ updateMask: "status", update: { resourceName: "customers/123/adGroupCriteria/10~1", status: "PAUSED" } });
      expect(body.operations[1]).toEqual({ updateMask: "status", update: { resourceName: "customers/123/adGroupCriteria/10~2", status: "PAUSED" } });
    });

    it("execute status:ENABLED (reactivate) sets status ENABLED on every op", async () => {
      responder = () => ({ results: [{ resourceName: "customers/123/adGroupCriteria/10~1" }] });
      await googleAdapter.execute(AUTH, "123", {
        actionType: "update_keyword_status", entityKind: "ad_group", entityRef: "10",
        payload: { status: "ENABLED", keywords: [{ resourceName: "customers/123/adGroupCriteria/10~1", text: "zapatos" }] },
      }, before());
      const body = JSON.parse(String(calls.find((c) => c.url.endsWith("adGroupCriteria:mutate"))?.init?.body));
      expect(body.operations[0].update.status).toBe("ENABLED");
    });

    it("fail-closed resourceName guard: throws when a resourceName is missing /adGroupCriteria/", async () => {
      await expect(googleAdapter.execute(AUTH, "123", {
        actionType: "update_keyword_status", entityKind: "ad_group", entityRef: "10",
        payload: { status: "PAUSED", keywords: [{ resourceName: "customers/123/campaignCriteria/10~1", text: "x" }] },
      }, before())).rejects.toThrow();
    });

    it("fail-closed resourceName guard: throws on a wrong-account resourceName", async () => {
      await expect(googleAdapter.execute(AUTH, "123", {
        actionType: "update_keyword_status", entityKind: "ad_group", entityRef: "10",
        payload: { status: "PAUSED", keywords: [{ resourceName: "customers/999/adGroupCriteria/10~1", text: "x" }] },
      }, before())).rejects.toThrow();
    });

    it("fail-closed resourceName guard: a single bad ref among good ones still throws (no partial mutate)", async () => {
      await expect(googleAdapter.execute(AUTH, "123", {
        actionType: "update_keyword_status", entityKind: "ad_group", entityRef: "10",
        payload: { status: "PAUSED", keywords: [
          { resourceName: "customers/123/adGroupCriteria/10~1", text: "ok" },
          { resourceName: "customers/123/campaignCriteria/10~2", text: "bad" },
        ] },
      }, before())).rejects.toThrow();
    });

    it("validate() rehearses update_keyword_status with validateOnly:true", async () => {
      responder = () => ({});
      const res = await googleAdapter.validate!(AUTH, "123", {
        actionType: "update_keyword_status", entityKind: "ad_group", entityRef: "10",
        payload: { status: "PAUSED", keywords: [{ resourceName: "customers/123/adGroupCriteria/10~1", text: "x" }] },
      }, before());
      expect(res.ok).toBe(true);
      const body = JSON.parse(String(calls.find((c) => c.url.endsWith("adGroupCriteria:mutate"))?.init?.body));
      expect(body.validateOnly).toBe(true);
    });
  });

  describe("v2.7 update_cpc", () => {
    it("execute → adGroups:mutate with a cpcBidMicros-updateMask op, value stringified", async () => {
      responder = () => ({ results: [{ resourceName: "customers/123/adGroups/10" }] });
      const exec = await googleAdapter.execute(AUTH, "123", {
        actionType: "update_cpc", entityKind: "ad_group", entityRef: "10", payload: { newCpcBidMicros: 650_000 },
      }, before());
      expect(exec.operation).toBe("adGroups:mutate");
      const body = JSON.parse(String(calls.find((c) => c.url.endsWith("adGroups:mutate"))?.init?.body));
      expect(body.operations[0]).toEqual({ updateMask: "cpcBidMicros", update: { resourceName: "customers/123/adGroups/10", cpcBidMicros: "650000" } });
    });

    it("validate() rehearses update_cpc with validateOnly:true", async () => {
      responder = () => ({});
      const res = await googleAdapter.validate!(AUTH, "123", {
        actionType: "update_cpc", entityKind: "ad_group", entityRef: "10", payload: { newCpcBidMicros: 650_000 },
      }, before());
      expect(res.ok).toBe(true);
      const body = JSON.parse(String(calls.find((c) => c.url.endsWith("adGroups:mutate"))?.init?.body));
      expect(body.validateOnly).toBe(true);
    });
  });

  describe("v2.7 snapshot(ad_group) cpcBidMicros", () => {
    it("SELECT includes ad_group.cpc_bid_micros and maps a present value to a number", async () => {
      responder = (url, init) => {
        const q = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
        expect(q).toContain("ad_group.cpc_bid_micros");
        return { results: [{ adGroup: { id: "10", name: "AG", status: "ENABLED", cpcBidMicros: "500000" } }] };
      };
      const snap = await googleAdapter.snapshot(AUTH, "123", "ad_group", "10");
      expect(snap.cpcBidMicros).toBe(500_000);
    });

    it("maps an absent cpcBidMicros (smart-bidding ad group) to null, not 0/undefined", async () => {
      responder = () => ({ results: [{ adGroup: { id: "10", name: "AG", status: "ENABLED" } }] });
      const snap = await googleAdapter.snapshot(AUTH, "123", "ad_group", "10");
      expect(snap.cpcBidMicros).toBeNull();
    });
  });

  describe("v2.7 buildRollback — update_keyword_status / update_cpc / remove_negatives", () => {
    it("update_keyword_status → same verb, inverted status, same keywords (payload self-sufficient)", () => {
      const keywords = [{ resourceName: "customers/123/adGroupCriteria/10~1", text: "zapatos" }];
      const r = googleAdapter.buildRollback(
        { actionType: "update_keyword_status", entityKind: "ad_group", entityRef: "10", payload: { status: "PAUSED", keywords } },
        before(), { operation: "adGroupCriteria:mutate", request: {}, response: {} }
      );
      expect(r?.action).toEqual({ actionType: "update_keyword_status", entityKind: "ad_group", entityRef: "10", payload: { status: "ENABLED", keywords } });
    });

    it("update_keyword_status(ENABLED) rollback inverts to PAUSED", () => {
      const keywords = [{ resourceName: "customers/123/adGroupCriteria/10~1", text: "zapatos" }];
      const r = googleAdapter.buildRollback(
        { actionType: "update_keyword_status", entityKind: "ad_group", entityRef: "10", payload: { status: "ENABLED", keywords } },
        before(), { operation: "adGroupCriteria:mutate", request: {}, response: {} }
      );
      expect((r?.action.payload as { status: string }).status).toBe("PAUSED");
    });

    it("update_cpc → update_cpc(before.cpcBidMicros) when a manual CPC baseline exists", () => {
      const r = googleAdapter.buildRollback(
        { actionType: "update_cpc", entityKind: "ad_group", entityRef: "10", payload: { newCpcBidMicros: 650_000 } },
        before({ cpcBidMicros: 500_000 }), { operation: "adGroups:mutate", request: {}, response: {} }
      );
      expect(r?.action).toEqual({ actionType: "update_cpc", entityKind: "ad_group", entityRef: "10", payload: { newCpcBidMicros: 500_000 } });
    });

    it("update_cpc rollback (risk #2): null when before.cpcBidMicros is null (smart-bidding — honestly un-rollbackable)", () => {
      const r = googleAdapter.buildRollback(
        { actionType: "update_cpc", entityKind: "ad_group", entityRef: "10", payload: { newCpcBidMicros: 650_000 } },
        before({ cpcBidMicros: null }), { operation: "adGroups:mutate", request: {}, response: {} }
      );
      expect(r).toBeNull();
    });

    it("remove_negatives → add_negatives(payload.removed) when removed is present", () => {
      const r = googleAdapter.buildRollback(
        { actionType: "remove_negatives", entityKind: "campaign", entityRef: "111",
          payload: { resourceNames: ["customers/123/campaignCriteria/111~9"], removed: [{ text: "gratis", match: "PHRASE" }] } },
        before(), { operation: "campaignCriteria:mutate", request: {}, response: {} }
      );
      expect(r?.action).toEqual({ actionType: "add_negatives", entityKind: "campaign", entityRef: "111", payload: { negatives: [{ text: "gratis", match: "PHRASE" }] } });
    });

    it("remove_negatives rollback: null when removed is absent (preserves today's no-rollback-of-rollback behavior)", () => {
      const r = googleAdapter.buildRollback(
        { actionType: "remove_negatives", entityKind: "campaign", entityRef: "111", payload: { resourceNames: ["customers/123/campaignCriteria/111~9"] } },
        before(), { operation: "campaignCriteria:mutate", request: {}, response: {} }
      );
      expect(r).toBeNull();
    });
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

  it("BUG 1b regression: buildRollback for a create sets entityRef to the REAL resourceName, never the tmp: placeholder", () => {
    const r = googleAdapter.buildRollback(
      { actionType: "create_campaign", entityKind: "campaign", entityRef: "tmp:campaign:2", payload: {} as never },
      synthBefore(), { operation: "campaigns:mutate", request: {}, response: {}, resourceNames: ["customers/123/campaigns/5"] });
    // If entityRef stayed "tmp:campaign:2" (action.entityRef), the rollback's own
    // prepare() would either hit the tmp:-rejection guard or try to snapshot() a
    // non-numeric ref and throw.
    expect(r?.action.entityRef).toBe("customers/123/campaigns/5");
    expect(r?.action.entityRef.startsWith("tmp:")).toBe(false);
  });

  it("accepted deviation: create_keywords with multiple resourceNames includes ALL of them in the remove_entity payload", () => {
    const created = [
      "customers/123/adGroupCriteria/10~111",
      "customers/123/adGroupCriteria/10~112",
      "customers/123/adGroupCriteria/10~113",
    ];
    const r = googleAdapter.buildRollback(
      { actionType: "create_keywords", entityKind: "ad_group", entityRef: "tmp:ag1:kw", payload: {} as never },
      synthBefore(), { operation: "adGroupCriteria:mutate", request: {}, response: {}, resourceNames: created });
    expect(r?.action.actionType).toBe("remove_entity");
    expect((r?.action.payload as { resourceNames: string[] }).resourceNames).toEqual(created);
    // entityRef is a representative real resourceName (first), never the tmp: placeholder.
    expect(r?.action.entityRef).toBe(created[0]);
  });

  it("BUG 2a regression: validate() rejects create_campaign with an unmapped country code BEFORE any live mutation", async () => {
    responder = () => ({ results: [{ resourceName: "customers/123/campaigns/5" }] });
    const res = await googleAdapter.validate!(AUTH, "123", {
      actionType: "create_campaign", entityKind: "campaign", entityRef: "tmp:campaign:3",
      payload: {
        name: "C", status: "PAUSED", channel: "SEARCH", budgetRef: "customers/123/campaignBudgets/9",
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, geoTargetIds: ["ZZ"], presenceOnly: true,
      },
    }, synthBefore());
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("País no soportado");
    // Fail-closed BEFORE execution: no campaigns:mutate call (or any fetch at all) was made.
    expect(calls.find((c) => c.url.endsWith("campaigns:mutate"))).toBeUndefined();
  });

  it("BUG 2b regression: execute() compensates (deletes the just-created campaign) and rethrows when campaignCriteria:mutate fails", async () => {
    responder = (url) => {
      if (url.endsWith("campaigns:mutate")) return { results: [{ resourceName: "customers/123/campaigns/5" }] };
      if (url.endsWith("campaignCriteria:mutate")) throw new Error("Google Ads campaignCriteria:mutate 400: geo boom");
      return {};
    };
    await expect(googleAdapter.execute(AUTH, "123", {
      actionType: "create_campaign", entityKind: "campaign", entityRef: "tmp:campaign:4",
      payload: {
        name: "C", status: "PAUSED", channel: "SEARCH", budgetRef: "customers/123/campaignBudgets/9",
        bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, geoTargetIds: ["MX"], presenceOnly: true,
      },
    }, synthBefore())).rejects.toThrow(/customers\/123\/campaigns\/5/);

    const campaignCalls = calls.filter((c) => c.url.endsWith("campaigns:mutate"));
    expect(campaignCalls).toHaveLength(2); // step 1 create + compensating delete
    const compensatingBody = JSON.parse(String(campaignCalls[1]?.init?.body));
    expect(compensatingBody.operations[0].remove).toBe("customers/123/campaigns/5");
  });

  it("pause on entityKind ad → adGroupAds:mutate with the FULL resourceName", async () => {
    responder = () => ({ results: [{ resourceName: "customers/123/adGroupAds/7~11" }] });
    await googleAdapter.execute(AUTH, "123",
      { actionType: "pause", entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", payload: {} },
      { entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", status: "ENABLED" });
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith("adGroupAds:mutate"))?.init?.body));
    expect(body.operations[0].update.resourceName).toBe("customers/123/adGroupAds/7~11");
    expect(body.operations[0].update.status).toBe("PAUSED");
    expect(body.operations[0].updateMask).toBe("status");
  });

  it("snapshot on entityKind ad queries by resource_name and returns status", async () => {
    responder = (url) => String(url).includes("googleAds:search")
      ? { results: [{ adGroupAd: { status: "ENABLED", resourceName: "customers/123/adGroupAds/7~11" } }] }
      : {};
    const snap = await googleAdapter.snapshot(AUTH, "123", "ad", "customers/123/adGroupAds/7~11");
    expect(snap.status).toBe("ENABLED");
    const q = String(calls.find((c) => String(c.url).includes("googleAds:search"))?.init?.body);
    expect(q).toContain("ad_group_ad.resource_name");
  });

  it("validate() handles pause on an ad (validateOnly of adGroupAds:mutate)", async () => {
    responder = () => ({});
    const res = await googleAdapter.validate!(AUTH, "123",
      { actionType: "pause", entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", payload: {} },
      { entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", status: "ENABLED" });
    expect(res.ok).toBe(true);
  });

  it("buildRollback of pause(ad) → enable with the same FULL resourceName", () => {
    const r = googleAdapter.buildRollback(
      { actionType: "pause", entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", payload: {} },
      { entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", status: "ENABLED" },
      { operation: "adGroupAds:mutate", request: {}, response: {} });
    expect(r?.action.actionType).toBe("enable");
    expect(r?.action.entityRef).toBe("customers/123/adGroupAds/7~11");
  });

  it("readCampaignTree throws on non-SEARCH campaigns (Solo campañas de Búsqueda)", async () => {
    responder = () => ({ results: [{
      campaign: { id: "5", resourceName: "customers/123/campaigns/5", name: "C", status: "ENABLED",
        advertisingChannelType: "PERFORMANCE_MAX", campaignBudget: "customers/123/campaignBudgets/9" },
      campaignBudget: { amountMicros: "350000000", explicitlyShared: false },
      customer: { currencyCode: "USD" },
    }] });
    await expect(readCampaignTree(AUTH, "123", "5")).rejects.toThrow("Solo campañas de Búsqueda");
  });

  describe("v2.7 readCampaignTree deltas", () => {
    it("ad_group GAQL selects cpc_bid_micros; keyword GAQL selects criterion status; NEW 5th GAQL loads live campaign negatives", async () => {
      responder = (url, init) => {
        const q = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
        if (q.includes("FROM campaign WHERE campaign.id")) {
          return { results: [{
            campaign: { id: "5", resourceName: "customers/123/campaigns/5", name: "C", status: "ENABLED",
              advertisingChannelType: "SEARCH", campaignBudget: "customers/123/campaignBudgets/9" },
            campaignBudget: { amountMicros: "350000000", explicitlyShared: false },
            customer: { currencyCode: "USD" },
          }] };
        }
        if (q.includes("FROM ad_group WHERE")) {
          expect(q).toContain("ad_group.cpc_bid_micros");
          return { results: [{ adGroup: { id: "10", resourceName: "customers/123/adGroups/10", name: "AG", status: "ENABLED", cpcBidMicros: "500000" } }] };
        }
        if (q.includes("FROM ad_group_criterion")) {
          expect(q).toContain("ad_group_criterion.status");
          return { results: [] };
        }
        if (q.includes("FROM ad_group_ad")) return { results: [] };
        if (q.includes("FROM campaign_criterion")) {
          expect(q).toContain("campaign_criterion.type = 'KEYWORD'");
          expect(q).toContain("campaign_criterion.negative = true");
          expect(q).toContain("campaign_criterion.status != 'REMOVED'");
          return { results: [{ campaignCriterion: {
            resourceName: "customers/123/campaignCriteria/5~99",
            keyword: { text: "gratis", matchType: "PHRASE" },
          } }] };
        }
        return { results: [] };
      };
      const tree = await readCampaignTree(AUTH, "123", "5");
      expect(tree.campaignNegatives).toHaveLength(1);
      const row = tree.campaignNegatives[0] as { campaignCriterion?: { resourceName?: string } };
      expect(row.campaignCriterion?.resourceName).toBe("customers/123/campaignCriteria/5~99");
    });
  });

  describe("listCampaignMetrics", () => {
    it("sends ONE aggregated GAQL with segments.date DURING in WHERE only (never SELECT), status filter, and maps rows by campaign.id", async () => {
      responder = () => ({ results: [
        { campaign: { id: "111" }, metrics: { costMicros: "3000000", clicks: "10", impressions: "500", conversions: "2.5" } },
        { campaign: { id: "222" }, metrics: { costMicros: "1000000", clicks: "4", impressions: "200", conversions: "0" } },
      ] });
      const metrics = await googleAdapter.listCampaignMetrics!(AUTH, "123", "7d");
      const gaqlCalls = calls.filter((c) => c.url.includes("googleAds:search"));
      expect(gaqlCalls).toHaveLength(1);
      const q = String(JSON.parse(String(gaqlCalls[0]?.init?.body ?? "{}")).query ?? "");
      expect(q).toContain("FROM campaign");
      expect(q).toContain("segments.date DURING LAST_7_DAYS");
      expect(q).toContain("campaign.status != 'REMOVED'");
      // The SELECT clause (before FROM) must never carry segments.date — that would
      // fragment the aggregate into one row per day per campaign, dropping the
      // single-row-per-campaign guarantee the merge-by-id logic depends on.
      const selectClause = q.slice(0, q.indexOf("FROM campaign"));
      expect(selectClause).not.toContain("segments.date");
      expect(q).toContain("metrics.cost_micros");
      expect(q).toContain("metrics.clicks");
      expect(q).toContain("metrics.impressions");
      expect(q).toContain("metrics.conversions");
      expect(metrics).toEqual([
        { entityRef: "111", spendMicros: 3_000_000, clicks: 10, impressions: 500, conversions: 2.5 },
        { entityRef: "222", spendMicros: 1_000_000, clicks: 4, impressions: 200, conversions: 0 },
      ]);
    });

    it("30d range uses segments.date DURING LAST_30_DAYS", async () => {
      responder = () => ({ results: [] });
      await googleAdapter.listCampaignMetrics!(AUTH, "123", "30d");
      const q = String(JSON.parse(String(calls.find((c) => c.url.includes("googleAds:search"))?.init?.body ?? "{}")).query ?? "");
      expect(q).toContain("segments.date DURING LAST_30_DAYS");
    });

    it("does not call the entity-listing endpoint or filter the entity list — it is a sibling read", async () => {
      responder = () => ({ results: [] });
      await googleAdapter.listCampaignMetrics!(AUTH, "123", "7d");
      // Only one search call total: the metrics GAQL. listCampaigns is never invoked here.
      const gaqlCalls = calls.filter((c) => c.url.includes("googleAds:search"));
      expect(gaqlCalls).toHaveLength(1);
    });
  });
});
