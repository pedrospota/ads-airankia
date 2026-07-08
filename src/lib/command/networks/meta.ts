// Centro de Mando — Meta (Facebook) Marketing API adapter. SERVER-ONLY.
// v1 auth: system-user token via META_SYSTEM_USER_TOKEN env; accounts
// allowlisted via META_AD_ACCOUNT_IDS. Without a token the adapter degrades
// to capabilities {write:false} and the UI shows "pendiente de credenciales".
// v2.2: create_campaign/create_adset/create_ad + remove_entity, gated behind
// META_PAGE_ID + META_APP_SECRET (see capabilities()). The rail speaks micros
// end-to-end; cents exist only inside this file (see microsToCents).
import { createHmac } from "node:crypto";
import type {
  AdapterAuth, AdapterCapabilities, CampaignMetrics, CcActionInput, CcInternalActionType, CcMetricsRange,
  EntitySnapshot, ExecuteResult, MetaCreateAdPayload, MetaCreateAdsetPayload,
  MetaCreateCampaignPayload, NetworkAdapter, RemoveEntityPayload, RollbackRecipe,
} from "../types";
import { MICROS_PER_MINOR_UNIT, MICROS_PER_UNIT } from "../types";

const apiVersion = () => process.env.META_API_VERSION || "v25.0";
const token = () => (process.env.META_SYSTEM_USER_TOKEN ?? "").trim();
const graph = () => `https://graph.facebook.com/${apiVersion()}`;
const pageId = () => (process.env.META_PAGE_ID ?? "").trim();
const appSecret = () => (process.env.META_APP_SECRET ?? "").trim();

// Throws if unset — unreachable in practice because capabilities() already
// withholds the create action types without META_PAGE_ID.
function requirePageId(): string {
  const id = pageId();
  if (!id) throw new Error("META_PAGE_ID no configurado.");
  return id;
}

