import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { metaAdapter, metaAccountRefs, metaBudgetRoundMicros } from "../networks/meta";
import type { EntitySnapshot } from "../types";
import { MICROS_PER_MINOR_UNIT } from "../types";

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

  describe("listCampaignMetrics", () => {
    it("sends ONE insights GET (level=campaign, date_preset, fields incl actions), spend→micros, conversions via shared helper", async () => {
      const envBefore = { META_SYSTEM_USER_TOKEN: process.env.META_SYSTEM_USER_TOKEN, META_AD_ACCOUNT_IDS: process.env.META_AD_ACCOUNT_IDS };
      responder = (url) => {
        if (url.includes("/insights")) {
          return { data: [
            { campaign_id: "111", spend: "150.25", clicks: "10", impressions: "500",
              actions: [{ action_type: "purchase", value: "3" }, { action_type: "lead", value: "2" }] },
            { campaign_id: "222", spend: "40.00", clicks: "4", impressions: "200",
              actions: [{ action_type: "video_view", value: "99" }] },
          ] };
        }
        return {};
      };
      const metrics = await metaAdapter.listCampaignMetrics!({}, "act_1", "7d");
      const insightsCalls = calls.filter((c) => c.url.includes("/insights"));
      expect(insightsCalls).toHaveLength(1);
      const url = new URL(insightsCalls[0]!.url);
      expect(url.searchParams.get("level")).toBe("campaign");
      expect(url.searchParams.get("date_preset")).toBe("last_7d");
      expect(url.searchParams.get("fields")).toBe("campaign_id,spend,clicks,impressions,actions");
      expect(url.searchParams.get("limit")).toBe("500");
      expect(metrics).toEqual([
        { entityRef: "111", spendMicros: 150_250_000, clicks: 10, impressions: 500, conversions: 5 },
        { entityRef: "222", spendMicros: 40_000_000, clicks: 4, impressions: 200, conversions: 0 },
      ]);
      // env save/restore
      expect(process.env.META_SYSTEM_USER_TOKEN).toBe(envBefore.META_SYSTEM_USER_TOKEN);
      expect(process.env.META_AD_ACCOUNT_IDS).toBe(envBefore.META_AD_ACCOUNT_IDS);
    });

    it("30d range uses date_preset=last_30d", async () => {
      responder = () => ({ data: [] });
      await metaAdapter.listCampaignMetrics!({}, "act_1", "30d");
      const url = new URL(calls.find((c) => c.url.includes("/insights"))!.url);
      expect(url.searchParams.get("date_preset")).toBe("last_30d");
    });

    it("follows paging.next AT MOST once (a second next is never fetched)", async () => {
      let insightsCallCount = 0;
      responder = (url) => {
        if (url.includes("page3marker")) {
          insightsCallCount += 1;
          return { data: [{ campaign_id: "999", spend: "9.00", clicks: "9", impressions: "90", actions: [] }] };
        }
        if (url.includes("page2marker")) {
          insightsCallCount += 1;
          return {
            data: [{ campaign_id: "333", spend: "5.00", clicks: "1", impressions: "10", actions: [] }],
            paging: { next: "https://graph.facebook.com/v25.0/act_1/insights?page3marker=1" },
          };
        }
        if (url.includes("/insights")) {
          insightsCallCount += 1;
          return {
            data: [{ campaign_id: "111", spend: "1.00", clicks: "1", impressions: "10", actions: [] }],
            paging: { next: "https://graph.facebook.com/v25.0/act_1/insights?page2marker=1" },
          };
        }
        return {};
      };
      const metrics = await metaAdapter.listCampaignMetrics!({}, "act_1", "7d");
      expect(insightsCallCount).toBe(2); // followed page2 only — page3 never fetched
      expect(metrics.map((m) => m.entityRef)).toEqual(["111", "333"]);
    });

    it("regression: insightsToSignals (via snapshot) still produces identical signals post-extraction", async () => {
      responder = (url) => {
        if (url.includes("/insights")) return { data: [{ spend: "150.25", actions: [{ action_type: "purchase", value: "3" }, { action_type: "lead", value: "2" }] }] };
        return { id: "555", name: "Adset X", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000", learning_stage_info: { status: "LEARNING" } };
      };
      const snap = await metaAdapter.snapshot({}, "act_1", "adset", "555");
      expect(snap.conversions30d).toBe(5);
      expect(snap.spend30dMicros).toBe(150_250_000);
    });
  });

  describe("metaBudgetRoundMicros", () => {
    it("rounds micros to the nearest whole minor-unit (cent) boundary, matching the adapter's write-time rounding", () => {
      expect(metaBudgetRoundMicros(30_000_000)).toBe(30_000_000); // already cent-aligned
      expect(metaBudgetRoundMicros(30_000_001)).toBe(30_000_000); // rounds down within the cent
      expect(metaBudgetRoundMicros(30_004_999)).toBe(30_000_000);
      expect(metaBudgetRoundMicros(30_005_000)).toBe(30_010_000); // rounds up at the midpoint
      expect(metaBudgetRoundMicros(0)).toBe(0);
    });

    it("is expressed in terms of MICROS_PER_MINOR_UNIT (the shared constant), not a hardcoded 10_000", () => {
      const micros = 7 * MICROS_PER_MINOR_UNIT + 1;
      expect(metaBudgetRoundMicros(micros)).toBe(7 * MICROS_PER_MINOR_UNIT);
    });
  });
});
