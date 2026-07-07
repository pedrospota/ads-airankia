// Centro de Mando — Meta (Facebook) Marketing API adapter. SERVER-ONLY.
// v1 auth: system-user token via META_SYSTEM_USER_TOKEN env; accounts
// allowlisted via META_AD_ACCOUNT_IDS. Without a token the adapter degrades
// to capabilities {write:false} and the UI shows "pendiente de credenciales".
import { createHmac } from "node:crypto";
import type {
  AdapterAuth, AdapterCapabilities,
  EntitySnapshot, ExecuteResult, NetworkAdapter, RollbackRecipe,
} from "../types";
import { MICROS_PER_MINOR_UNIT, MICROS_PER_UNIT } from "../types";

const apiVersion = () => process.env.META_API_VERSION || "v25.0";
const token = () => (process.env.META_SYSTEM_USER_TOKEN ?? "").trim();
const graph = () => `https://graph.facebook.com/${apiVersion()}`;

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

function insightsToSignals(data: unknown): { conversions30d: number | null; spend30dMicros: number | null } {
  const rows = (data as { data?: Array<Record<string, unknown>> })?.data ?? [];
  if (!rows.length) return { conversions30d: null, spend30dMicros: null };
  let conversions = 0;
  let spendMicros = 0;
  for (const row of rows) {
    spendMicros += Math.round(Number(row.spend ?? 0) * MICROS_PER_UNIT);
    for (const action of (row.actions as Array<{ action_type?: string; value?: string }> | undefined) ?? []) {
      if (action.action_type && CONVERSION_ACTIONS.has(action.action_type)) conversions += Number(action.value ?? 0);
    }
  }
  return { conversions30d: conversions, spend30dMicros: spendMicros };
}

export const metaAdapter: NetworkAdapter = {
  network: "meta_ads",

  capabilities(_auth: AdapterAuth): AdapterCapabilities {
    if (!token()) {
      return { read: false, write: false, actionTypes: [], reason: "META_SYSTEM_USER_TOKEN no configurado (pendiente de credenciales)." };
    }
    return { read: true, write: true, actionTypes: ["budget_update", "pause", "enable"] };
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

  async execute(_auth, _accountRef, action, _before): Promise<ExecuteResult> {
    switch (action.actionType) {
      case "budget_update": {
        const payload = action.payload as { newDailyBudgetMicros: number };
        const minorUnits = Math.round(payload.newDailyBudgetMicros / MICROS_PER_MINOR_UNIT);
        const form = { daily_budget: String(minorUnits) };
        const response = await metaPost(`/${action.entityRef}`, form);
        return { operation: `POST /${action.entityRef}`, request: form, response };
      }
      case "pause":
      case "enable": {
        const form = { status: action.actionType === "pause" ? "PAUSED" : "ACTIVE" };
        const response = await metaPost(`/${action.entityRef}`, form);
        return { operation: `POST /${action.entityRef}`, request: form, response };
      }
      default:
        throw new Error(`Acción no soportada en Meta: ${action.actionType}`);
    }
  },

  buildRollback(action, beforeSnap, _exec): RollbackRecipe | null {
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
      default:
        return null;
    }
  },
};
