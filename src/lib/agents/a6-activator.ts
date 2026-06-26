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
  type PlannedAdGroup,
  type AdGroupAds,
  type PlannedKeyword,
  type BiddingStrategy,
} from "@/lib/engine/types";

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
const GEO_TARGET_CONSTANTS: Record<string, string> = {
  ES: "2724",
  MX: "2484",
  AR: "2032",
  CO: "2170",
  CL: "2152",
  PE: "2604",
  US: "2840",
  GB: "2826",
  FR: "2250",
  DE: "2276",
  IT: "2380",
  PT: "2620",
};

// ISO language code -> Google Ads languageConstant id.
const LANGUAGE_CONSTANTS: Record<string, string> = {
  es: "1003",
  en: "1000",
  fr: "1002",
  de: "1001",
  it: "1004",
  pt: "1014",
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
  body: Record<string, unknown>
): Promise<MutateResponse> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/${endpoint}:mutate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as MutateResponse;
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data;
}

function idFromResourceName(resourceName: string): string {
  return resourceName.split("/").pop() ?? "";
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
      return { manualCpc: { enhancedCpcEnabled: false } };
  }
}

// ----------------------------------------------------------------------------
// Google match-type enum mapping (our union is already the v19 enum).
// ----------------------------------------------------------------------------

