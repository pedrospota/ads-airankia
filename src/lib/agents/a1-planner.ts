// ============================================================================
// A1 — PLANNER (Estratega)
// ----------------------------------------------------------------------------
// First agent in the Search pipeline. From the raw brand seed (name, website,
// landing page + plain-language hints about objective / geo / budget) it decides
// the campaign foundations: objective, geo & language, daily budget, bidding
// strategy and 3-6 single-intent themes (STAG) that become ad groups downstream.
//
// Model: Opus (this is a "thinking" agent — the strategy everything else builds
// on). Output mirrors PlannerOutput from the FROZEN contract EXACTLY.
//
// Persists one campaign_plans row (version 1, status 'active').
// ============================================================================

import {
  type AgentDefinition,
  type AgentResult,
  type AgentHelpers,
  type RunContext,
  type PlannerOutput,
  BUDGET,
} from "@/lib/engine/types";
import { callStructured, LLMError, defaultAnthropicModel } from "@/lib/llm";
import { adsDb } from "@/lib/ads-db";
import { campaignPlans } from "@/lib/schema";

const PROMPT_VERSION = "a1-planner-v1";
const TEMPERATURE = 0.3;

// ----------------------------------------------------------------------------
// JSON schema — mirrors PlannerOutput from types.ts EXACTLY.
// ----------------------------------------------------------------------------

const INTENT_ENUM = [
  "brand",
  "transactional",
  "commercial",
  "informational",
  "competitor",
  "local",
] as const;

const OBJECTIVE_ENUM = [
  "leads",
  "sales",
  "traffic",
  "calls",
  "awareness",
] as const;

const BIDDING_ENUM = [
  "MANUAL_CPC",
  "MAXIMIZE_CLICKS",
  "MAXIMIZE_CONVERSIONS",
  "TARGET_CPA",
  "MAXIMIZE_CONVERSION_VALUE",
  "TARGET_ROAS",
] as const;

const PLANNER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "objectiveType",
    "objectiveSummary",
    "geo",
    "budget",
    "biddingStrategy",
    "themes",
    "kpis",
    "brandSummary",
    "rationale",
  ],
  properties: {
    objectiveType: {
      type: "string",
      enum: OBJECTIVE_ENUM,
      description: "Primary campaign objective inferred from the brand seed.",
    },
    objectiveSummary: {
      type: "string",
      description:
        "One plain, friendly sentence summarising the objective for the user, written in the brand's main language (the language whose code you put in geo.languageCode).",
    },
    geo: {
      type: "object",
      additionalProperties: false,
      required: ["locations", "countryCodes", "languageCode", "presenceOnly"],
      properties: {
        locations: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Human-readable target locations (cities/regions/countries).",
        },
        countryCodes: {
          type: "array",
          items: { type: "string", minLength: 2, maxLength: 2 },
          minItems: 1,
          description: "ISO-3166 alpha-2 country codes, uppercase (e.g. ES, MX).",
        },
        languageCode: {
          type: "string",
          description: "ISO-639-1 language code, e.g. 'es' or 'en'.",
        },
        presenceOnly: {
          type: "boolean",
          description:
            "true = target people physically IN the location (recommended). Always true here.",
        },
      },
    },
    budget: {
      type: "object",
      additionalProperties: false,
      required: ["dailyUsd", "rationale"],
      properties: {
        dailyUsd: {
          type: "number",
          minimum: BUDGET.minDailyUsd,
          description: "Daily budget in USD. Never below the $1/day minimum.",
        },
        rationale: {
          type: "string",
          description:
            "Plain, friendly justification of the daily budget, in the brand's main language.",
        },
      },
    },
    biddingStrategy: {
      type: "string",
      enum: BIDDING_ENUM,
      description:
        "Default MAXIMIZE_CONVERSIONS for a fresh campaign with conversion tracking.",
    },
    targetCpaUsd: {
      type: "number",
      description: "Only if biddingStrategy is TARGET_CPA.",
    },
    targetRoas: {
      type: "number",
      description: "Only if biddingStrategy is TARGET_ROAS (e.g. 4.0 = 400%).",
    },
    themes: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      description:
        "3-6 single-intent themes; each becomes one tight STAG ad group.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "intent", "description"],
        properties: {
          name: {
            type: "string",
            description: "Short theme name (becomes the ad group name).",
          },
          intent: { type: "string", enum: INTENT_ENUM },
          description: {
            type: "string",
            description:
              "What searcher need this theme captures, in plain language (the brand's main language).",
          },
        },
      },
    },
    kpis: {
      type: "array",
      minItems: 1,
      description: "Primary KPIs with concrete targets.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["primary", "target"],
        properties: {
          primary: { type: "string", description: "KPI name." },
          target: { type: "string", description: "Concrete target value." },
        },
      },
    },
    conversionActionResourceName: {
      type: "string",
      description:
        "Chosen primary conversion action resource name, if one applies.",
    },
    brandSummary: {
      type: "string",
      description:
        "2-4 sentence plain summary of what the brand offers and to whom, in the brand's main language.",
    },
    rationale: {
      type: "string",
      description:
        "Plain explanation of the whole plan for a non-technical owner, in the brand's main language.",
    },
  },
};

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a senior Google Ads (Search) strategist with 15 years of experience",
    "building profitable search campaigns for small and medium businesses. You think",
    "like a consultant who defends every decision to the business owner.",
    "",
    "Your job: from the brand information, define the FOUNDATIONS of a new Search",
    "campaign (objective, geo/language, daily budget, bidding strategy and 3-6",
    "single-intent themes that will become ad groups).",
    "",
    "PRINCIPLES YOU ALWAYS APPLY:",
    "1. STAG (Single Theme Ad Group): each theme captures ONE single, clear and",
    "   well-bounded search intent. No catch-all themes. If you hesitate between",
    "   putting two ideas together, split them. Between 3 and 6 themes.",
    "2. Default bidding strategy: MAXIMIZE_CONVERSIONS. We assume mature conversion",
    "   tracking and ZERO ad history. We do NOT need a Maximize Clicks warm-up. Only",
    "   deviate from MAXIMIZE_CONVERSIONS if the brand info explicitly justifies it",
    "   (e.g. a sales objective with clear conversion value → MAXIMIZE_CONVERSION_VALUE).",
    "3. Geo: presenceOnly ALWAYS true (people PHYSICALLY in the area, not those who",
    "   merely show interest). countryCodes in UPPERCASE ISO-2.",
    "4. Language: use the real language of the target audience and the landing page.",
    "5. Budget: the minimum is 1 USD/day. If the user gives a budget hint, respect it",
    "   (never below the minimum). If there is NO hint, propose a reasonable daily",
    "   budget (~20-50 USD) consistent with the objective and justify it. Money is NOT",
    "   expressed in micros here: use dollars.",
    "6. Objective: pick the one closest to the business intent (leads, sales, traffic,",
    "   calls, awareness). Most service SMBs = leads or calls.",
    "7. KPIs: define metrics with concrete, measurable targets.",
    "",
    "LANGUAGE OF USER-FACING TEXT (objectiveSummary, budget.rationale,",
    "themes[].description, brandSummary, rationale, kpis): write them in the brand's",
    "MAIN language — the language of its website, landing page and the customers it",
    "serves — which is the SAME language whose ISO-639-1 code you put in",
    "geo.languageCode. If the brand serves an English-speaking market, write them in",
    "English; if Spanish, in Spanish; if French, in French; and so on. Keep it simple,",
    "warm and clear for a non-technical business owner. Short sentences, no jargon.",
    "",
    "Return ONLY the structured tool. Do not add any free text.",
  ].join("\n");
}