export function metaAccountRefs(): string[] {
  return (process.env.META_AD_ACCOUNT_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

// appsecret_proof: required by Meta when the app has "Require app secret proof
// for server API calls" enabled (standard for system-user tokens). Only added
// when META_APP_SECRET is configured; omitted otherwise for back-compat.
function appsecretProof(accessToken: string): string | null {
  const secret = (process.env.META_APP_SECRET ?? "").trim();
  if (!secret) return null;
  return createHmac("sha256", secret).update(accessToken).digest("hex");
}

async function metaGet(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const tok = token();
  const search = new URLSearchParams({ ...params, access_token: tok });
  const proof = appsecretProof(tok);
  if (proof) search.set("appsecret_proof", proof);
  const res = await fetch(`${graph()}${path}?${search}`, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`Meta API GET ${path} ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

async function metaPost(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const tok = token();
  const body = new URLSearchParams({ ...form, access_token: tok });
  const proof = appsecretProof(tok);
  const query = proof ? `?${new URLSearchParams({ appsecret_proof: proof })}` : "";
  const res = await fetch(`${graph()}${path}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Meta API POST ${path} ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

// Fetches a fully-qualified URL as-is — used ONLY to follow Graph API's
// `paging.next`, which already comes back as a complete URL (own access_token
// + cursor baked in by Meta). Unlike metaGet, this must NOT re-append
// access_token (which would duplicate) — but appsecret_proof must be APPENDED
// when META_APP_SECRET is configured, as Meta's paging.next does not include it.
async function metaGetUrl(url: string): Promise<Record<string, unknown>> {
  let fetchUrl = url;
  const proof = appsecretProof(token());
  if (proof) {
    const urlObj = new URL(url);
    urlObj.searchParams.set("appsecret_proof", proof);
    fetchUrl = urlObj.toString();
  }
  const res = await fetch(fetchUrl, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`Meta API GET ${fetchUrl} ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

async function metaDelete(path: string): Promise<Record<string, unknown>> {
  const tok = token();
  const search = new URLSearchParams({ access_token: tok });
  const proof = appsecretProof(tok);
  if (proof) search.set("appsecret_proof", proof);
  const res = await fetch(`${graph()}${path}?${search}`, { method: "DELETE", cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`Meta API DELETE ${path} ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

function mapStatus(value: unknown): EntitySnapshot["status"] {
  const s = String(value ?? "").toUpperCase();
  if (s === "ACTIVE") return "ENABLED";
  if (s === "PAUSED") return "PAUSED";
  if (s === "ARCHIVED" || s === "DELETED") return "ARCHIVED";
  return "UNKNOWN";
}

function mapLearning(info: unknown): EntitySnapshot["learningPhase"] {
  const s = String((info as Record<string, unknown>)?.status ?? "").toUpperCase();
  if (s === "LEARNING") return "LEARNING";
  if (s === "SUCCESS") return "STABLE";
  if (s === "FAIL") return "LIMITED";
  return "UNKNOWN";
}

const CONVERSION_ACTIONS = new Set([
  "purchase", "omni_purchase", "lead", "omni_lead",
  "offsite_conversion.fb_pixel_purchase", "offsite_conversion.fb_pixel_lead",
  "offsite_conversion.fb_pixel_custom", "onsite_conversion.purchase",
  "omni_complete_registration", "lead_grouped",
]);

// Shared per-row conversions extraction — the SINGLE source of truth used by
// BOTH insightsToSignals (snapshot's 30d rollup) and listCampaignMetrics (v2.6
// bulk campaign read), so the two can never diverge on which action types count.
function conversionsFromActions(actions: Array<{ action_type?: string; value?: string }> | undefined): number {
  let conversions = 0;
  for (const action of actions ?? []) {
    if (action.action_type && CONVERSION_ACTIONS.has(action.action_type)) conversions += Number(action.value ?? 0);
  }
  return conversions;
}

function insightsToSignals(data: unknown): { conversions30d: number | null; spend30dMicros: number | null } {
  const rows = (data as { data?: Array<Record<string, unknown>> })?.data ?? [];
  if (!rows.length) return { conversions30d: null, spend30dMicros: null };
  let conversions = 0;
  let spendMicros = 0;
  for (const row of rows) {
    spendMicros += Math.round(Number(row.spend ?? 0) * MICROS_PER_UNIT);
    conversions += conversionsFromActions(row.actions as Array<{ action_type?: string; value?: string }> | undefined);
  }
  return { conversions30d: conversions, spend30dMicros: spendMicros };
}

// THE ONLY cents-producing function. Rail (doc, payloads, gates, ledger,
// snapshot) is ALWAYS micros; cents exist only inside this adapter. Called at
// exactly one write site: create_adset. The existing budget_update conversion
// (Math.round division, below) is deliberately left untouched — see spec §d.
function microsToCents(micros: number): string {
  if (!Number.isInteger(micros) || micros <= 0 || micros % MICROS_PER_MINOR_UNIT !== 0)
    throw new Error(`Presupuesto no convertible a centavos: ${micros} micros`);
  return String(micros / MICROS_PER_MINOR_UNIT);
}

// v2.6 (spec risk #2): the ONE shared rounding helper Task 3's verification
// mirrors to compare an intended budget against what actually landed. The
// adapter's OWN write path (budget_update above) rounds via division, never
// through this helper — it must stay a pure re-derivation of that same rule
// so verify.ts's drift comparison can never disagree with what was written.
export function metaBudgetRoundMicros(micros: number): number {
  return Math.round(micros / MICROS_PER_MINOR_UNIT) * MICROS_PER_MINOR_UNIT;
}

interface MetaMutation { path: string; method: "POST" | "DELETE"; form: Record<string, string> }

const META_CREATE_ACTION_TYPES = new Set(["create_campaign", "create_adset", "create_ad"]);

/**
 * Single source of truth for mutation shape — used by validate() and
 * execute(), mirroring google.ts's buildMutation. v1 cases (budget_update,
 * pause, enable) moved in unchanged, including budget_update's existing
 * rounding division. New cases target Graph v25.0 (all mocked).
 */
function buildMetaMutation(accountRef: string, action: CcActionInput): MetaMutation {
  switch (action.actionType) {
    case "budget_update": {
      const payload = action.payload as { newDailyBudgetMicros: number };
      const minorUnits = Math.round(payload.newDailyBudgetMicros / MICROS_PER_MINOR_UNIT);
      return { path: `/${action.entityRef}`, method: "POST", form: { daily_budget: String(minorUnits) } };
    }
    case "pause":
    case "enable": {
      const form = { status: action.actionType === "pause" ? "PAUSED" : "ACTIVE" };
      return { path: `/${action.entityRef}`, method: "POST", form };
    }
    case "create_campaign": {
      const payload = action.payload as MetaCreateCampaignPayload;
      // Fail-closed belt behind the capabilities gate: never create anything
      // but a PAUSED campaign, regardless of what the payload claims.
      if (payload.status !== "PAUSED") {
        throw new Error(`create_campaign requiere status PAUSED, recibido: ${payload.status}`);
      }
      return {
        path: `/${accountRef}/campaigns`,
        method: "POST",
        form: {
          name: payload.name,
          objective: "OUTCOME_TRAFFIC",
          status: "PAUSED",
          buying_type: "AUCTION",
          special_ad_categories: JSON.stringify(payload.specialAdCategories),
        },
      };
    }
    case "create_adset": {
      const payload = action.payload as MetaCreateAdsetPayload;
      return {
        path: `/${accountRef}/adsets`,
        method: "POST",
        form: {
          name: payload.name,
          campaign_id: payload.campaignRef,
          status: "PAUSED",
          daily_budget: microsToCents(payload.dailyBudgetMicros),
          optimization_goal: "LINK_CLICKS",
          billing_event: "IMPRESSIONS",
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          targeting: JSON.stringify({
            geo_locations: { countries: payload.targeting.countryCodes },
            age_min: payload.targeting.ageMin,
            age_max: payload.targeting.ageMax,
            targeting_automation: { advantage_audience: 0 },
          }),
        },
      };
    }
    case "create_ad": {
      const payload = action.payload as MetaCreateAdPayload;
      const { link, message, headline, description, imageUrl, callToActionType } = payload.creative;
      return {
        path: `/${accountRef}/ads`,
        method: "POST",
        form: {
          name: payload.name,
          adset_id: payload.adsetRef,
          status: "ACTIVE",
          // Inline creative — creates the AdCreative implicitly in this one call.
          creative: JSON.stringify({
            object_story_spec: {
              page_id: requirePageId(),
              link_data: {
                link, message,
                ...(headline ? { name: headline } : {}),
                ...(description ? { description } : {}),
                ...(imageUrl ? { picture: imageUrl } : {}),
                ...(callToActionType ? { call_to_action: { type: callToActionType, value: { link } } } : {}),
              },
            },
          }),
        },
      };
    }
    case "remove_entity": {
      const payload = action.payload as RemoveEntityPayload;
      if (!payload.resourceNames?.length) throw new Error("remove_entity requiere al menos un resourceName.");
      return { path: `/${payload.resourceNames[0]}`, method: "DELETE", form: {} };
    }
    default:
      throw new Error(`Acción no soportada en Meta: ${action.actionType}`);
  }
}

export const metaAdapter: NetworkAdapter = {
  network: "meta_ads",

  capabilities(_auth: AdapterAuth): AdapterCapabilities {
    if (!token()) {
      return { read: false, write: false, actionTypes: [], reason: "META_SYSTEM_USER_TOKEN no configurado (pendiente de credenciales)." };
    }
    const base: CcInternalActionType[] = ["budget_update", "pause", "enable"]; // v1 UNCHANGED
    const canCreate = pageId() && appSecret(); // creates need page + app-secret proof
    return {
      read: true, write: true,
      actionTypes: canCreate ? [...base, "create_campaign", "create_adset", "create_ad", "remove_entity"] : base,
      ...(canCreate ? {} : { reason: "Creación Meta deshabilitada: falta META_PAGE_ID o META_APP_SECRET." }),
    };
  },

  async listCampaigns(_auth, accountRef) {
    const data = await metaGet(`/${accountRef}/campaigns`, {
      fields: "id,name,status,effective_status,daily_budget", limit: "100",
    });
    const rows = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
    return rows.map((c) => ({
      entityKind: "campaign" as const,
      entityRef: String(c.id ?? ""),
      name: typeof c.name === "string" ? c.name : null,
      status: mapStatus(c.status),
      dailyBudgetMicros: c.daily_budget != null ? Number(c.daily_budget) * MICROS_PER_MINOR_UNIT : null,
      learningPhase: "UNKNOWN" as const,
      raw: c,
    }));
  },

  async snapshot(_auth, _accountRef, entityKind, entityRef) {
    const fields = entityKind === "adset"
      ? "id,name,status,effective_status,daily_budget,learning_stage_info"
      : "id,name,status,effective_status,daily_budget";
    const entity = await metaGet(`/${entityRef}`, { fields });
    let signals: { conversions30d: number | null; spend30dMicros: number | null } = { conversions30d: null, spend30dMicros: null };
    try {
      const insights = await metaGet(`/${entityRef}/insights`, { date_preset: "last_30d", fields: "spend,actions" });
      signals = insightsToSignals(insights);
    } catch { /* insights opcionales: sin permiso o sin datos */ }
    return {
      entityKind,
      entityRef,
      name: typeof entity.name === "string" ? entity.name : null,
      status: mapStatus(entity.status),
      dailyBudgetMicros: entity.daily_budget != null ? Number(entity.daily_budget) * MICROS_PER_MINOR_UNIT : null,
      learningPhase: entityKind === "adset" ? mapLearning(entity.learning_stage_info) : "UNKNOWN",
      conversions30d: signals.conversions30d,
      spend30dMicros: signals.spend30dMicros,
      raw: entity,
    };
  },

  // Real validate_only rehearsal, TOTAL (never throws). The remove_entity (and
  // v1) short-circuit is mandatory: rollbackAction (executor.ts) calls
  // prepare() OUTSIDE any try/catch, and its hard-blockers include
  // VALIDATE_ONLY — a throwing validate would strand every create-rollback.
  async validate(_auth, accountRef, action, _before) {
    if (!META_CREATE_ACTION_TYPES.has(action.actionType)) {
      return { ok: true, detail: "sin ensayo (verbo v1 / eliminación)" };
    }
    try {
      const m = buildMetaMutation(accountRef, action);
      await metaPost(m.path, { ...m.form, execution_options: '["validate_only"]' });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "error de validación" };
    }
  },

  async execute(_auth, accountRef, action, _before): Promise<ExecuteResult> {
    const mutation = buildMetaMutation(accountRef, action);
    const response = mutation.method === "DELETE"
      ? await metaDelete(mutation.path)
      : await metaPost(mutation.path, mutation.form);
    const isCreate = META_CREATE_ACTION_TYPES.has(action.actionType);
    return {
      operation: `${mutation.method} ${mutation.path}`,
      request: mutation.form,
      response,
      ...(isCreate ? { resourceNames: [String(response.id)] } : {}),
    };
  },

  // v2.6 sibling read (design spec §a). ONE insights GET at campaign level;
  // follows paging.next AT MOST once (1000-row ceiling) — never loops until
  // exhausted. spend is a decimal string in account currency major units;
  // Math.round(...*MICROS_PER_UNIT) mirrors insightsToSignals exactly.
  // Conversions go through the SAME conversionsFromActions helper as
  // insightsToSignals so the two reads can never diverge on which action
  // types count as a conversion.
  async listCampaignMetrics(_auth, accountRef, range: CcMetricsRange): Promise<CampaignMetrics[]> {
    const datePreset = range === "7d" ? "last_7d" : "last_30d";
    const first = await metaGet(`/${accountRef}/insights`, {
      level: "campaign",
      date_preset: datePreset,
      fields: "campaign_id,spend,clicks,impressions,actions",
      limit: "500",
    });
    const rows: Array<Record<string, unknown>> = [...((first.data as Array<Record<string, unknown>> | undefined) ?? [])];
    const nextUrl = (first.paging as { next?: string } | undefined)?.next;
    if (nextUrl) {
      const second = await metaGetUrl(nextUrl);
      rows.push(...((second.data as Array<Record<string, unknown>> | undefined) ?? []));
    }
    return rows.map((row) => ({
      entityRef: String(row.campaign_id ?? ""),
      spendMicros: Math.round(Number(row.spend ?? 0) * MICROS_PER_UNIT),
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      conversions: conversionsFromActions(row.actions as Array<{ action_type?: string; value?: string }> | undefined),
    }));
  },

  buildRollback(action, beforeSnap, exec): RollbackRecipe | null {
    const common = { entityKind: action.entityKind, entityRef: action.entityRef } as const;
    switch (action.actionType) {
      case "budget_update":
        if (beforeSnap.dailyBudgetMicros == null) return null;
        return { action: { ...common, actionType: "budget_update", payload: { newDailyBudgetMicros: beforeSnap.dailyBudgetMicros } },
                 note: `Restaurar presupuesto a ${beforeSnap.dailyBudgetMicros} micros.` };
      case "pause":
        return { action: { ...common, actionType: "enable", payload: {} }, note: "Reactivar la entidad pausada." };
      case "enable":
        return { action: { ...common, actionType: "pause", payload: {} }, note: "Volver a pausar la entidad." };
      case "create_campaign":
      case "create_adset":
      case "create_ad": {
        // entityRef MUST be the real created id, never action.entityRef (a
        // create's entityRef is the tmp: placeholder) — the v2.3 lesson.
        if (!exec.resourceNames?.length) return null;
        return {
          action: {
            entityKind: action.entityKind, entityRef: exec.resourceNames[0],
            actionType: "remove_entity", payload: { resourceNames: [exec.resourceNames[0]] },
          },
          note: "Eliminar recurso creado en Meta.",
        };
      }
      default:
        return null;
    }
  },
};
