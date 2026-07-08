import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { metaAdapter } from "../networks/meta";
import type { EntitySnapshot, MetaCreateAdsetPayload } from "../types";

let calls: Array<{ url: string; init?: RequestInit }> = [];
let responder: (url: string, init?: RequestInit) => unknown = () => ({ id: "999" });
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  responder = () => ({ id: "999" });
  process.env.META_SYSTEM_USER_TOKEN = "meta-token";
  process.env.META_AD_ACCOUNT_IDS = "act_1";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return new Response(JSON.stringify(responder(url, init)), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.META_SYSTEM_USER_TOKEN;
  delete process.env.META_AD_ACCOUNT_IDS;
  delete process.env.META_APP_SECRET;
  delete process.env.META_PAGE_ID;
});

function synthBefore(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return { entityKind: "campaign", entityRef: "tmp:x", status: "UNKNOWN", ...over };
}

function formBody(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

const ADSET_PAYLOAD: MetaCreateAdsetPayload = {
  name: "Adset Test", status: "PAUSED", campaignRef: "5001",
  dailyBudgetMicros: 35_000_000, optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS",
  bidStrategy: "LOWEST_COST_WITHOUT_CAP",
  targeting: { countryCodes: ["MX", "US"], ageMin: 18, ageMax: 65 },
};

describe("metaAdapter — v2.2 creates", () => {
  describe("capabilities switchboard", () => {
    it("no token → write:false, empty actionTypes, reason mentions token", () => {
      delete process.env.META_SYSTEM_USER_TOKEN;
      const caps = metaAdapter.capabilities({});
      expect(caps.write).toBe(false);
      expect(caps.actionTypes).toEqual([]);
      expect(caps.reason).toContain("META_SYSTEM_USER_TOKEN");
    });

    it("token only (no page/secret) → v1 verbs only, with reason", () => {
      const caps = metaAdapter.capabilities({});
      expect(caps.write).toBe(true);
      expect(caps.actionTypes).toEqual(["budget_update", "pause", "enable"]);
      expect(caps.reason).toContain("META_PAGE_ID");
    });

    it("token + page only (no secret) → v1 verbs only", () => {
      process.env.META_PAGE_ID = "page1";
      const caps = metaAdapter.capabilities({});
      expect(caps.actionTypes).toEqual(["budget_update", "pause", "enable"]);
    });

    it("token + secret only (no page) → v1 verbs only", () => {
      process.env.META_APP_SECRET = "app-secret";
      const caps = metaAdapter.capabilities({});
      expect(caps.actionTypes).toEqual(["budget_update", "pause", "enable"]);
    });

    it("token + page + secret → v1 + create family + remove_entity, no reason", () => {
      process.env.META_PAGE_ID = "page1";
      process.env.META_APP_SECRET = "app-secret";
      const caps = metaAdapter.capabilities({});
      expect(caps.actionTypes).toEqual([
        "budget_update", "pause", "enable",
        "create_campaign", "create_adset", "create_ad", "remove_entity",
      ]);
      expect(caps.reason).toBeUndefined();
    });
  });

  describe("create_campaign", () => {
    it("execute → POST /act_1/campaigns, form-encoded body, resourceNames from {id}", async () => {
      responder = () => ({ id: "5001" });
      const exec = await metaAdapter.execute({}, "act_1", {
        actionType: "create_campaign", entityKind: "campaign", entityRef: "tmp:c1",
        payload: { name: "Campaña Test", status: "PAUSED", objective: "OUTCOME_TRAFFIC", buyingType: "AUCTION", specialAdCategories: [] },
      }, synthBefore());
      const call = calls.find((c) => c.url.endsWith("/act_1/campaigns"));
      expect(call).toBeDefined();
      const body = formBody(call?.init);
      expect(body.get("name")).toBe("Campaña Test");
      expect(body.get("objective")).toBe("OUTCOME_TRAFFIC");
      expect(body.get("status")).toBe("PAUSED");
      expect(body.get("buying_type")).toBe("AUCTION");
      expect(body.get("special_ad_categories")).toBe("[]");
      expect(exec.resourceNames).toEqual(["5001"]);
    });

    it("payload status !== PAUSED → buildMetaMutation throws (fail-closed belt)", async () => {
      await expect(metaAdapter.execute({}, "act_1", {
        actionType: "create_campaign", entityKind: "campaign", entityRef: "tmp:c1",
        payload: {
          name: "X", status: "ACTIVE", objective: "OUTCOME_TRAFFIC", buyingType: "AUCTION", specialAdCategories: [],
        } as unknown as { name: string; status: "PAUSED"; objective: "OUTCOME_TRAFFIC"; buyingType: "AUCTION"; specialAdCategories: string[] },
      }, synthBefore())).rejects.toThrow(/PAUSED/);
      // fail-closed BEFORE any network call
      expect(calls).toHaveLength(0);
    });
  });

  describe("create_adset", () => {
    it("execute → POST /act_1/adsets, daily_budget cents conversion + targeting JSON", async () => {
      responder = () => ({ id: "6001" });
      const exec = await metaAdapter.execute({}, "act_1", {
        actionType: "create_adset", entityKind: "adset", entityRef: "tmp:a1", payload: ADSET_PAYLOAD,
      }, synthBefore());
      const call = calls.find((c) => c.url.endsWith("/act_1/adsets"));
      expect(call).toBeDefined();
      const body = formBody(call?.init);
      expect(body.get("name")).toBe("Adset Test");
      expect(body.get("campaign_id")).toBe("5001");
      expect(body.get("status")).toBe("PAUSED");
      expect(body.get("daily_budget")).toBe("3500"); // 35_000_000 micros → $35.00 → 3500 cents
      expect(body.get("optimization_goal")).toBe("LINK_CLICKS");
      expect(body.get("billing_event")).toBe("IMPRESSIONS");
      expect(body.get("bid_strategy")).toBe("LOWEST_COST_WITHOUT_CAP");
      const targeting = JSON.parse(body.get("targeting") ?? "{}");
      expect(targeting.geo_locations.countries).toEqual(["MX", "US"]);
      expect(targeting.age_min).toBe(18);
      expect(targeting.age_max).toBe(65);
      expect(targeting.targeting_automation.advantage_audience).toBe(0);
      expect(exec.resourceNames).toEqual(["6001"]);
    });

    it("microsToCents throws on non-multiple-of-10000, and on non-positive micros", async () => {
      const attempt = (dailyBudgetMicros: number) => metaAdapter.execute({}, "act_1", {
        actionType: "create_adset", entityKind: "adset", entityRef: "tmp:a1",
        payload: { ...ADSET_PAYLOAD, dailyBudgetMicros },
      }, synthBefore());
      await expect(attempt(3_500)).rejects.toThrow();      // not a multiple of MICROS_PER_MINOR_UNIT
      await expect(attempt(35_000_001)).rejects.toThrow(); // not a multiple of MICROS_PER_MINOR_UNIT
      await expect(attempt(0)).rejects.toThrow();           // <= 0
      await expect(attempt(-1)).rejects.toThrow();          // <= 0 (also non-multiple)
    });
  });

  describe("create_ad", () => {
    it("execute → POST /act_1/ads, inline creative uses META_PAGE_ID + status ACTIVE", async () => {
      process.env.META_PAGE_ID = "page-1";
      responder = () => ({ id: "7001" });
      const exec = await metaAdapter.execute({}, "act_1", {
        actionType: "create_ad", entityKind: "ad", entityRef: "tmp:ad1",
        payload: {
          name: "Ad Test", status: "ACTIVE", adsetRef: "6001",
          creative: { link: "https://example.com", message: "Hola", headline: "Titular", callToActionType: "LEARN_MORE" },
        },
      }, synthBefore());
      const call = calls.find((c) => c.url.endsWith("/act_1/ads"));
      expect(call).toBeDefined();
      const body = formBody(call?.init);
      expect(body.get("name")).toBe("Ad Test");
      expect(body.get("adset_id")).toBe("6001");
      expect(body.get("status")).toBe("ACTIVE");
      const creative = JSON.parse(body.get("creative") ?? "{}");
      expect(creative.object_story_spec.page_id).toBe("page-1");
      expect(creative.object_story_spec.link_data.link).toBe("https://example.com");
      expect(creative.object_story_spec.link_data.message).toBe("Hola");
      expect(creative.object_story_spec.link_data.name).toBe("Titular"); // headline → name
      expect(creative.object_story_spec.link_data.picture).toBeUndefined(); // no imageUrl
      expect(creative.object_story_spec.link_data.call_to_action).toEqual({ type: "LEARN_MORE", value: { link: "https://example.com" } });
      expect(exec.resourceNames).toEqual(["7001"]);
    });

    it("picture present only when imageUrl set; description present only when set; call_to_action/name absent when unset", async () => {
      process.env.META_PAGE_ID = "page-1";
      responder = () => ({ id: "7002" });
      await metaAdapter.execute({}, "act_1", {
        actionType: "create_ad", entityKind: "ad", entityRef: "tmp:ad2",
        payload: {
          name: "Ad Test 2", status: "ACTIVE", adsetRef: "6001",
          creative: { link: "https://example.com", message: "Hola", description: "Desc", imageUrl: "https://img.example.com/x.jpg" },
        },
      }, synthBefore());
      const call = calls.find((c) => c.url.endsWith("/act_1/ads"));
      const body = formBody(call?.init);
      const creative = JSON.parse(body.get("creative") ?? "{}");
      expect(creative.object_story_spec.link_data.picture).toBe("https://img.example.com/x.jpg");
      expect(creative.object_story_spec.link_data.description).toBe("Desc");
      expect(creative.object_story_spec.link_data.name).toBeUndefined();
      expect(creative.object_story_spec.link_data.call_to_action).toBeUndefined();
    });
  });

  describe("validate() — TOTAL, never throws", () => {
    it("validate(create_adset) 200 → ok:true, metaPost called with execution_options validate_only", async () => {
      responder = () => ({ success: true });
      const res = await metaAdapter.validate!({}, "act_1", {
        actionType: "create_adset", entityKind: "adset", entityRef: "tmp:a1", payload: ADSET_PAYLOAD,
      }, synthBefore());
      expect(res.ok).toBe(true);
      const call = calls.find((c) => c.url.endsWith("/act_1/adsets"));
      expect(call).toBeDefined();
      const body = formBody(call?.init);
      expect(body.get("execution_options")).toBe('["validate_only"]');
    });

    it("validate() API 400 → ok:false, detail contains the API message", async () => {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push({ url: String(input) });
        return new Response("bad request payload", { status: 400 });
      }) as typeof fetch;
      const res = await metaAdapter.validate!({}, "act_1", {
        actionType: "create_campaign", entityKind: "campaign", entityRef: "tmp:c1",
        payload: { name: "C", status: "PAUSED", objective: "OUTCOME_TRAFFIC", buyingType: "AUCTION", specialAdCategories: [] },
      }, synthBefore());
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("bad request payload");
    });

    it("validate(pause) → ok:true 'sin ensayo', ZERO fetch calls", async () => {
      const res = await metaAdapter.validate!({}, "act_1",
        { actionType: "pause", entityKind: "campaign", entityRef: "777", payload: {} }, synthBefore());
      expect(res.ok).toBe(true);
      expect(res.detail).toContain("sin ensayo");
      expect(calls).toHaveLength(0);
    });

    it("validate(remove_entity) → ok:true, ZERO fetch calls (the strand-rollback guard)", async () => {
      const res = await metaAdapter.validate!({}, "act_1",
        { actionType: "remove_entity", entityKind: "campaign", entityRef: "5001", payload: { resourceNames: ["5001"] } }, synthBefore());
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  describe("remove_entity execute (DELETE)", () => {
    it("DELETE /<id> via metaDelete", async () => {
      responder = () => ({ success: true });
      const exec = await metaAdapter.execute({}, "act_1",
        { actionType: "remove_entity", entityKind: "campaign", entityRef: "5001", payload: { resourceNames: ["5001"] } }, synthBefore());
      const call = calls.at(-1);
      expect(call?.url).toContain("/5001");
      expect(call?.init?.method).toBe("DELETE");
      expect(exec.operation).toBe("DELETE /5001");
    });

    it("appsecret_proof present on DELETE when META_APP_SECRET set, absent when unset", async () => {
      process.env.META_APP_SECRET = "app-secret";
      responder = () => ({ success: true });
      await metaAdapter.execute({}, "act_1",
        { actionType: "remove_entity", entityKind: "campaign", entityRef: "5001", payload: { resourceNames: ["5001"] } }, synthBefore());
      expect(calls.at(-1)?.url).toMatch(/[?&]appsecret_proof=[0-9a-f]{64}(&|$)/);

      calls = [];
      delete process.env.META_APP_SECRET;
      await metaAdapter.execute({}, "act_1",
        { actionType: "remove_entity", entityKind: "campaign", entityRef: "5001", payload: { resourceNames: ["5001"] } }, synthBefore());
      expect(calls.at(-1)?.url).not.toContain("appsecret_proof");
    });
  });

  describe("buildRollback — creates", () => {
    it("create_adset with resourceNames → remove_entity, entityRef = REAL id (never the tmp: placeholder)", () => {
      const r = metaAdapter.buildRollback(
        { actionType: "create_adset", entityKind: "adset", entityRef: "tmp:a1", payload: {} as never },
        synthBefore(), { operation: "POST /act_1/adsets", request: {}, response: {}, resourceNames: ["123"] });
      expect(r?.action.actionType).toBe("remove_entity");
      expect(r?.action.entityRef).toBe("123");
      expect((r?.action.payload as { resourceNames: string[] }).resourceNames).toEqual(["123"]);
      expect(r?.note).toBeTruthy();
    });

    it("create_campaign/create_ad with resourceNames → same remove_entity shape", () => {
      const rCampaign = metaAdapter.buildRollback(
        { actionType: "create_campaign", entityKind: "campaign", entityRef: "tmp:c1", payload: {} as never },
        synthBefore(), { operation: "POST /act_1/campaigns", request: {}, response: {}, resourceNames: ["5001"] });
      expect(rCampaign?.action.actionType).toBe("remove_entity");
      expect(rCampaign?.action.entityRef).toBe("5001");

      const rAd = metaAdapter.buildRollback(
        { actionType: "create_ad", entityKind: "ad", entityRef: "tmp:ad1", payload: {} as never },
        synthBefore(), { operation: "POST /act_1/ads", request: {}, response: {}, resourceNames: ["7001"] });
      expect(rAd?.action.actionType).toBe("remove_entity");
      expect(rAd?.action.entityRef).toBe("7001");
    });

    it("empty resourceNames → null (only when the create itself failed)", () => {
      const r = metaAdapter.buildRollback(
        { actionType: "create_campaign", entityKind: "campaign", entityRef: "tmp:c1", payload: {} as never },
        synthBefore(), { operation: "POST /act_1/campaigns", request: {}, response: {}, resourceNames: [] });
      expect(r).toBeNull();
    });
  });

  describe("v1 regression — byte-identical requests (moved into buildMetaMutation unchanged)", () => {
    it("budget_update posts daily_budget in minor units", async () => {
      responder = () => ({ success: true });
      await metaAdapter.execute({}, "act_1",
        { actionType: "budget_update", entityKind: "adset", entityRef: "555", payload: { newDailyBudgetMicros: 30_000_000 } },
        synthBefore());
      const call = calls.find((c) => c.url.endsWith("/555"));
      expect(String(call?.init?.body)).toContain("daily_budget=3000");
    });

    it("pause posts status=PAUSED; enable posts status=ACTIVE", async () => {
      responder = () => ({ success: true });
      await metaAdapter.execute({}, "act_1", { actionType: "pause", entityKind: "campaign", entityRef: "777", payload: {} }, synthBefore());
      expect(String(calls.at(-1)?.init?.body)).toContain("status=PAUSED");
      await metaAdapter.execute({}, "act_1", { actionType: "enable", entityKind: "campaign", entityRef: "777", payload: {} }, synthBefore());
      expect(String(calls.at(-1)?.init?.body)).toContain("status=ACTIVE");
    });
  });
});