function buildUserPrompt(ctx: RunContext): string {
  const b = ctx.brand;
  const landing = b.landingPageUrl ?? b.brandWebsite ?? "(not provided)";
  const lines: string[] = [
    "Brand information to plan the Search campaign:",
    "",
    `- Brand name: ${b.brandName}`,
    `- Website: ${b.brandWebsite ?? "(not provided)"}`,
    `- Landing page (where the ads will point): ${landing}`,
  ];
  if (b.description) lines.push(`- Business description: ${b.description}`);
  if (b.industry) lines.push(`- Industry / activity: ${b.industry}`);
  lines.push(
    `- Objective (in their words): ${b.objectiveHint ?? "(not provided)"}`,
    `- Geographic area (in their words): ${b.geoHint ?? "(not provided)"}`,
    `- Language (hint): ${b.languageHint ?? "(not provided)"}`,
    `- Suggested daily budget (USD): ${
      b.budgetHintUsd !== undefined ? b.budgetHintUsd : "(not provided)"
    }`,
    "",
    "Instructions:",
    `- The minimum daily budget is ${BUDGET.minDailyUsd} USD/day.`,
    b.budgetHintUsd !== undefined
      ? `- Respect the suggested budget (${b.budgetHintUsd} USD/day) unless it is below the minimum.`
      : "- No budget hint: propose a reasonable daily budget (~20-50 USD/day) and justify it.",
    "- If there is no geo hint, infer it from the website domain and the language (e.g. a .es domain suggests Spain) and state CLEARLY in objectiveSummary which area you assumed, so the user can correct it if needed.",
    "- Define 3-6 well-bounded single-intent themes (STAG).",
    "- Use MAXIMIZE_CONVERSIONS unless there is an explicit justification against it.",
    "- presenceOnly = true. countryCodes in uppercase ISO-2.",
    "- Decide the brand's main language, put its ISO-639-1 code in geo.languageCode, and write ALL user-facing text (objectiveSummary, budget.rationale, themes[].description, brandSummary, rationale, kpis) in THAT language.",
  );
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Agent
// ----------------------------------------------------------------------------

const a1Planner: AgentDefinition<PlannerOutput> = {
  id: "planner",
  title: "Strategist",
  model: defaultAnthropicModel("planner"),
  kind: "llm",
  promptVersion: PROMPT_VERSION,

  async execute(
    ctx: RunContext,
    helpers: AgentHelpers
  ): Promise<AgentResult<PlannerOutput>> {
    const system = buildSystemPrompt();
    const prompt = buildUserPrompt(ctx);

    let result;
    try {
      result = await callStructured<PlannerOutput>({
        agentId: "planner",
        system,
        prompt,
        schema: PLANNER_SCHEMA,
        toolName: "submit_plan",
        toolDescription:
          "Submit the strategic plan for the Search campaign as a structured object.",
        temperature: TEMPERATURE,
        signal: helpers.signal,
      });
    } catch (err) {
      if (err instanceof LLMError) {
        await helpers.emit("error", { agent: "planner", message: err.message });
      }
      throw err;
    }

    const output = result.data;

    // Persist the versioned plan blob (version 1, active).
    await adsDb.insert(campaignPlans).values({
      campaignId: ctx.campaignId ?? null,
      runId: ctx.run.id,
      version: 1,
      plan: output,
      status: "active",
    });

    await helpers.emit("decision", {
      agent: "planner",
      summary: `Objective "${output.objectiveType}" · ${output.themes.length} themes · ${output.budget.dailyUsd} USD/day · bidding ${output.biddingStrategy} · ${output.geo.locations.join(", ")} (${output.geo.languageCode}).`,
    });
    await helpers.emit("artifact", { output });

    return {
      output,
      rationale: output.rationale,
      model: result.model,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      costMicros: result.costMicros,
    };
  },
};

export default a1Planner;
