// Centro de Mando — Google Ads adapter. SERVER-ONLY.
// Writes ONLY on connected client accounts via per-connection OAuth tokens
// (AdapterAuth.googleRefreshToken). NEVER reads GOOGLE_ADS_REFRESH_TOKEN.
import { mintAccessToken } from "@/lib/ads-connections";
import type {
  AdapterAuth, AdapterCapabilities, CcActionInput, CcEntityKind,
  EntitySnapshot, ExecuteResult, NetworkAdapter, RollbackRecipe,
} from "../types";

const apiVersion = () => process.env.GOOGLE_ADS_API_VERSION || "v21";
const devToken = () => process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "";
const base = (accountRef: string) =>
  `https://googleads.googleapis.com/${apiVersion()}/customers/${accountRef}`;

async function authHeaders(auth: AdapterAuth): Promise<Record<string, string>> {
  if (!auth.googleRefreshToken) throw new Error("Conexión de Google sin refresh token.");
  const token = await mintAccessToken(auth.googleRefreshToken);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": devToken(),
    "Content-Type": "application/json",
  };
  if (auth.googleLoginCustomerId) headers["login-customer-id"] = auth.googleLoginCustomerId;
  return headers;
}

type GaqlRow = Record<string, Record<string, unknown>>;

async function gaql(auth: AdapterAuth, accountRef: string, query: string): Promise<GaqlRow[]> {
  const res = await fetch(`${base(accountRef)}/googleAds:search`, {
    method: "POST",
    headers: await authHeaders(auth),
    body: JSON.stringify({ query }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Google Ads search ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as { results?: GaqlRow[] };
  return data.results ?? [];
}

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

interface Mutation { endpoint: string; body: Record<string, unknown> }

/** Single source of truth for mutate bodies — used by validate() and execute(). */
function buildMutation(accountRef: string, action: CcActionInput, before: EntitySnapshot): Mutation {
  const campaignRes = `customers/${accountRef}/campaigns/${action.entityRef}`;
  const adGroupRes = `customers/${accountRef}/adGroups/${action.entityRef}`;
  switch (action.actionType) {
    case "budget_update": {
      const payload = action.payload as { newDailyBudgetMicros: number };
      if (!before.budgetResourceName) throw new Error("No se pudo resolver el presupuesto de la campaña.");
      return {
        endpoint: "campaignBudgets:mutate",
        body: {
          operations: [{
            updateMask: "amount_micros",
            update: { resourceName: before.budgetResourceName, amountMicros: String(payload.newDailyBudgetMicros) },
          }],
        },
      };
    }
    case "pause":
    case "enable": {
      const status = action.actionType === "pause" ? "PAUSED" : "ENABLED";
      if (action.entityKind === "ad_group") {
        return { endpoint: "adGroups:mutate", body: { operations: [{ updateMask: "status", update: { resourceName: adGroupRes, status } }] } };
      }
      return { endpoint: "campaigns:mutate", body: { operations: [{ updateMask: "status", update: { resourceName: campaignRes, status } }] } };
    }
    case "add_negatives": {
      const payload = action.payload as { negatives: Array<{ text: string; match: string }> };
      return {
        endpoint: "campaignCriteria:mutate",
        body: {
          partialFailure: true,
          operations: payload.negatives.map((n) => ({
            create: { campaign: campaignRes, negative: true, keyword: { text: n.text, matchType: n.match } },
          })),
        },
      };
    }
    case "remove_negatives": {
      const payload = action.payload as { resourceNames: string[] };
      return { endpoint: "campaignCriteria:mutate", body: { operations: payload.resourceNames.map((rn) => ({ remove: rn })) } };
    }
    default:
      throw new Error(`Acción no soportada en Google: ${action.actionType}`);
  }
}

async function postMutate(auth: AdapterAuth, accountRef: string, mutation: Mutation, extra?: Record<string, unknown>) {
  const res = await fetch(`${base(accountRef)}/${mutation.endpoint}`, {
    method: "POST",
    headers: await authHeaders(auth),
    body: JSON.stringify({ ...mutation.body, ...(extra ?? {}) }),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Ads ${mutation.endpoint} ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

export const googleAdapter: NetworkAdapter = {
  network: "google_ads",

  capabilities(auth: AdapterAuth): AdapterCapabilities {
    if (!auth.googleRefreshToken) {
      return { read: false, write: false, actionTypes: [], reason: "Sin conexión de Google Ads activa (Conexiones)." };
    }
    return { read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives"] };
  },

  async listCampaigns(auth, accountRef) {
    const rows = await gaql(auth, accountRef, `
      SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget,
             campaign_budget.amount_micros, customer.currency_code
      FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`);
    return rows.map((row) => rowToSnapshot("campaign", row));
  },

  async snapshot(auth, accountRef, entityKind, entityRef) {
    if (entityKind === "ad_group") {
      const rows = await gaql(auth, accountRef, `
        SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.id = ${Number(entityRef)}`);
      if (!rows.length) throw new Error(`Grupo de anuncios ${entityRef} no encontrado.`);
      const g = rows[0].adGroup as Record<string, unknown>;
      return { entityKind, entityRef, name: String(g.name ?? ""), status: (g.status as EntitySnapshot["status"]) ?? "UNKNOWN", learningPhase: "UNKNOWN", raw: rows[0] };
    }
    const rows = await gaql(auth, accountRef, `
      SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget,
             campaign_budget.amount_micros, customer.currency_code
      FROM campaign WHERE campaign.id = ${Number(entityRef)}`);
    if (!rows.length) throw new Error(`Campaña ${entityRef} no encontrada.`);
    const snap = rowToSnapshot("campaign", rows[0]);
    const metrics = await gaql(auth, accountRef, `
      SELECT metrics.conversions, metrics.cost_micros
      FROM campaign WHERE campaign.id = ${Number(entityRef)} AND segments.date DURING LAST_30_DAYS`);
    snap.conversions30d = metrics.reduce((acc, r) => acc + num((r.metrics as Record<string, unknown>)?.conversions), 0);
    snap.spend30dMicros = metrics.reduce((acc, r) => acc + num((r.metrics as Record<string, unknown>)?.costMicros), 0);
    return snap;
  },

  async validate(auth, accountRef, action, beforeSnap) {
    try {
      const mutation = buildMutation(accountRef, action, beforeSnap);
      await postMutate(auth, accountRef, { endpoint: mutation.endpoint, body: mutation.body }, { validateOnly: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "error de validación" };
    }
  },

  async execute(auth, accountRef, action, beforeSnap): Promise<ExecuteResult> {
    const mutation = buildMutation(accountRef, action, beforeSnap);
    const response = await postMutate(auth, accountRef, mutation);
    const results = (response.results as Array<{ resourceName?: string }> | undefined) ?? [];
    return {
      operation: mutation.endpoint,
      request: mutation.body,
      response,
      resourceNames: results.map((r) => r.resourceName).filter((r): r is string => Boolean(r)),
    };
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
      case "add_negatives":
        if (!exec.resourceNames?.length) return null;
        return { action: { ...common, actionType: "remove_negatives", payload: { resourceNames: exec.resourceNames } },
                 note: `Eliminar ${exec.resourceNames.length} negativas creadas.` };
      default:
        return null;
    }
  },
};

function rowToSnapshot(entityKind: CcEntityKind, row: GaqlRow): EntitySnapshot {
  const c = (row.campaign ?? {}) as Record<string, unknown>;
  const b = (row.campaignBudget ?? {}) as Record<string, unknown>;
  const cu = (row.customer ?? {}) as Record<string, unknown>;
  return {
    entityKind,
    entityRef: String(c.id ?? ""),
    name: typeof c.name === "string" ? c.name : null,
    status: (c.status as EntitySnapshot["status"]) ?? "UNKNOWN",
    dailyBudgetMicros: b.amountMicros != null ? num(b.amountMicros) : null,
    budgetResourceName: typeof c.campaignBudget === "string" ? c.campaignBudget : null,
    currency: typeof cu.currencyCode === "string" ? cu.currencyCode : null,
    learningPhase: "UNKNOWN",
    raw: row,
  };
}
