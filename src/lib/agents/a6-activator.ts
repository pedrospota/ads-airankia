// ============================================================================
// A6 — ACTIVATOR  (code agent, NO LLM)
// ----------------------------------------------------------------------------
// The last step of the pipeline. Reads the WHOLE plan (planner + structure +
// rsa) and pushes a real SEARCH campaign to Google Ads — ALWAYS PAUSED.
//
// SAFETY (hard invariants, see types.ts + repo rules):
//   - A Search campaign is created PAUSED and stays PAUSED. This agent NEVER
//     enables anything; enabling lives behind the dedicated /enable chokepoint.
//   - ActivatorOutput.status is ALWAYS "PAUSED".
//   - All DB writes go to adsDb (Postgres) only. Supabase is never written.
//
// CONTRACT (see src/lib/engine/types.ts): export default an AgentDefinition.
// OUTPUT = ActivatorOutput. Persists google ids onto the existing campaign /
// ad_group / keyword / search_ad rows and appends a google_mutations ledger.
// ============================================================================

import { adsDb } from "@/lib/ads-db";
import {
  campaigns,
  adGroups,
  keywords,
  searchAds,
  googleMutations,
} from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import {
  MICROS_PER_UNIT,
  BUDGET,
  type AgentDefinition,
  type AgentResult,
  type AgentHelpers,
  type RunContext,
  type ActivatorOutput,
  type ActivatorMutationLogEntry,
  type PlannedKeyword,
  type BiddingStrategy,
  type KeywordResearchOutput,
} from "@/lib/engine/types";
import { buildSanitizedPlan } from "@/lib/engine/sanitize";

const AGENT_ID = "activator" as const;
const PROMPT_VERSION = "a6-activator@1";

// ----------------------------------------------------------------------------
// Google Ads REST v19 — minimal Search-mutation client.
// Mirrors the auth/header conventions of src/lib/google-ads.ts (which is
// Display-only and not extended here). Self-contained so the Search path never
// crosses the Display path.
// ----------------------------------------------------------------------------

const CUSTOMER_ID = process.env.GOOGLE_ADS_ACCOUNT_ID || "3531706003";
const MCC_ID = process.env.GOOGLE_ADS_MCC_ID || "9539861409";
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET ?? "";
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "";
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN ?? "";

const BASE = `https://googleads.googleapis.com/v19/customers/${CUSTOMER_ID}`;

// ISO-3166 alpha-2 -> Google Ads geoTargetConstant id (country level).
// Google's country-level geoTargetConstant id == 2000 + the ISO-3166-1 numeric
// code (verified: ES=724→2724, MX=484→2484, US=840→2840, GB=826→2826, ...). We
// keep an explicit, auditable table (rather than computing) so every value can
// be reviewed, and we cover every realistic market so a planner's country pick
// is NEVER silently dropped (which would leave the campaign targeting the whole
// world — a spend risk). See the fail-closed guard in activate().
const GEO_TARGET_CONSTANTS: Record<string, string> = {
  // — Iberia & the Spanish-speaking Americas (primary markets) —
  ES: "2724", PT: "2620",
  MX: "2484", AR: "2032", CO: "2170", CL: "2152", PE: "2604",
  VE: "2862", EC: "2218", BO: "2068", PY: "2600", UY: "2858",
  CR: "2188", PA: "2591", DO: "2214", GT: "2320", HN: "2340",
  SV: "2222", NI: "2558", PR: "2630", CU: "2192",
  // — North America —
  US: "2840", CA: "2124",
  // — Brazil —
  BR: "2076",
  // — Western & Northern Europe —
  GB: "2826", IE: "2372", FR: "2250", DE: "2276", IT: "2380",
  NL: "2528", BE: "2056", LU: "2442", CH: "2756", AT: "2040",
  DK: "2208", SE: "2752", NO: "2578", FI: "2246", IS: "2352",
  // — Central, Eastern & Southern Europe —
  PL: "2616", CZ: "2203", SK: "2703", HU: "2348", RO: "2642",
  BG: "2100", GR: "2300", HR: "2191", SI: "2705", RS: "2688",
  EE: "2233", LV: "2428", LT: "2440", UA: "2804", TR: "2792",
  // — Asia-Pacific —
  AU: "2036", NZ: "2554", JP: "2392", CN: "2156", IN: "2356",
  KR: "2410", SG: "2702", HK: "2344", PH: "2608", ID: "2360",
  MY: "2458", TH: "2764", VN: "2704",
  // — Middle East & Africa —
  AE: "2784", SA: "2682", IL: "2376", EG: "2818", MA: "2504",
  ZA: "2710",
};

// ISO language code -> Google Ads languageConstant id (well-known stable ids).
const LANGUAGE_CONSTANTS: Record<string, string> = {
  en: "1000", de: "1001", fr: "1002", es: "1003", it: "1004",
  ja: "1005", da: "1009", nl: "1010", fi: "1011", ko: "1012",
  no: "1013", nb: "1013", pt: "1014", sv: "1015",
  cs: "1021", el: "1022", hu: "1024", pl: "1030", ru: "1031",
  ro: "1032",
};

let cachedAccessToken: { token: string; expires: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expires) {
    return cachedAccessToken.token;
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    throw new Error(`OAuth token refresh failed: ${resp.status}`);
  }
  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedAccessToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "developer-token": DEVELOPER_TOKEN,
    "login-customer-id": MCC_ID,
    "Content-Type": "application/json",
  };
}

interface MutateResult {
  resourceName?: string;
}
interface MutateResponse {
  results?: MutateResult[];
  error?: unknown;
  partialFailureError?: unknown;
}