function matchTypeEnum(mt: PlannedKeyword["matchType"]): string {
  return mt; // EXACT | PHRASE | BROAD are the v19 KeywordMatchType values
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

  // RSA lookup by ad-group name (A4 pairs to A3 by name).
  const adsByGroup = new Map<string, AdGroupAds>();
  for (const a of rsa.ads) adsByGroup.set(a.adGroupName, a);

  // --- IDEMPOTENCY GUARD ----------------------------------------------------
  // runStep() only short-circuits on COMPLETED; a FAILED activator step is
  // re-run from scratch. If a previous attempt already created the budget +
  // campaign in Google (googleCampaignId persisted), NEVER create a second one.
  // Resume from the existing campaign instead of duplicating live resources.
  const [existing] = await adsDb
    .select({ googleCampaignId: campaigns.googleCampaignId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignDbId))
    .limit(1);
  const priorCampaignId = existing?.googleCampaignId ?? null;
  const resuming = priorCampaignId != null;

  // --- (1) Budget -----------------------------------------------------------
  const dailyUsd = Math.max(planner.budget.dailyUsd, BUDGET.minDailyUsd);
  const dailyMicros = Math.max(
    Math.round(dailyUsd * MICROS_PER_UNIT),
    MICROS_PER_UNIT
  );

  let budgetResourceName = "";
  if (!resuming) {
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
  if (resuming) {
    // A campaign already exists in Google from a prior attempt — reuse it.
    googleCampaignId = String(priorCampaignId);
    campaignResourceName = `customers/${CUSTOMER_ID}/campaigns/${googleCampaignId}`;
    mutationLog.push(
      await logMutation(
        runId,
        campaignDbId,
        "createCampaign",
        "done",
        campaignResourceName,
        "resumed: existing googleCampaignId"
      )
    );
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
            ...biddingPayload(
              structure.biddingStrategy ?? planner.biddingStrategy,
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

  // Persist campaign google ids + bidding onto the existing draft row.
  await adsDb
    .update(campaigns)
    .set({
      googleCampaignId: googleCampaignId ? Number(googleCampaignId) : null,
      googleAccountId: CUSTOMER_ID,
      biddingStrategy: structure.biddingStrategy ?? planner.biddingStrategy,
      targetCpaMicros:
        planner.targetCpaUsd && planner.targetCpaUsd > 0
          ? Math.round(planner.targetCpaUsd * MICROS_PER_UNIT)
          : null,
      targetRoas:
        planner.targetRoas && planner.targetRoas > 0
          ? String(planner.targetRoas)
          : null,
      status: "paused",
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignDbId));

  // --- (3) Geo + language criteria (campaign-level) -------------------------
  const geoOps = (planner.geo.countryCodes ?? [])
    .map((c) => GEO_TARGET_CONSTANTS[c?.toUpperCase()])
    .filter((id): id is string => Boolean(id))
    .map((id) => ({
      create: {
        campaign: campaignResourceName,
        location: { geoTargetConstant: `geoTargetConstants/${id}` },
      },
    }));

  const langId =
    LANGUAGE_CONSTANTS[planner.geo.languageCode?.toLowerCase()] ??
    LANGUAGE_CONSTANTS.es;
  const langOp = {
    create: {
      campaign: campaignResourceName,
      language: { languageConstant: `languageConstants/${langId}` },
    },
  };

  // Skip on resume: these campaign-level criteria were already created on the
  // first attempt and would duplicate against the reused campaign.
  if (!resuming && (geoOps.length > 0 || langOp)) {
    await mutate("campaignCriteria", {
      operations: [...geoOps, langOp],
    });
    mutationLog.push(
      await logMutation(runId, campaignDbId, "addCampaignCriteria", "done")
    );
  }

  // --- (4) Ad groups + keywords + negatives + RSAs --------------------------
  const adGroupResults: ActivatorOutput["adGroups"] = [];
  let keywordsAdded = 0;
  let negativesAdded = 0;
  let adsCreated = 0;

  for (const group of structure.adGroups as PlannedAdGroup[]) {
    const cpcMicros =
      group.defaultCpcUsd && group.defaultCpcUsd > 0
        ? String(Math.round(group.defaultCpcUsd * MICROS_PER_UNIT))
        : "100000"; // $0.10 fallback

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
    const agResourceName = agResp.results?.[0]?.resourceName ?? "";
    const agId = idFromResourceName(agResourceName);
    adGroupResults.push({
      name: group.name,
      resourceName: agResourceName,
      id: agId,
    });
    mutationLog.push(
      await logMutation(
        runId,
        campaignDbId,
        "createAdGroup",
        "done",
        agResourceName
      )
    );

    // Find the existing draft ad_group row by (campaign, name) and update ids.
    const [agRow] = await adsDb
      .select({ id: adGroups.id })
      .from(adGroups)
      .where(
        and(eq(adGroups.campaignId, campaignDbId), eq(adGroups.name, group.name))
      )
      .limit(1);
    const adGroupDbId = agRow?.id ?? null;
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

    // Positive keywords for this group.
    if (group.keywords.length > 0) {
      const kwResp = await mutate("adGroupCriteria", {
        operations: group.keywords.map((kw) => ({
          create: {
            adGroup: agResourceName,
            status: "ENABLED",
            keyword: { text: kw.text, matchType: matchTypeEnum(kw.matchType) },
          },
        })),
      });
      const created = kwResp.results?.length ?? group.keywords.length;
      keywordsAdded += created;
      mutationLog.push(
        await logMutation(runId, campaignDbId, "addKeywords", "done")
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
    }

    // Ad-group-level negative keywords.
    if (group.negativeKeywords.length > 0) {
      await mutate("adGroupCriteria", {
        operations: group.negativeKeywords.map((nk) => ({
          create: {
            adGroup: agResourceName,
            negative: true,
            keyword: { text: nk.text, matchType: matchTypeEnum(nk.matchType) },
          },
        })),
      });
      negativesAdded += group.negativeKeywords.length;
      mutationLog.push(
        await logMutation(runId, campaignDbId, "addAdGroupNegatives", "done")
      );
    }

    // RSA for this group.
    const groupAds = adsByGroup.get(group.name);
    if (groupAds) {
      const adResp = await mutate("adGroupAds", {
        operations: [
          {
            create: {
              adGroup: agResourceName,
              status: "PAUSED", // ads paused too; campaign is the delivery gate
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
      adsCreated += 1;
      mutationLog.push(
        await logMutation(
          runId,
          campaignDbId,
          "createAd",
          "done",
          adResourceName
        )
      );

      // adGroupAds resource name is "customers/X/adGroupAds/{adGroupId}~{adId}".
      const adId = idFromResourceName(adResourceName).split("~").pop() ?? "";
      if (adGroupDbId) {
        // A4 already persisted exactly one draft search_ads row per ad group
        // (it OWNS ad copy). Update that row to live instead of inserting a
        // second one — otherwise every ad group ends with two rows.
        const [existingAd] = await adsDb
          .select({ id: searchAds.id })
          .from(searchAds)
          .where(
            and(
              eq(searchAds.adGroupId, adGroupDbId),
              eq(searchAds.campaignId, campaignDbId)
            )
          )
          .limit(1);

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
    }

    await helpers.emit("step_progress", {
      agent: AGENT_ID,
      adGroup: group.name,
    });
  }

  // --- (5) Campaign-level shared negatives ----------------------------------
  if (structure.sharedNegatives.length > 0) {
    await mutate("campaignCriteria", {
      operations: structure.sharedNegatives.map((nk) => ({
        create: {
          campaign: campaignResourceName,
          negative: true,
          keyword: { text: nk.text, matchType: matchTypeEnum(nk.matchType) },
        },
      })),
    });
    negativesAdded += structure.sharedNegatives.length;
    mutationLog.push(
      await logMutation(runId, campaignDbId, "addCampaignNegatives", "done")
    );
  }

  const output: ActivatorOutput = {
    campaignResourceName,
    googleCampaignId,
    budgetResourceName,
    adGroups: adGroupResults,
    keywordsAdded,
    negativesAdded,
    adsCreated,
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
