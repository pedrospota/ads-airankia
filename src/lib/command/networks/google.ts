// Centro de Mando — Google Ads adapter. SERVER-ONLY.
// Writes ONLY on connected client accounts via per-connection OAuth tokens
// (AdapterAuth.googleRefreshToken). NEVER reads GOOGLE_ADS_REFRESH_TOKEN.
import { mintAccessToken } from "@/lib/ads-connections";
import type {
  AdapterAuth, AdapterCapabilities, CcActionInput, CcEntityKind,
  CreateAdGroupPayload, CreateAdPayload, CreateBudgetPayload, CreateCampaignPayload,
  CreateKeywordsPayload, EntitySnapshot, ExecuteResult, NetworkAdapter,
  RemoveEntityPayload, RollbackRecipe,
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

// Google geoTargetConstants country criteria IDs (slice-1 set = countries in
// Cuentas). Fail-closed: an unmapped country code must THROW, never be
// skipped — skipping a geo criterion means the campaign targets the whole
// world, the opposite of what was proposed/approved.
const COUNTRY_GEO: Record<string, string> = {
  MX: "2484", ES: "2724", US: "2840", AR: "2032", CO: "2170", CL: "2152", PE: "2604",
};

/** v2 BiddingStrategy is only these 3. Payload already carries micros/ratio directly — do NOT re-multiply. */
function biddingFields(bidding: CreateCampaignPayload["bidding"]): Record<string, unknown> {
  switch (bidding.strategy) {
    case "MAXIMIZE_CONVERSIONS":
      return { maximizeConversions: {} };
    case "TARGET_CPA":
      return { maximizeConversions: { targetCpaMicros: String(bidding.targetCpaMicros) } };
    case "TARGET_ROAS":
      return { maximizeConversionValue: { targetRoas: bidding.targetRoas } };
    default:
      throw new Error(`Estrategia de puja no soportada: ${(bidding as { strategy: string }).strategy}`);
  }
}

/**
 * Resolves blueprint country codes to Google geoTargetConstant ids. Fail-closed:
 * throws on a missing/empty list or an unmapped code. Called from BOTH
 * buildMutation's create_campaign case (so validate()/validateOnly catches a bad
 * code before any live mutation) and buildCampaignCriteriaMutation (execute-time,
 * step 2) — a single source of truth so the two can never disagree.
 */
function resolveCountryGeoIds(codes: string[] | undefined): string[] {
  if (!codes?.length) {
    throw new Error("create_campaign requiere al menos un geoTargetId (evita orientación mundial).");
  }
  return codes.map((code) => {
    const geoId = COUNTRY_GEO[code];
    if (!geoId) throw new Error(`País no soportado: ${code}`);
    return geoId;
  });
}

/**
 * create_campaign step 2 — geo + language CampaignCriterion mutate, built AT
 * EXECUTE TIME from the just-created campaign's resourceName. Cannot be
 * validateOnly'd pre-create (the campaign doesn't exist yet), so this is
 * intentionally NOT routed through buildMutation/validate(). Geo-code
 * resolution is fail-closed and shared with buildMutation (see
 * resolveCountryGeoIds) so an unmapped code is caught at validate() time too.
 */
function buildCampaignCriteriaMutation(campaignResourceName: string, payload: CreateCampaignPayload): Mutation {
  const geoIds = resolveCountryGeoIds(payload.geoTargetIds);
  const geoOps = geoIds.map((geoId) => (
    { create: { campaign: campaignResourceName, location: { geoTargetConstant: `geoTargetConstants/${geoId}` } } }
  ));
  const langOps = payload.languageId
    ? [{ create: { campaign: campaignResourceName, language: { languageConstant: `languageConstants/${payload.languageId}` } } }]
    : [];
  return { endpoint: "campaignCriteria:mutate", body: { operations: [...geoOps, ...langOps] } };
}

// remove_entity routes by the resourceName segment to the owning service.
// Order doesn't matter for correctness here (segments are mutually
// exclusive substrings), but keep the more specific ones first for clarity.
const REMOVE_ENDPOINTS: ReadonlyArray<readonly [string, string]> = [
  ["/campaignBudgets/", "campaignBudgets:mutate"],
  ["/campaignCriteria/", "campaignCriteria:mutate"],
  ["/adGroupCriteria/", "adGroupCriteria:mutate"],
  ["/adGroupAds/", "adGroupAds:mutate"],
  ["/adGroups/", "adGroups:mutate"],
  ["/campaigns/", "campaigns:mutate"],
];

function endpointForResourceName(resourceName: string): string {
  const match = REMOVE_ENDPOINTS.find(([segment]) => resourceName.includes(segment));
  if (!match) throw new Error(`No se pudo inferir el servicio de eliminación para: ${resourceName}`);
  return match[1];
}

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
            updateMask: "amountMicros",
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
    case "create_budget": {
      const payload = action.payload as CreateBudgetPayload;
      return {
        endpoint: "campaignBudgets:mutate",
        body: {
          operations: [{
            create: { name: payload.name, amountMicros: String(payload.amountMicros), deliveryMethod: "STANDARD" },
          }],
        },
      };
    }
    case "create_campaign": {
      // Step 1 ONLY (campaign create). Geo/language criteria are a SEPARATE
      // mutate built at execute time from the campaign's resourceName — see
      // buildCampaignCriteriaMutation. validate() therefore only rehearses
      // this step, which is correct: the criteria step references a campaign
      // that doesn't exist yet and cannot be validateOnly'd pre-create.
      const payload = action.payload as CreateCampaignPayload;
      // Fail-closed: resolve geo codes NOW (throws on an unmapped code or a
      // missing geoTargetIds list) so validate()'s validateOnly rehearsal
      // rejects a bad blueprint before ANY live mutation. Step 2 (the
      // campaignCriteria mutate) can't itself be validateOnly'd pre-create —
      // this is the only pre-execution gate for its geo codes. The campaign
      // body below is unchanged; resolveCountryGeoIds is called purely for
      // its throw.
      resolveCountryGeoIds(payload.geoTargetIds);
      return {
        endpoint: "campaigns:mutate",
        body: {
          operations: [{
            create: {
              name: payload.name,
              status: "PAUSED", // SAFETY: never anything else on create.
              advertisingChannelType: payload.channel ?? "SEARCH",
              campaignBudget: payload.budgetRef,
              networkSettings: {
                targetGoogleSearch: true, targetSearchNetwork: false,
                targetContentNetwork: false, targetPartnerSearchNetwork: false,
              },
              geoTargetTypeSetting: {
                positiveGeoTargetType: payload.presenceOnly ? "PRESENCE" : "PRESENCE_OR_INTEREST",
                negativeGeoTargetType: "PRESENCE",
              },
              ...biddingFields(payload.bidding),
            },
          }],
        },
      };
    }
    case "create_ad_group": {
      const payload = action.payload as CreateAdGroupPayload;
      return {
        endpoint: "adGroups:mutate",
        body: {
          operations: [{
            create: {
              name: payload.name,
              campaign: payload.campaignRef,
              type: "SEARCH_STANDARD",
              status: "ENABLED", // ad group enabled; the PAUSED campaign is the delivery gate.
              ...(payload.cpcBidMicros != null ? { cpcBidMicros: payload.cpcBidMicros } : {}),
            },
          }],
        },
      };
    }
    case "create_keywords": {
      const payload = action.payload as CreateKeywordsPayload;
      const positives = payload.keywords.filter((kw) => !kw.negative);
      const negatives = payload.keywords.filter((kw) => kw.negative);
      return {
        endpoint: "adGroupCriteria:mutate",
        body: {
          operations: [
            ...positives.map((kw) => ({
              create: { adGroup: payload.adGroupRef, status: "ENABLED", keyword: { text: kw.text, matchType: kw.match } },
            })),
            ...negatives.map((kw) => ({
              create: { adGroup: payload.adGroupRef, negative: true, keyword: { text: kw.text, matchType: kw.match } },
            })),
          ],
        },
      };
    }
    case "create_ad": {
      const payload = action.payload as CreateAdPayload;
      return {
        endpoint: "adGroupAds:mutate",
        body: {
          operations: [{
            create: {
              adGroup: payload.adGroupRef,
              status: "ENABLED", // ad enabled; the PAUSED campaign is the ONLY delivery gate.
              ad: {
                finalUrls: [payload.finalUrl],
                responsiveSearchAd: {
                  headlines: payload.headlines.map((h) => ({ text: h.text, ...(h.pinnedField ? { pinnedField: h.pinnedField } : {}) })),
                  descriptions: payload.descriptions.map((d) => ({ text: d.text })),
                  ...(payload.path1 ? { path1: payload.path1 } : {}),
                  ...(payload.path2 ? { path2: payload.path2 } : {}),
                },
              },
            },
          }],
        },
      };
    }
    case "remove_entity": {
      const payload = action.payload as RemoveEntityPayload;
      if (!payload.resourceNames?.length) throw new Error("remove_entity requiere al menos un resourceName.");
      const endpoint = endpointForResourceName(payload.resourceNames[0]);
      const mixed = payload.resourceNames.some((rn) => endpointForResourceName(rn) !== endpoint);
      if (mixed) throw new Error("remove_entity: los resourceNames mezclan distintos servicios.");
      return { endpoint, body: { operations: payload.resourceNames.map((rn) => ({ remove: rn })) } };
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
    return {
      read: true, write: true,
      actionTypes: [
        "budget_update", "pause", "enable", "add_negatives", "remove_negatives",
        "create_budget", "create_campaign", "create_ad_group", "create_keywords", "create_ad", "remove_entity",
      ],
    };
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
    const resourceNames = results.map((r) => r.resourceName).filter((r): r is string => Boolean(r));

    if (action.actionType === "create_campaign") {
      // Two-step create: the campaign body above is step 1. Geo + language
      // criteria (step 2) can ONLY be built now, from the campaign's real
      // resourceName — skipping this step means whole-world targeting.
      const campaignResourceName = resourceNames[0];
      if (!campaignResourceName) throw new Error("Google Ads no devolvió el resourceName de la campaña creada.");
      const criteriaMutation = buildCampaignCriteriaMutation(campaignResourceName, action.payload as CreateCampaignPayload);
      let criteriaResponse: Record<string, unknown>;
      try {
        criteriaResponse = await postMutate(auth, accountRef, criteriaMutation);
      } catch (e) {
        // Atomicity: step 2 failed (unmapped geo slipping past validate(), a
        // transient API error, etc.) — the campaign from step 1 is now live and
        // has no rollback recipe (buildRollback never ran). Compensate with a
        // best-effort delete so it doesn't orphan, then rethrow naming the
        // campaign so the caller/ops can verify. The compensating delete's own
        // failure must never mask the original error.
        const message = e instanceof Error ? e.message : "error desconocido";
        try {
          await postMutate(auth, accountRef, {
            endpoint: "campaigns:mutate",
            body: { operations: [{ remove: campaignResourceName }] },
          });
        } catch { /* best-effort compensation; original error below is authoritative */ }
        throw new Error(`create_campaign falló al aplicar segmentación; campaña ${campaignResourceName} revertida: ${message}`);
      }
      const criteriaResults = (criteriaResponse.results as Array<{ resourceName?: string }> | undefined) ?? [];
      const criteriaResourceNames = criteriaResults.map((r) => r.resourceName).filter((r): r is string => Boolean(r));
      return {
        operation: mutation.endpoint,
        request: mutation.body,
        response: { campaign: response, campaignCriteria: criteriaResponse },
        // Campaign FIRST — the runner resolves resourceNames[0] as the tmp: for this action's localRef.
        resourceNames: [campaignResourceName, ...criteriaResourceNames],
      };
    }

    return { operation: mutation.endpoint, request: mutation.body, response, resourceNames };
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
      case "create_campaign": {
        // Only the campaign — its criteria cascade-delete with it. Removing a
        // criterion after its parent campaign is gone errors, so never list
        // exec.resourceNames[1..] (the criteria) here.
        // entityRef MUST be the real created resourceName, never action.entityRef
        // (a create's entityRef is the tmp: placeholder) — otherwise the rollback's
        // own prepare() either rejects it (tmp:-guard) or tries to snapshot() a
        // non-numeric ref and throws.
        if (!exec.resourceNames?.length) return null;
        return { action: { ...common, entityRef: exec.resourceNames[0], actionType: "remove_entity", payload: { resourceNames: [exec.resourceNames[0]] } },
                 note: "Eliminar recurso creado." };
      }
      case "create_budget":
      case "create_ad_group":
      case "create_keywords":
      case "create_ad": {
        // Same reasoning as create_campaign: entityRef must be a real resourceName.
        // payload keeps ALL created resourceNames (e.g. create_keywords can create
        // many criteria in one action) — only entityRef takes the first as a
        // representative single value.
        if (!exec.resourceNames?.length) return null;
        return { action: { ...common, entityRef: exec.resourceNames[0], actionType: "remove_entity", payload: { resourceNames: exec.resourceNames } },
                 note: "Eliminar recurso creado." };
      }
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