/** POST a `${endpoint}:mutate` body and return the typed response. */
async function mutate(
  endpoint: string,
  body: Record<string, unknown>,
  opts?: { tolerateDuplicates?: boolean }
): Promise<MutateResponse> {
  const token = await getAccessToken();
  // tolerateDuplicates: for NON-CRITICAL, naturally-idempotent batches (negative
  // keywords) the caller opts into per-operation tolerance. We request
  // partialFailure so VALID operations still apply, and we DON'T throw on the
  // resulting per-operation errors — a criterion that already exists from a
  // prior attempt is exactly what we want to ignore. This is what makes
  // re-sending negatives on a resume safe even when the ledger key changed
  // across a deploy (the negatives have no durable DB id to gate on).
  const finalBody = opts?.tolerateDuplicates
    ? { ...body, partialFailure: true }
    : body;
  const resp = await fetch(`${BASE}/${endpoint}:mutate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(finalBody),
  });
  const data = (await resp.json()) as MutateResponse;
  // A top-level error is always fatal (auth, malformed request, the whole batch
  // rejected): surface it.
  if (data.error) throw new Error(JSON.stringify(data.error));
  // For a NORMAL mutate, never treat a partially-applied batch as success —
  // surface it so the run stops with a clear error instead of leaving a
  // half-built campaign live. For a tolerant mutate we deliberately swallow
  // per-operation failures (campaign stays PAUSED; negatives are an
  // optimization, never a delivery gate).
  if (data.partialFailureError && !opts?.tolerateDuplicates) {
    throw new Error(JSON.stringify(data.partialFailureError));
  }
  return data;
}

function idFromResourceName(resourceName: string): string {
  return resourceName.split("/").pop() ?? "";
}

/**
 * POST a GAQL query to `googleAds:search` and return the rows. READ-ONLY —
 * never mutates the account. Mirrors `mutate`'s auth/headers. Used to inspect
 * the account (e.g. whether conversions are measured) before deciding bidding.
 */
async function search(query: string): Promise<Record<string, unknown>[]> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/googleAds:search`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ query }),
  });
  const data = (await resp.json()) as {
    results?: Record<string, unknown>[];
    error?: unknown;
  };
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.results ?? [];
}

/**
 * True when the account MEASURES conversions (has at least one ENABLED
 * conversion action). Smart Bidding (Maximize Conversions / tCPA / Maximize
 * Conversion Value / tROAS) can only optimize when conversions are tracked; on
 * a brand-new account with nothing set up, such a campaign barely serves. We
 * use this to fall back to Maximize Clicks so the campaign ALWAYS drives
 * traffic. Read-only.
 */
async function accountHasEligibleConversions(): Promise<boolean> {
  const rows = await search(
    "SELECT conversion_action.resource_name FROM conversion_action " +
      "WHERE conversion_action.status = 'ENABLED' LIMIT 1"
  );
  return rows.length > 0;
}

/**
 * Reflect (NOT create) whether the account already measures conversions, so the
 * UI can tell the user the TRUTH ("ya mides conversiones") instead of guessing.
 * Strictly READ-ONLY against Google: it reads the first ENABLED conversion
 * action and, if one exists, stamps the campaign row with its resource name so
 * downstream (Optimize / Performance Max) knows what it measures. Creating a
 * conversion action is an explicit, account-level decision that lives behind the
 * user — it is deliberately NOT done here.
 *
 * The returned `enabled` boolean is a fresh, build-time snapshot and is what
 * drives the UI's honesty, so a stale campaign stamp can never make the UI lie.
 *
 * Best-effort: the WHOLE body is inside the outer try, so ANY failure (the
 * Google read, OAuth, the DB write) returns {enabled:false} and NEVER throws
 * into the activation flow. Measurement is an enhancement, never the critical
 * path — the campaign is already safely created (PAUSED) before this runs.
 */
async function reflectConversionMeasurement(
  campaignDbId: string
): Promise<{ enabled: boolean; resourceName?: string }> {
  try {
    const rows = await search(
      "SELECT conversion_action.resource_name " +
        "FROM conversion_action WHERE conversion_action.status = 'ENABLED' LIMIT 1"
    );
    const ca = rows[0]?.conversionAction as { resourceName?: string } | undefined;
    const resourceName = ca?.resourceName;
    if (!resourceName) return { enabled: false };

    // Stamp the campaign (adsDb only, never Supabase) so downstream knows what
    // it measures. Idempotent on resume (deterministic value) and isolated in
    // its own try/catch so a write failure can never flip `enabled` to false.
    try {
      await adsDb
        .update(campaigns)
        .set({ conversionActionResourceName: resourceName, updatedAt: new Date() })
        .where(eq(campaigns.id, campaignDbId));
    } catch {
      // Best-effort stamp; the boolean below is what the UI needs.
    }
    return { enabled: true, resourceName };
  } catch {
    return { enabled: false };
  }
}

/** Bidding strategies that need conversion measurement to work at all. */
function isConversionStrategy(s: BiddingStrategy): boolean {
  return (
    s === "MAXIMIZE_CONVERSIONS" ||
    s === "TARGET_CPA" ||
    s === "MAXIMIZE_CONVERSION_VALUE" ||
    s === "TARGET_ROAS"
  );
}

// ----------------------------------------------------------------------------
// Assets / extensions — collapse whitespace and clamp to Google's hard limits.
// Truncation can only make a borderline asset valid, so it's always safe.
// ----------------------------------------------------------------------------

function clamp(s: string | undefined | null, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max).trim();
}

// Structured-snippet headers are validated by Google per campaign language. We
// only emit a snippet for languages whose canonical header we know for certain;
// any other language simply skips the snippet (the other assets still apply).
const SNIPPET_HEADERS: Record<string, string> = {
  es: "Servicios",
  en: "Services",
};

/**
 * Create a batch of assets of ONE type and link them to the campaign. Returns
 * the number actually linked. Isolated per type by the caller so one type's
 * rejection never blocks the others. Assets are an ENHANCEMENT — callers treat
 * any throw as non-fatal (the campaign itself is already created).
 */
