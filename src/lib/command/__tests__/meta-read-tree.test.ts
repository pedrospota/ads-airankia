import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readMetaCampaignTree, type RawMetaCampaignTree } from "../networks/meta";
import { buildMetaEditDoc } from "../edit/meta-read-tree";
import { parseMetaEditDoc } from "../edit/meta-schema";

// Same fetch harness as meta-adapter.test.ts.
let calls: Array<{ url: string; init?: RequestInit }> = [];
let responder: (url: string) => unknown = () => ({});
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  process.env.META_SYSTEM_USER_TOKEN = "meta-token";
  process.env.META_AD_ACCOUNT_IDS = "act_123";
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
});

// Graph responses for a healthy ABO campaign under act_123.
function healthyResponder(url: string): unknown {
  if (url.includes("/111/adsets")) {
    return { data: [
      { id: "222", name: "AS", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000", learning_stage_info: { status: "SUCCESS" } },
      { id: "223", name: "AS archivado", status: "ARCHIVED", effective_status: "ARCHIVED" }, // leaf → FILTERED
    ] };
  }
  if (url.includes("/111/ads")) {
    return { data: [
      { id: "333", name: "Ad 1", status: "ACTIVE", effective_status: "ACTIVE", adset_id: "222" },
      { id: "334", name: "Ad 2", status: "PAUSED", effective_status: "CAMPAIGN_PAUSED", adset_id: "222" },
      { id: "335", name: "Ad borrado", status: "DELETED", effective_status: "DELETED", adset_id: "222" }, // leaf → FILTERED
    ] };
  }
  if (url.includes("/act_123?")) return { currency: "MXN" };
  if (url.includes("/111?")) {
    return { id: "111", name: "C", status: "ACTIVE", effective_status: "ACTIVE", account_id: "123" };
  }
  return {};
}

describe("readMetaCampaignTree", () => {
  it("4 GETs (campaign, adsets, ads, account currency); leaves with status ∉ {ACTIVE,PAUSED} filtered", async () => {
    responder = healthyResponder;
    const tree = await readMetaCampaignTree({}, "act_123", "111");
    expect(calls).toHaveLength(4);
    const campaignCall = new URL(calls[0].url);
    expect(campaignCall.pathname.endsWith("/111")).toBe(true);
    expect(campaignCall.searchParams.get("fields")).toBe("id,name,status,effective_status,daily_budget,lifetime_budget,account_id");
    expect(new URL(calls[1].url).searchParams.get("fields")).toBe("id,name,status,effective_status,daily_budget,lifetime_budget,learning_stage_info");
    expect(new URL(calls[2].url).searchParams.get("fields")).toBe("id,name,status,effective_status,adset_id");
    expect(new URL(calls[3].url).searchParams.get("fields")).toBe("currency");
    expect(tree.adsets.map((a) => a.id)).toEqual(["222"]);   // ARCHIVED adset filtered
    expect(tree.ads.map((a) => a.id)).toEqual(["333", "334"]); // DELETED ad filtered
    expect(tree.currency).toBe("MXN");
  });

  it("tenant bind: account_id ≠ accountRef digits → es-MX throw (risk #8)", async () => {
    responder = (url) => url.includes("/111?")
      ? { id: "111", name: "C", status: "ACTIVE", account_id: "999" }
      : healthyResponder(url);
    await expect(readMetaCampaignTree({}, "act_123", "111")).rejects.toThrow(/no pertenece a la cuenta/);
  });

  it("campaign ARCHIVED/DELETED → throw (mirrors requireEditableStatus; only the campaign throws)", async () => {
    responder = (url) => url.includes("/111?")
      ? { id: "111", name: "C", status: "ARCHIVED", account_id: "123" }
      : healthyResponder(url);
    await expect(readMetaCampaignTree({}, "act_123", "111")).rejects.toThrow(/archivada\/eliminada/);
  });

  it("pagination: follows paging.next AT MOST once; a remaining second next → throw, never a truncated tree (risk #10)", async () => {
    responder = (url) => {
      if (url.includes("page3marker")) return { data: [] }; // must never be fetched
      if (url.includes("page2marker")) {
        return {
          data: [{ id: "225", name: "AS-2", status: "ACTIVE", effective_status: "ACTIVE" }],
          paging: { next: "https://graph.facebook.com/v25.0/111/adsets?page3marker=1" },
        };
      }
      if (url.includes("/111/adsets")) {
        return {
          data: [{ id: "222", name: "AS", status: "ACTIVE", effective_status: "ACTIVE" }],
          paging: { next: "https://graph.facebook.com/v25.0/111/adsets?page2marker=1" },
        };
      }
      return healthyResponder(url);
    };
    await expect(readMetaCampaignTree({}, "act_123", "111")).rejects.toThrow(/demasiado grande/);
    expect(calls.some((c) => c.url.includes("page3marker"))).toBe(false);
  });

  it("pagination happy path: exactly one next follow merges the second page", async () => {
    responder = (url) => {
      if (url.includes("page2marker")) {
        return { data: [{ id: "225", name: "AS-2", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "3000" }] };
      }
      if (url.includes("/111/adsets")) {
        return {
          data: [{ id: "222", name: "AS", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000" }],
          paging: { next: "https://graph.facebook.com/v25.0/111/adsets?page2marker=1" },
        };
      }
      return healthyResponder(url);
    };
    const tree = await readMetaCampaignTree({}, "act_123", "111");
    expect(tree.adsets.map((a) => a.id)).toEqual(["222", "225"]);
  });
});

// ---------------------------------------------------------------------------
// buildMetaEditDoc — PURE mapper (no fetch involved from here down)
// ---------------------------------------------------------------------------

const ABO_TREE: RawMetaCampaignTree = {
  campaign: { id: "111", name: "C", status: "ACTIVE", effective_status: "ACTIVE", account_id: "123" },
  adsets: [{ id: "222", name: "AS", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000", learning_stage_info: { status: "SUCCESS" } }],
  ads: [
    { id: "333", name: "Ad 1", status: "ACTIVE", effective_status: "ACTIVE", adset_id: "222" },
    { id: "334", name: "Ad 2", status: "PAUSED", effective_status: "CAMPAIGN_PAUSED", adset_id: "222" },
  ],
  currency: "MXN",
};

const CBO_TREE: RawMetaCampaignTree = {
  campaign: { id: "111", name: "C", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "5000", account_id: "123" },
  adsets: [{ id: "222", name: "AS", status: "PAUSED", effective_status: "PAUSED", learning_stage_info: { status: "LEARNING" } }],
  ads: [],
  currency: "USD",
};

const NOW = "2026-07-08T12:00:00.000Z";

describe("buildMetaEditDoc", () => {
  it("ABO shape: campaign daily null, adset minor-units → micros; desired seeded = base; loadedAt = nowIso", () => {
    const doc = buildMetaEditDoc(ABO_TREE, "act_123", NOW);
    expect(doc.docType).toBe("meta_edit_v1");
    expect(doc.accountRef).toBe("act_123");
    expect(doc.loadedAt).toBe(NOW);
    expect(doc.campaign.base.dailyBudgetMicros).toBeNull();
    expect(doc.campaign.desired.dailyBudgetMicros).toBeNull();
    expect(doc.campaign.adsets[0].base.dailyBudgetMicros).toBe(20_000_000); // "2000" cents → micros
    expect(doc.campaign.adsets[0].desired).toEqual({ status: "ENABLED", dailyBudgetMicros: 20_000_000 });
    expect(doc.campaign.base.currency).toBe("MXN");
  });

  it("CBO shape: campaign daily non-null, adset null (budget-locked at adset level)", () => {
    const doc = buildMetaEditDoc(CBO_TREE, "act_123", NOW);
    expect(doc.campaign.base.dailyBudgetMicros).toBe(50_000_000);
    expect(doc.campaign.adsets[0].base.dailyBudgetMicros).toBeNull();
    expect(doc.campaign.adsets[0].desired.dailyBudgetMicros).toBeNull();
  });

  it("statuses map from CONFIGURED status; effective_status rides along display-only (risk #4)", () => {
    const doc = buildMetaEditDoc(ABO_TREE, "act_123", NOW);
    // Ad 334 is configured PAUSED with effective CAMPAIGN_PAUSED — base.status must
    // come from the configured value; the divergent effective string is preserved
    // verbatim for the UI badge and never influences status.
    expect(doc.campaign.adsets[0].ads[1].base.status).toBe("PAUSED");
    expect(doc.campaign.adsets[0].ads[1].base.effectiveStatus).toBe("CAMPAIGN_PAUSED");
    // Ad 333: ACTIVE → ENABLED.
    expect(doc.campaign.adsets[0].ads[0].base.status).toBe("ENABLED");
  });

  it("learningPhase maps via the mapLearning convention (SUCCESS→STABLE, LEARNING→LEARNING)", () => {
    expect(buildMetaEditDoc(ABO_TREE, "act_123", NOW).campaign.adsets[0].base.learningPhase).toBe("STABLE");
    expect(buildMetaEditDoc(CBO_TREE, "act_123", NOW).campaign.adsets[0].base.learningPhase).toBe("LEARNING");
  });

  it("ads group under their adset by adset_id", () => {
    const doc = buildMetaEditDoc(ABO_TREE, "act_123", NOW);
    expect(doc.campaign.adsets[0].ads.map((a) => a.id)).toEqual(["333", "334"]);
  });

  it("fail-closed: an unrecognized configured status throws with an es-MX message", () => {
    const bad: RawMetaCampaignTree = { ...ABO_TREE, adsets: [{ ...ABO_TREE.adsets[0], status: "IN_PROCESS" }] };
    expect(() => buildMetaEditDoc(bad, "act_123", NOW)).toThrow(/no soportado/);
  });

  it("output round-trips through parseMetaEditDoc (schema-valid by construction)", () => {
    expect(() => parseMetaEditDoc(buildMetaEditDoc(ABO_TREE, "act_123", NOW))).not.toThrow();
    expect(() => parseMetaEditDoc(buildMetaEditDoc(CBO_TREE, "act_123", NOW))).not.toThrow();
  });
});