async function createLinkedAssets(
  campaignResourceName: string,
  fieldType: "SITELINK" | "CALLOUT" | "STRUCTURED_SNIPPET",
  createBodies: Record<string, unknown>[]
): Promise<number> {
  if (createBodies.length === 0) return 0;
  const assetResp = await mutate("assets", {
    operations: createBodies.map((b) => ({ create: b })),
  });
  const names = (assetResp.results ?? [])
    .map((r) => r.resourceName ?? "")
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return 0;
  await mutate("campaignAssets", {
    operations: names.map((asset) => ({
      create: { campaign: campaignResourceName, asset, fieldType },
    })),
  });
  return names.length;
}

// ----------------------------------------------------------------------------
// Bidding payload — maps our BiddingStrategy union onto the v19 campaign field.
// ----------------------------------------------------------------------------

function biddingPayload(
  strategy: BiddingStrategy,
  targetCpaUsd?: number,
  targetRoas?: number
): Record<string, unknown> {
  switch (strategy) {
    case "MANUAL_CPC":
      return { manualCpc: { enhancedCpcEnabled: false } };
    case "MAXIMIZE_CLICKS":
      // MAXIMIZE_CLICKS maps to a TargetSpend portfolio-less strategy.
      return { targetSpend: {} };
    case "MAXIMIZE_CONVERSIONS":
      return { maximizeConversions: {} };
    case "TARGET_CPA":
      return {
        maximizeConversions:
          targetCpaUsd && targetCpaUsd > 0
            ? { targetCpaMicros: String(Math.round(targetCpaUsd * MICROS_PER_UNIT)) }
            : {},
      };
    case "MAXIMIZE_CONVERSION_VALUE":
      return { maximizeConversionValue: {} };
    case "TARGET_ROAS":
      return {
        maximizeConversionValue:
          targetRoas && targetRoas > 0 ? { targetRoas } : {},
      };
    default:
      // Unknown/unsupported value: fall to MAXIMIZE_CLICKS (targetSpend), the
      // safest default for a fresh account — it reliably drives traffic without
      // needing conversion history. NEVER silently fall to MANUAL_CPC, which a
      // non-expert would have to manage by hand.
      return { targetSpend: {} };
  }
}

// ----------------------------------------------------------------------------
// Google match-type enum mapping (our union is already the v19 enum).
// ----------------------------------------------------------------------------

function matchTypeEnum(mt: PlannedKeyword["matchType"]): string {
  return mt; // EXACT | PHRASE | BROAD are the v19 KeywordMatchType values
}

// ----------------------------------------------------------------------------
// Opening CPC for an ad group. Prefer the architect's chosen CPC; otherwise
// derive it from A2's REAL top-of-page bid estimates for this group's keywords
// (median); otherwise a market-realistic floor. Under Smart Bidding this value
// is ignored, but under MANUAL_CPC a flat $0.10 sits far below market and the
// ads would simply never show — so we never open below ~$0.40.
// ----------------------------------------------------------------------------

function resolveCpcMicros(
  group: { defaultCpcUsd?: number; keywords: PlannedKeyword[] },
  keywordEstimates: KeywordResearchOutput | undefined
): string {
  if (group.defaultCpcUsd && group.defaultCpcUsd > 0) {
    return String(Math.round(group.defaultCpcUsd * MICROS_PER_UNIT));
  }
  const texts = new Set(group.keywords.map((k) => k.text.toLowerCase()));
  const bids = (keywordEstimates?.keywords ?? [])
    .filter((k) => texts.has(k.text.toLowerCase()))
    .map((k) => k.topOfPageBidLowMicros)
    .filter((n): n is number => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);
  if (bids.length > 0) {
    const median = bids[Math.floor((bids.length - 1) / 2)];
    return String(Math.max(median, 400000));
  }
  return "400000"; // $0.40 realistic floor (was a flat $0.10 that won't show).
}

// ----------------------------------------------------------------------------
// Ledger helper — append one google_mutations row per Google call.
// ----------------------------------------------------------------------------

async function logMutation(
  runId: string,
  campaignId: string | null,
  operation: string,
  status: "done" | "failed",
  resourceName?: string,
  detail?: string
): Promise<ActivatorMutationLogEntry> {
  await adsDb.insert(googleMutations).values({
    runId,
    campaignId,
    operation,
    resourceName: resourceName ?? null,
    status: status === "done" ? "done" : "failed",
    response: detail ? ({ detail } as object) : null,
  });
  return { operation, resourceName, status, detail };
}

// ----------------------------------------------------------------------------
// Execute
// ----------------------------------------------------------------------------

async function activate(
  ctx: RunContext,
  helpers: AgentHelpers
): Promise<ActivatorOutput> {
  const { planner, structure, rsa } = ctx;
  const campaignDbId = ctx.campaignId ?? ctx.run.campaignId ?? null;

  if (!planner) throw new Error("Falta la salida del estratega (planner).");
  if (!structure) throw new Error("Falta la estructura de la campaña.");
  if (!rsa) throw new Error("Faltan los anuncios (RSA).");
  if (!campaignDbId) {
    throw new Error("No hay campaña en la base de datos para activar.");
  }

  const runId = ctx.run.id;
  const mutationLog: ActivatorMutationLogEntry[] = [];

  // --- PRE-FLIGHT SANITIZE & VALIDATE (before ANY Google write) -------------
  // Protects the budget: dedupes keywords, normalizes landing URLs to https,
  // clamps RSAs to Google's limits, and drops any ad group that can't be built
  // cleanly. If nothing survives, fail BEFORE creating a single live resource —
  // so the account is never left with a half-built, money-spending campaign.
  const plan = buildSanitizedPlan(structure, rsa, ctx.brand);
  if (plan.adGroups.length === 0) {
    throw new Error(
      "No se puede publicar la campaña: ningún grupo de anuncios quedó completo (faltan palabras clave, anuncios o enlaces válidos). Revisa los pasos anteriores."
    );
  }
  if (plan.skipped.length > 0) {
    await helpers.emit("decision", {
      agent: AGENT_ID,
      summary: `Se omitieron ${plan.skipped.length} grupo(s) por datos incompletos: ${plan.skipped
        .map((s) => `${s.name} (${s.reason})`)
        .join("; ")}.`,
    });
  }

  // --- PRE-FLIGHT GEO (resolve target locations BEFORE any Google write) -----
  // The planner picks countryCodes; map each to a Google geoTargetConstant id.
  // FAIL CLOSED: if NOT ONE location resolves, stop here with a clear message
  // instead of creating a campaign with no location criterion — which Google
  // treats as "the whole world" and would put the budget at risk. Stopping is
  // always safer than silently targeting everywhere.
  const geoTargetIds = Array.from(
    new Set(
      (planner.geo.countryCodes ?? [])
        .map((c) => GEO_TARGET_CONSTANTS[(c ?? "").toUpperCase()])
        .filter((id): id is string => Boolean(id))
    )
  );
  if (geoTargetIds.length === 0) {
    throw new Error(
      "No pudimos determinar la zona geográfica de la campaña, así que la hemos detenido para no mostrar tus anuncios en todo el mundo y gastar de más. Revisa la ubicación en el paso del estratega."
    );
  }
  // presenceOnly (planner decides; default true): show ads to people PHYSICALLY
  // in the target area, not merely those interested in it. Honoured below via
  // the campaign's geoTargetTypeSetting (Google's account default would
  // otherwise be PRESENCE_OR_INTEREST — the opposite of what we promise).
  const presenceOnly = planner.geo.presenceOnly !== false;

  // --- IDEMPOTENCY / RESUME -------------------------------------------------
  // runStep() only short-circuits a COMPLETED step; a FAILED activator step is
  // re-run from scratch. Google does NOT dedupe by name, so a naive re-run would
  // create DUPLICATE ad groups / keywords / ads, and the old "skip everything if
  // a campaign exists" guard could skip GEO on a mid-build failure (= worldwide
  // targeting, a real overspend risk). We make EVERY Google write idempotent:
  // each successful write is recorded in the google_mutations ledger under a
  // stable per-resource key, and on a retry we SKIP and REUSE whatever already
  // succeeded. Durable DB ids (googleAdgroupId / googleAdId / keyword
  // status='live') are a SECOND signal, so even a run that failed under older
  // code (before these keys existed) resumes without duplicating.
  const [existing] = await adsDb
    .select({ googleCampaignId: campaigns.googleCampaignId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignDbId))
    .limit(1);
  const priorCampaignId = existing?.googleCampaignId ?? null;

  const priorMutations = await adsDb
    .select({
      operation: googleMutations.operation,
      resourceName: googleMutations.resourceName,
    })
    .from(googleMutations)
    .where(
      and(
        eq(googleMutations.runId, runId),
        eq(googleMutations.status, "done")
      )
    );
  const doneOps = new Map<string, string | null>();
  for (const m of priorMutations) {
    if (!doneOps.has(m.operation)) {
      doneOps.set(m.operation, m.resourceName ?? null);
    }
  }
  const isDone = (op: string): boolean => doneOps.has(op);
  const doneRN = (op: string): string => doneOps.get(op) ?? "";
  // Record a REUSED resource in the in-memory log without re-writing the ledger.
  const noteReused = (operation: string, resourceName?: string): void => {
    mutationLog.push({
      operation,
      resourceName,
      status: "done",
      detail: "reanudado",
    });
  };

  // The campaign already exists from a prior attempt iff the ledger recorded the
  // create OR the draft row already carries a googleCampaignId.
  const campaignAlreadyCreated =
    isDone("createCampaign") || priorCampaignId != null;

  // --- CONVERSION-AWARE BIDDING (decided automatically, no user input) -------
  // The planner may pick a Smart Bidding strategy (Maximize Conversions, tCPA,
  // Maximize Conversion Value, tROAS). Those ONLY work if the account measures
  // conversions; on a fresh account with none, such a campaign barely serves
  // and the user's budget would do nothing. So on a FIRST create we ask Google
  // whether any conversion is tracked; if not, we downgrade to Maximize Clicks
  // (targetSpend), which reliably drives traffic with no conversion history,
  // and we explain the choice in plain Spanish. On resume we keep whatever the
  // existing campaign already uses (we never re-read or change a live strategy).
  const plannedStrategy: BiddingStrategy =
    structure.biddingStrategy ?? planner.biddingStrategy;
  let effectiveStrategy: BiddingStrategy = plannedStrategy;
  let conversionDowngradeApplied = false;
  if (!campaignAlreadyCreated && isConversionStrategy(plannedStrategy)) {
    // On a read error, KEEP the planner's choice (default true): we must never
    // silently downgrade a real advertiser's account that DOES measure
    // conversions just because a single read hiccuped. The downgrade exists
    // only to RESCUE an account we positively confirm has zero conversions.
    const hasConversions = await accountHasEligibleConversions().catch(
      () => true
    );
    if (!hasConversions) {
      effectiveStrategy = "MAXIMIZE_CLICKS";
      conversionDowngradeApplied = true;
      await helpers.emit("decision", {
        agent: AGENT_ID,
        summary:
          "Tu cuenta todavía no mide conversiones, así que hemos elegido una puja que consigue el máximo de visitas con tu presupuesto. Cuando empieces a medir conversiones podremos optimizar para conseguir clientes, no solo visitas.",
      });
    }
  }

  // --- (1) Budget -----------------------------------------------------------
  const dailyUsd = Math.max(planner.budget.dailyUsd, BUDGET.minDailyUsd);
  const dailyMicros = Math.max(
    Math.round(dailyUsd * MICROS_PER_UNIT),
    MICROS_PER_UNIT
  );

  let budgetResourceName = "";
  if (isDone("createBudget")) {
    // Reuse the budget from a prior attempt — never create a second one (that
    // would orphan the first). A campaign that failed AFTER its budget was
    // created relinks to that same budget on resume.
    budgetResourceName = doneRN("createBudget");
    noteReused("createBudget", budgetResourceName);
  } else {
    const budgetResp = await mutate("campaignBudgets", {
      operations: [
        {
          create: {
            name: `${structure.campaignName} — presupuesto`,
            amountMicros: String(dailyMicros),
            deliveryMethod: "STANDARD",
          },
        },
      ],
    });
    budgetResourceName = budgetResp.results?.[0]?.resourceName ?? "";
    mutationLog.push(
      await logMutation(
        runId,
        campaignDbId,
        "createBudget",
        "done",
        budgetResourceName
      )
    );
  }

  // --- (2) Campaign (Search, ALWAYS PAUSED) ---------------------------------
  let campaignResourceName: string;
  let googleCampaignId: string;
  if (campaignAlreadyCreated) {
    // A campaign already exists in Google from a prior attempt — reuse it.
    // Prefer the persisted googleCampaignId; fall back to the ledger's resource
    // name if the row never got persisted (older failed run).
    googleCampaignId =
      priorCampaignId != null
        ? String(priorCampaignId)
        : idFromResourceName(doneRN("createCampaign"));
    campaignResourceName =
      doneRN("createCampaign") ||
      `customers/${CUSTOMER_ID}/campaigns/${googleCampaignId}`;
    noteReused("createCampaign", campaignResourceName);
  } else {
    const campaignResp = await mutate("campaigns", {
      operations: [
        {
          create: {
            name: structure.campaignName,
            status: "PAUSED", // SAFETY: never ENABLED here.
            advertisingChannelType: "SEARCH",
            campaignBudget: budgetResourceName,
            networkSettings: {
              targetGoogleSearch: true,
              targetSearchNetwork: false,
              targetContentNetwork: false,
              targetPartnerSearchNetwork: false,
            },
            // Honour presenceOnly: PRESENCE = only people IN the area. This is
            // the field the planner's presenceOnly decision maps onto; without
            // it Google defaults to PRESENCE_OR_INTEREST (paying for out-of-area
            // interest traffic), the opposite of what we tell the user.
            geoTargetTypeSetting: {
              positiveGeoTargetType: presenceOnly
                ? "PRESENCE"
                : "PRESENCE_OR_INTEREST",
              negativeGeoTargetType: "PRESENCE",
            },
            ...biddingPayload(
              effectiveStrategy,
              planner.targetCpaUsd,
              planner.targetRoas
            ),
          },
        },
      ],
    });
    campaignResourceName = campaignResp.results?.[0]?.resourceName ?? "";
    googleCampaignId = idFromResourceName(campaignResourceName);
    mutationLog.push(
      await logMutation(
        runId,
        campaignDbId,
        "createCampaign",
        "done",
        campaignResourceName
      )
    );
  }

  // Persist campaign google ids onto the existing draft row. On a FIRST create
  // we also persist the EFFECTIVE bidding actually created in Google (may differ
  // from the planner's pick if we downgraded for a no-conversion account). On
  // resume we DON'T touch bidding — the live campaign already has whatever the
  // first attempt set, and we never re-read or change a live strategy.
  await adsDb
    .update(campaigns)
    .set({
      googleCampaignId: googleCampaignId ? Number(googleCampaignId) : null,
      googleAccountId: CUSTOMER_ID,
      ...(campaignAlreadyCreated
        ? {}
        : {
            biddingStrategy: effectiveStrategy,
            // A target CPA/ROAS only makes sense under a conversion strategy; if
            // we downgraded to Maximize Clicks, store null so the UI never shows
            // a phantom target that isn't actually in effect.
            targetCpaMicros:
              isConversionStrategy(effectiveStrategy) &&
              planner.targetCpaUsd &&
              planner.targetCpaUsd > 0
                ? Math.round(planner.targetCpaUsd * MICROS_PER_UNIT)
                : null,
            targetRoas:
              isConversionStrategy(effectiveStrategy) &&
              planner.targetRoas &&
              planner.targetRoas > 0
                ? String(planner.targetRoas)
                : null,
          }),
      status: "paused",
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignDbId));

  // --- (3) Geo + language criteria (campaign-level) -------------------------
  // geoTargetIds was resolved AND validated as non-empty in pre-flight, so we
  // never reach here with zero locations (which would mean worldwide targeting).
  const geoOps = geoTargetIds.map((id) => ({
    create: {
      campaign: campaignResourceName,
      location: { geoTargetConstant: `geoTargetConstants/${id}` },
    },
  }));

  const langId =
    LANGUAGE_CONSTANTS[(planner.geo.languageCode ?? "").toLowerCase()] ??
    LANGUAGE_CONSTANTS.es;
  const langOp = {
    create: {
      campaign: campaignResourceName,
      language: { languageConstant: `languageConstants/${langId}` },
    },
  };

  // Create geo+language criteria unless THIS specific write already succeeded.
  // CRITICAL: gating on "campaign exists" (the old behaviour) skipped geo
  // whenever the campaign was reused — so a failure AFTER campaign-create but
  // BEFORE geo left the campaign targeting the WHOLE WORLD on every retry. Gate
  // on the criteria write itself so geo is ALWAYS applied exactly once.
  if (!isDone("addCampaignCriteria")) {
    await mutate("campaignCriteria", {
      operations: [...geoOps, langOp],
    });
    mutationLog.push(
      await logMutation(runId, campaignDbId, "addCampaignCriteria", "done")
    );
  } else {
    noteReused("addCampaignCriteria");
  }

  // --- (4) Ad groups + keywords + negatives + RSAs --------------------------
  // EVERY write below is idempotent. Each logical resource has a stable ledger
  // key (e.g. "createAdGroup:<name>") and, where possible, a durable DB id as a
  // second signal. On a retry we SKIP and REUSE whatever already succeeded, so a
  // mid-build failure can never produce a duplicate ad group, keyword set, or ad.
  const adGroupResults: ActivatorOutput["adGroups"] = [];

  for (const { group, ad: groupAds } of plan.adGroups) {
    // Find the existing draft ad_group row first (A3 created exactly one per
    // name). Its googleAdgroupId is a resume signal even if the ledger is empty.
    const [agRow] = await adsDb
      .select({ id: adGroups.id, googleAdgroupId: adGroups.googleAdgroupId })
      .from(adGroups)
      .where(
        and(eq(adGroups.campaignId, campaignDbId), eq(adGroups.name, group.name))
      )
      .limit(1);
    const adGroupDbId = agRow?.id ?? null;

    const agKey = `createAdGroup:${group.name}`;
    const agAlready = isDone(agKey) || agRow?.googleAdgroupId != null;

    let agResourceName: string;
    let agId: string;
    if (agAlready) {
      agId =
        agRow?.googleAdgroupId != null
          ? String(agRow.googleAdgroupId)
          : idFromResourceName(doneRN(agKey));
      agResourceName =
        doneRN(agKey) || `customers/${CUSTOMER_ID}/adGroups/${agId}`;
      noteReused(agKey, agResourceName);
    } else {
      const cpcMicros = resolveCpcMicros(group, ctx.keywords);
      const agResp = await mutate("adGroups", {
        operations: [
          {
            create: {
              name: group.name,
              campaign: campaignResourceName,
              type: "SEARCH_STANDARD",
              status: "ENABLED", // ad group enabled; the CAMPAIGN gates delivery (PAUSED)
              cpcBidMicros: cpcMicros,
            },
          },
        ],
      });
      agResourceName = agResp.results?.[0]?.resourceName ?? "";
      agId = idFromResourceName(agResourceName);
      mutationLog.push(
        await logMutation(runId, campaignDbId, agKey, "done", agResourceName)
      );
    }

    adGroupResults.push({
      name: group.name,
      resourceName: agResourceName,
      id: agId,
    });

    if (adGroupDbId) {
      await adsDb
        .update(adGroups)
        .set({
          googleAdgroupId: agId ? Number(agId) : null,
          status: "live",
          updatedAt: new Date(),
        })
        .where(eq(adGroups.id, adGroupDbId));
    }

    // Positive keywords for this group. Skip if already added on a prior attempt
    // (ledger key OR any keyword row for this group already marked live).
    const kwKey = `addKeywords:${group.name}`;
    let kwAlready = isDone(kwKey);
    if (!kwAlready && adGroupDbId) {
      const [liveKw] = await adsDb
        .select({ id: keywords.id })
        .from(keywords)
        .where(
          and(eq(keywords.adGroupId, adGroupDbId), eq(keywords.status, "live"))
        )
        .limit(1);
      kwAlready = Boolean(liveKw);
    }
    if (group.keywords.length > 0 && !kwAlready) {
      await mutate("adGroupCriteria", {
        operations: group.keywords.map((kw) => ({
          create: {
            adGroup: agResourceName,
            status: "ENABLED",
            keyword: { text: kw.text, matchType: matchTypeEnum(kw.matchType) },
          },
        })),
      });
      mutationLog.push(
        await logMutation(runId, campaignDbId, kwKey, "done")
      );

      // Mark the matching keyword rows as live (by ad_group + text + matchType).
      if (adGroupDbId) {
        for (const kw of group.keywords) {
          await adsDb
            .update(keywords)
            .set({ status: "live" })
            .where(
              and(
                eq(keywords.adGroupId, adGroupDbId),
                eq(keywords.text, kw.text),
                eq(keywords.matchType, kw.matchType)
              )
            );
        }
      }
    } else if (group.keywords.length > 0) {
      noteReused(kwKey);
    }

    // Ad-group-level negative keywords. Ledger-gated, and tolerant of duplicates
    // so a cross-deploy resume (where the ledger key changed and negatives have
    // no durable DB id) can re-send them without a hard duplicate error.
    const negKey = `addAdGroupNegatives:${group.name}`;
    if (group.negativeKeywords.length > 0 && !isDone(negKey)) {
      await mutate(
        "adGroupCriteria",
        {
          operations: group.negativeKeywords.map((nk) => ({
            create: {
              adGroup: agResourceName,
              negative: true,
              keyword: { text: nk.text, matchType: matchTypeEnum(nk.matchType) },
            },
          })),
        },
        { tolerateDuplicates: true }
      );
      mutationLog.push(
        await logMutation(runId, campaignDbId, negKey, "done")
      );
    } else if (group.negativeKeywords.length > 0) {
      noteReused(negKey);
    }

    // RSA for this group (always present & valid: the sanitizer guarantees it).
    // Skip if already created (ledger key OR the group's search_ads row already
    // carries a googleAdId).
    if (groupAds) {
      const adKey = `createAd:${group.name}`;
      const [existingAd] = adGroupDbId
        ? await adsDb
            .select({ id: searchAds.id, googleAdId: searchAds.googleAdId })
            .from(searchAds)
            .where(
              and(
                eq(searchAds.adGroupId, adGroupDbId),
                eq(searchAds.campaignId, campaignDbId)
              )
            )
            .limit(1)
        : [];
      const adAlready = isDone(adKey) || existingAd?.googleAdId != null;
      if (!adAlready) {
        const adResp = await mutate("adGroupAds", {
          operations: [
            {
              create: {
                adGroup: agResourceName,
                // Ad ENABLED on purpose. The CAMPAIGN (created PAUSED above) is
                // the ONLY delivery gate. If the ad were PAUSED, /enable — which
                // flips just the campaign to ENABLED — would leave every ad
                // paused and the campaign would serve ZERO ads with no error.
                // Enabling the ad here is safe: nothing serves until the user
                // enables the campaign.
                status: "ENABLED",
                ad: {
                  finalUrls: [groupAds.finalUrl],
                  responsiveSearchAd: {
                    headlines: groupAds.headlines.map((h) => ({
                      text: h.text,
                      ...(h.pinnedField ? { pinnedField: h.pinnedField } : {}),
                    })),
                    descriptions: groupAds.descriptions.map((d) => ({
                      text: d.text,
                      ...(d.pinnedField ? { pinnedField: d.pinnedField } : {}),
                    })),
                    ...(groupAds.path1 ? { path1: groupAds.path1 } : {}),
                    ...(groupAds.path2 ? { path2: groupAds.path2 } : {}),
                  },
                },
              },
            },
          ],
        });
        const adResourceName = adResp.results?.[0]?.resourceName ?? "";
        mutationLog.push(
          await logMutation(runId, campaignDbId, adKey, "done", adResourceName)
        );

        // adGroupAds resource name is "customers/X/adGroupAds/{adGroupId}~{adId}".
        const adId = idFromResourceName(adResourceName).split("~").pop() ?? "";
        if (adGroupDbId) {
          // A4 already persisted exactly one draft search_ads row per ad group
          // (it OWNS ad copy). Update that row to live instead of inserting a
          // second one — otherwise every ad group ends with two rows.
          if (existingAd) {
            await adsDb
              .update(searchAds)
              .set({
                googleAdId: adId ? Number(adId) : null,
                status: "live",
                updatedAt: new Date(),
              })
              .where(eq(searchAds.id, existingAd.id));
          } else {
            await adsDb.insert(searchAds).values({
              adGroupId: adGroupDbId,
              campaignId: campaignDbId,
              headlines: groupAds.headlines as unknown as object,
              descriptions: groupAds.descriptions as unknown as object,
              finalUrls: [groupAds.finalUrl],
              path1: groupAds.path1 ?? null,
              path2: groupAds.path2 ?? null,
              googleAdId: adId ? Number(adId) : null,
              status: "live",
            });
          }
        }
      } else {
        noteReused(adKey);
      }
    }

    await helpers.emit("step_progress", {
      agent: AGENT_ID,
      adGroup: group.name,
    });
  }

  // --- (5) Campaign-level shared negatives ----------------------------------
  // Ledger-gated; tolerant of duplicates for the same reason as ad-group
  // negatives (idempotent, non-critical, no durable DB id to gate on).
  if (plan.sharedNegatives.length > 0 && !isDone("addCampaignNegatives")) {
    await mutate(
      "campaignCriteria",
      {
        operations: plan.sharedNegatives.map((nk) => ({
          create: {
            campaign: campaignResourceName,
            negative: true,
            keyword: { text: nk.text, matchType: matchTypeEnum(nk.matchType) },
          },
        })),
      },
      { tolerateDuplicates: true }
    );
    mutationLog.push(
      await logMutation(runId, campaignDbId, "addCampaignNegatives", "done")
    );
  } else if (plan.sharedNegatives.length > 0) {
    noteReused("addCampaignNegatives");
  }

  // --- (6) Assets / extensions (sitelinks, callouts, structured snippets) ----
  // Auto-generated from the plan (no user input) to lift ad strength & Quality
  // Score — every serious competitor attaches these. SAFETY: assets are an
  // ENHANCEMENT, never the critical resource, so each type is created in its own
  // isolated try/catch and ANY failure just logs and continues (the campaign is
  // already safely created above). Skipped on resume to avoid duplicates. We
  // reuse ONLY copy that already passed Policy-QA (RSA headlines/descriptions,
  // ad-group names) so no new, unverified claims are ever introduced.
  let assetsLinked = 0;
  const assetKinds: string[] = [];
  // Assets are the LAST Google writes and each type is isolated in its own
  // try/catch (they never throw), so a resume only reaches here when they were
  // not yet created on an earlier attempt. Each type is still ledger-gated below
  // so a partial asset pass can never duplicate on retry. (Gating the WHOLE
  // section on "campaign exists" would permanently skip assets on every resumed
  // build — the same class of bug as the worldwide-geo one above.)
  {
    // Sitelinks — one per ad group (Google shows them with >=2). Link text =
    // ad-group name; description1/2 = the group's RSA descriptions (both or
    // neither, per Google's rule); final URL = the group's landing page.
    const sitelinkBodies: Record<string, unknown>[] = [];
    const sitelinkSeen = new Set<string>();
    for (const { group, ad } of plan.adGroups.slice(0, 4)) {
      const linkText = clamp(group.name, 25);
      if (!linkText) continue;
      // Dedupe link text: two identically-named groups would otherwise make
      // Google collapse the assets and reject the duplicate campaign link.
      const linkKey = linkText.toLowerCase();
      if (sitelinkSeen.has(linkKey)) continue;
      sitelinkSeen.add(linkKey);
      const d1 = clamp(ad.descriptions[0]?.text, 35);
      const d2 = clamp(ad.descriptions[1]?.text, 35);
      const sitelinkAsset: Record<string, unknown> = { linkText };
      if (d1 && d2) {
        sitelinkAsset.description1 = d1;
        sitelinkAsset.description2 = d2;
      }
      sitelinkBodies.push({ finalUrls: [ad.finalUrl], sitelinkAsset });
    }
    if (sitelinkBodies.length >= 2 && !isDone("addSitelinks")) {
      try {
        const n = await createLinkedAssets(
          campaignResourceName,
          "SITELINK",
          sitelinkBodies
        );
        if (n > 0) {
          assetsLinked += n;
          assetKinds.push("enlaces a tu web");
          mutationLog.push(
            await logMutation(runId, campaignDbId, "addSitelinks", "done")
          );
        }
      } catch (e) {
        mutationLog.push(
          await logMutation(
            runId,
            campaignDbId,
            "addSitelinks",
            "failed",
            undefined,
            e instanceof Error ? e.message : "fallo al añadir enlaces"
          )
        );
      }
    }

    // Callouts — short value props, reusing QA-approved headlines that already
    // fit the 25-char limit WITHOUT truncation (truncated callouts read badly).
    const calloutSeen = new Set<string>();
    const calloutBodies: Record<string, unknown>[] = [];
    for (const { ad } of plan.adGroups) {
      for (const h of ad.headlines) {
        const t = (h.text ?? "").trim();
        if (t.length === 0 || t.length > 25) continue;
        const key = t.toLowerCase();
        if (calloutSeen.has(key)) continue;
        calloutSeen.add(key);
        calloutBodies.push({ calloutAsset: { calloutText: t } });
        if (calloutBodies.length >= 6) break;
      }
      if (calloutBodies.length >= 6) break;
    }
    if (calloutBodies.length >= 2 && !isDone("addCallouts")) {
      try {
        const n = await createLinkedAssets(
          campaignResourceName,
          "CALLOUT",
          calloutBodies
        );
        if (n > 0) {
          assetsLinked += n;
          assetKinds.push("textos destacados");
          mutationLog.push(
            await logMutation(runId, campaignDbId, "addCallouts", "done")
          );
        }
      } catch (e) {
        mutationLog.push(
          await logMutation(
            runId,
            campaignDbId,
            "addCallouts",
            "failed",
            undefined,
            e instanceof Error ? e.message : "fallo al añadir textos destacados"
          )
        );
      }
    }

    // Structured snippet — header by language (only known headers), values =
    // ad-group names as the service/category list (Google needs >=3 values).
    const snippetHeader =
      SNIPPET_HEADERS[(planner.geo.languageCode ?? "es").toLowerCase()] ?? null;
    if (snippetHeader && !isDone("addStructuredSnippet")) {
      const snippetSeen = new Set<string>();
      const snippetValues: string[] = [];
      for (const { group } of plan.adGroups) {
        const v = clamp(group.name, 25);
        if (!v) continue;
        const key = v.toLowerCase();
        if (snippetSeen.has(key)) continue;
        snippetSeen.add(key);
        snippetValues.push(v);
        if (snippetValues.length >= 10) break;
      }
      if (snippetValues.length >= 3) {
        try {
          const n = await createLinkedAssets(
            campaignResourceName,
            "STRUCTURED_SNIPPET",
            [
              {
                structuredSnippetAsset: {
                  header: snippetHeader,
                  values: snippetValues,
                },
              },
            ]
          );
          if (n > 0) {
            assetsLinked += n;
            assetKinds.push("lista de servicios");
            mutationLog.push(
              await logMutation(
                runId,
                campaignDbId,
                "addStructuredSnippet",
                "done"
              )
            );
          }
        } catch (e) {
          mutationLog.push(
            await logMutation(
              runId,
              campaignDbId,
              "addStructuredSnippet",
              "failed",
              undefined,
              e instanceof Error ? e.message : "fallo al añadir la lista"
            )
          );
        }
      }
    }

    if (assetsLinked > 0) {
      mutationLog.push(
        await logMutation(
          runId,
          campaignDbId,
          "addAssets",
          "done",
          undefined,
          `${assetsLinked} extensiones (${assetKinds.join(", ")})`
        )
      );
      await helpers.emit("decision", {
        agent: AGENT_ID,
        summary: `Añadimos extensiones automáticas (${assetKinds.join(
          ", "
        )}) para que tu anuncio sea más completo y de mayor calidad, sin que tengas que hacer nada.`,
      });
    }
  }

  // Final totals are derived from the SANITIZED PLAN, not incremented as we go,
  // so the success summary is correct whether the campaign was built in one pass
  // or finished across a resume (where some groups were reused, not re-created).
  const keywordsAdded = plan.adGroups.reduce(
    (n, { group }) => n + group.keywords.length,
    0
  );
  const adsCreated = plan.adGroups.filter(({ ad }) => Boolean(ad)).length;
  const negativesAdded =
    plan.adGroups.reduce((n, { group }) => n + group.negativeKeywords.length, 0) +
    plan.sharedNegatives.length;

  // Read-only: does this account already measure conversions? Stamps the
  // campaign with the action it measures. Never creates anything, never throws —
  // the campaign is already safely created above.
  const measurement = await reflectConversionMeasurement(campaignDbId);

  const output: ActivatorOutput = {
    campaignResourceName,
    googleCampaignId,
    budgetResourceName,
    adGroups: adGroupResults,
    keywordsAdded,
    negativesAdded,
    adsCreated,
    assetsLinked,
    assetKinds,
    conversionDowngradeApplied,
    conversionTrackingEnabled: measurement.enabled,
    conversionActionResourceName: measurement.resourceName,
    status: "PAUSED", // SAFETY: always paused.
    mutationLog,
  };

  return output;
}

// ----------------------------------------------------------------------------
// Agent definition
// ----------------------------------------------------------------------------

const a6Activator: AgentDefinition<ActivatorOutput> = {
  id: AGENT_ID,
  title: "Activador",
  model: null, // code-only agent, no LLM
  kind: "code",
  promptVersion: PROMPT_VERSION,

  async execute(
    ctx: RunContext,
    helpers: AgentHelpers
  ): Promise<AgentResult<ActivatorOutput>> {
    await helpers.emit("step_progress", {
      agent: AGENT_ID,
      message: "Publicando la campaña en Google Ads (en PAUSA)...",
    });

    const output = await activate(ctx, helpers);

    await helpers.emit("decision", {
      agent: AGENT_ID,
      summary: `Campaña publicada EN PAUSA: ${output.adGroups.length} grupos, ${output.keywordsAdded} keywords, ${output.adsCreated} anuncios.`,
    });

    await helpers.emit("artifact", { output });

    return {
      output,
      rationale:
        "Campaña creada en Google Ads en estado PAUSA. La activación real es un paso aparte y explícito.",
      model: null,
      tokensIn: 0,
      tokensOut: 0,
      costMicros: 0,
    };
  },
};

export default a6Activator;
