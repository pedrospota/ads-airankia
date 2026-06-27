// ============================================================================
// A3 — STRUCTURE ARCHITECT (Opus)
// ----------------------------------------------------------------------------
// Turns the planner's objective + the keyword researcher's vetted keywords into
// a tight, single-theme-per-ad-group (STAG) campaign tree, plus the negative
// keyword scaffolding that keeps each group from cannibalising the others.
//
// This agent OWNS the structure rows. For the chosen tree it persists:
//   - one ad_groups row per planned ad group  (status 'proposed')
//   - one keywords row per planned keyword     (status 'proposed')
//   - negative_keywords rows for ad-group negatives + campaign shared negatives
//
// Money is micros (USD * MICROS_PER_UNIT). Nothing here is enabled or pushed to
// Google — A3 only proposes structure. Writes go to adsDb only.
// ============================================================================

import { callStructured, LLMError, defaultAnthropicModel } from "@/lib/llm";
import { adsDb } from "@/lib/ads-db";
import { adGroups, keywords, negativeKeywords } from "@/lib/schema";
import {
  MICROS_PER_UNIT,
  languageName,
  type AgentDefinition,
  type RunContext,
  type AgentHelpers,
  type AgentResult,
  type StructureOutput,
  type PlannedAdGroup,
  type PlannedKeyword,
  type KeywordIdea,
  type JSONSchema,
} from "@/lib/engine/types";

const PROMPT_VERSION = "a3-structure-architect@1";
const AGENT_ID = "structure_architect" as const;

// ----------------------------------------------------------------------------
// Output JSON schema — mirrors StructureOutput EXACTLY.
// ----------------------------------------------------------------------------

const plannedKeywordSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "matchType"],
  properties: {
    text: { type: "string", description: "The keyword term, without any match-type operators." },
    matchType: { type: "string", enum: ["EXACT", "PHRASE", "BROAD"] },
  },
};

const STRUCTURE_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["campaignName", "adGroups", "sharedNegatives", "biddingStrategy", "rationale"],
  properties: {
    campaignName: {
      type: "string",
      description:
        "Clear name for the Search campaign. Recommended pattern: 'Brand | Search | Objective | Geo'.",
    },
    adGroups: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      description: "Ad groups, each covering a SINGLE theme (STAG).",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "theme",
          "archetype",
          "matchTypePolicy",
          "keywords",
          "negativeKeywords",
          "landingPageUrl",
        ],
        properties: {
          name: { type: "string", description: "Short, descriptive name for the ad group." },
          theme: {
            type: "string",
            description: "The single theme/intent this ad group covers (one idea only).",
          },
          archetype: {
            type: "string",
            enum: ["brand", "non_brand_stag", "dsa", "competitor", "category"],
          },
          matchTypePolicy: {
            type: "string",
            enum: ["EXACT", "PHRASE", "BROAD", "MIXED"],
          },
          keywords: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: plannedKeywordSchema,
          },
          negativeKeywords: {
            type: "array",
            description:
              "Ad-group-level negatives: block terms from OTHER groups (cross-group) and the wrong intents.",
            items: plannedKeywordSchema,
          },
          defaultCpcUsd: {
            type: "number",
            description:
              "Default max CPC for the ad group in USD (optional). Omit when the bidding strategy is automated.",
          },
          landingPageUrl: {
            type: "string",
            description: "Most relevant landing page URL for the ad group's theme.",
          },
        },
      },
    },
    sharedNegatives: {
      type: "array",
      description:
        "Campaign-level (shared) negatives: universal junk, free/gratis intent, wrong geo, etc.",
      items: plannedKeywordSchema,
    },
    biddingStrategy: {
      type: "string",
      enum: [
        "MANUAL_CPC",
        "MAXIMIZE_CLICKS",
        "MAXIMIZE_CONVERSIONS",
        "TARGET_CPA",
        "MAXIMIZE_CONVERSION_VALUE",
        "TARGET_ROAS",
      ],
      description: "The campaign's bidding strategy (normally the one set by strategist A1).",
    },
    rationale: {
      type: "string",
      description:
        "Short, plain explanation of why this structure is the right one, written in the brand's main language (the one specified in the user prompt).",
    },
  },
};

// ----------------------------------------------------------------------------
// Prompt builders
// ----------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a senior Google Ads (Search) specialist with 15 years optimizing PPC accounts.",
    "Your job is to design the STRUCTURE of a Search campaign: the campaign → ad-groups tree,",
    "and the negative-keyword scaffolding that keeps each group clean and focused.",
    "",
    "PRINCIPLES YOU ALWAYS DEFEND:",
    "1. STAG (Single Theme Ad Group): each group covers ONE intent/theme. If two keywords",
    "   would call for different ads, they go in different groups. Focused groups = more relevant ads",
    "   = better Quality Score = lower CPC.",
    "2. Sensible match-type mix. By default prioritize PHRASE and EXACT for intent control;",
    "   use BROAD only when the bidding strategy is automated (Smart Bidding) and backed by good negatives.",
    "   Set the group's matchTypePolicy to MIXED if you combine types, or the specific type if it is just one.",
    "3. Deduplicate. The same keyword must never appear in two groups: it causes internal competition.",
    "4. Cross-group negatives: add the core terms of the OTHER groups as ad-group negatives,",
    "   so each search lands in the correct group. This is mandatory in STAG structures.",
    "5. Campaign shared negatives: block universal noise (free, jobs, 'how to', PDF,",
    "   locations outside the target geo, brands you do not want to bid on) according to the business objective.",
    "6. Archetypes: use 'brand' for the brand's own terms, 'competitor' for competitors,",
    "   'category'/'non_brand_stag' for generic product/service terms, 'dsa' only when appropriate.",
    "7. Consistent, human-readable names. The campaign follows the pattern 'Brand | Search | Objective | Geo'.",
    "",
    "HARD RULES:",
    "- Use ONLY the keywords provided by the research step (A2). Do not invent new keywords.",
    "- Each keyword goes in exactly ONE group (the most relevant by its theme/intent).",
    "- defaultCpcUsd is optional: include it only if bidding is manual; omit it if bidding is automated.",
    "- Each group's landingPageUrl must be a real URL on the brand's site (use the default landing URL if there is no better one).",
    "- Return the structure via the structured tool; do not write free text outside of it.",
    "- Write all user-facing text in the brand's MAIN language — the one specified in the user prompt.",
  ].join("\n");
}

function buildUserPrompt(ctx: RunContext): string {
  const { brand, planner, keywords: kw } = ctx;

  const lang = languageName(ctx.planner?.geo.languageCode);

  const landingDefault =
    brand.landingPageUrl ?? brand.brandWebsite ?? "(no URL — use the brand's site URL)";

  const themesBlock =
    planner?.themes
      .map((t, i) => `  ${i + 1}. ${t.name} [${t.intent}] — ${t.description}`)
      .join("\n") ?? "  (the strategist provided no themes)";

  const kpisBlock =
    planner?.kpis.map((k) => `  - ${k.primary}: ${k.target}`).join("\n") ?? "  (no KPIs)";

  // Compact keyword table so the model can assign every keyword to a group.
  const kwBlock =
    kw?.keywords
      .map((k) => {
        const vol = k.avgMonthlySearches != null ? `~${k.avgMonthlySearches}/mo` : "vol?";
        const comp = k.competition ? k.competition : "comp?";
        const rel = k.relevanceScore != null ? `rel ${k.relevanceScore.toFixed(2)}` : "rel?";
        return `  - "${k.text}" [${k.matchType}] theme=${k.theme} intent=${k.intent} ${vol} ${comp} ${rel}`;
      })
      .join("\n") ?? "  (no keywords from the researcher)";

  const negBlock =
    kw?.negatives && kw.negatives.length > 0
      ? kw.negatives
          .map((n) => `  - "${n.text}" [${n.matchType}] class=${n.negativeClass} scope=${n.scope ?? "?"}`)
          .join("\n")
      : "  (the researcher proposed no negatives; derive the ones you need from the context)";

  return [
    "Design the Search campaign structure using the information below.",
    "",
    "=== BRAND ===",
    `Name: ${brand.brandName}`,
    `Website: ${brand.brandWebsite ?? "(not provided)"}`,
    `Default landing URL: ${landingDefault}`,
    brand.description ? `Description: ${brand.description}` : "",
    "",
    "=== STRATEGIST PLAN (A1) ===",
    planner ? `Objective: ${planner.objectiveType} — ${planner.objectiveSummary}` : "(no plan)",
    planner
      ? `Geo: ${planner.geo.locations.join(", ")} (${planner.geo.countryCodes.join(", ")}) language=${planner.geo.languageCode}`
      : "",
    planner ? `Daily budget: $${planner.budget.dailyUsd}` : "",
    planner ? `Chosen bidding strategy: ${planner.biddingStrategy}` : "",
    planner?.targetCpaUsd != null ? `Target CPA: $${planner.targetCpaUsd}` : "",
    planner?.targetRoas != null ? `Target ROAS: ${planner.targetRoas}` : "",
    "Seed themes (they become ad groups):",
    themesBlock,
    "KPIs:",
    kpisBlock,
    "",
    "=== KEYWORDS APPROVED BY THE RESEARCHER (A2) — use ONLY these ===",
    kwBlock,
    "",
    "=== NEGATIVES SUGGESTED BY THE RESEARCHER (A2) ===",
    negBlock,
    "",
    "=== YOUR TASK ===",
    "1. Group the keywords into STAG ad groups (one intent per group). Deduplicate: each keyword in ONE group.",
    "2. Assign each group a matchTypePolicy consistent with its mix of match types.",
    "3. For each group, add cross-group negatives (the core terms of the OTHER groups) plus the applicable A2 negatives.",
    "4. Define campaign-level sharedNegatives with the universal noise and whatever the business objective requires excluding.",
    `5. Keep the strategist's bidding strategy (${planner?.biddingStrategy ?? "the one from the plan"}) unless there is a strong reason to change it; explain it if you do.`,
    "6. Give each group a real, relevant landingPageUrl (use the default landing URL if there is no better one).",
    "7. Name the campaign with the pattern 'Brand | Search | Objective | Geo'.",
    `8. Write all user-facing text (ad group names, rationale and any notes) in ${lang}.`,
    "Return EVERYTHING via the structured tool.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ----------------------------------------------------------------------------
// Persistence helpers
// ----------------------------------------------------------------------------

function usdToMicros(usd: number | undefined): number | null {
  if (usd == null || !Number.isFinite(usd)) return null;
  return Math.round(usd * MICROS_PER_UNIT);
}

/** numeric(.,.) columns are strings in drizzle/pg; null stays null. */
function numericStr(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return String(value);
}

/** Index A2 keywords by normalised text+matchType so we can carry their metrics. */
function indexKeywordIdeas(ideas: KeywordIdea[] | undefined): Map<string, KeywordIdea> {
  const map = new Map<string, KeywordIdea>();
  for (const idea of ideas ?? []) {
    map.set(`${idea.text.trim().toLowerCase()}|${idea.matchType}`, idea);
  }
  return map;
}

function ideaFor(
  index: Map<string, KeywordIdea>,
  pk: PlannedKeyword
): KeywordIdea | undefined {
  return (
    index.get(`${pk.text.trim().toLowerCase()}|${pk.matchType}`) ??
    // Fall back to text-only match if the architect changed the match type.
    [...index.values()].find(
      (i) => i.text.trim().toLowerCase() === pk.text.trim().toLowerCase()
    )
  );
}

/**
 * Persist the proposed structure tree to adsDb. Owns ad_groups + keywords +
 * negative_keywords rows. No-op (skips DB) when there is no campaignId yet.
 */
async function persistStructure(
  campaignId: string,
  output: StructureOutput,
  ctx: RunContext
): Promise<void> {
  const ideaIndex = indexKeywordIdeas(ctx.keywords?.keywords);

  for (const group of output.adGroups) {
    const [adGroupRow] = await adsDb
      .insert(adGroups)
      .values({
        campaignId,
        name: group.name,
        theme: group.theme,
        archetype: group.archetype,
        matchTypePolicy: group.matchTypePolicy,
        defaultCpcMicros: usdToMicros(group.defaultCpcUsd),
        landingPageUrl: group.landingPageUrl,
        status: "proposed",
      })
      .returning({ id: adGroups.id });

    const adGroupId = adGroupRow.id;

    // Keywords for this group, carrying A2 metrics where available.
    if (group.keywords.length > 0) {
      await adsDb.insert(keywords).values(
        group.keywords.map((pk) => {
          const idea = ideaFor(ideaIndex, pk);
          return {
            adGroupId,
            campaignId,
            text: pk.text,
            matchType: pk.matchType,
            intent: idea?.intent ?? null,
            avgMonthlySearches: idea?.avgMonthlySearches ?? null,
            competition: idea?.competition ?? null,
            topOfPageBidMicros: idea?.topOfPageBidHighMicros ?? null,
            lowTopOfPageBidMicros: idea?.topOfPageBidLowMicros ?? null,
            relevanceScore: numericStr(idea?.relevanceScore),
            score: numericStr(idea?.score),
            source: idea?.source ?? "llm",
            rationale: idea?.rationale ?? null,
            status: "proposed",
          };
        })
      );
    }

    // Ad-group-level (cross-group / intent) negatives.
    if (group.negativeKeywords.length > 0) {
      await adsDb.insert(negativeKeywords).values(
        group.negativeKeywords.map((nk) => ({
          campaignId,
          adGroupId,
          text: nk.text,
          matchType: nk.matchType,
          negativeClass: "cross_group",
          scope: "ad_group" as const,
        }))
      );
    }
  }

  // Campaign-level shared negatives.
  if (output.sharedNegatives.length > 0) {
    await adsDb.insert(negativeKeywords).values(
      output.sharedNegatives.map((nk) => ({
        campaignId,
        adGroupId: null,
        text: nk.text,
        matchType: nk.matchType,
        negativeClass: "campaign",
        scope: "campaign" as const,
      }))
    );
  }
}

// ----------------------------------------------------------------------------
// Agent
// ----------------------------------------------------------------------------

const a3StructureArchitect: AgentDefinition<StructureOutput> = {
  id: AGENT_ID,
  title: "Structure architect",
  model: defaultAnthropicModel("structure_architect"),
  kind: "llm",
  promptVersion: PROMPT_VERSION,

  async execute(
    ctx: RunContext,
    helpers: AgentHelpers
  ): Promise<AgentResult<StructureOutput>> {
    const system = buildSystemPrompt();
    const prompt = buildUserPrompt(ctx);

    let result;
    try {
      result = await callStructured<StructureOutput>({
        agentId: "structure_architect",
        system,
        prompt,
        schema: STRUCTURE_SCHEMA,
        toolName: "submit_structure",
        toolDescription:
          "Return the complete Search campaign structure (campaign, STAG ad groups, keywords, negatives and bidding strategy).",
        temperature: 0.3,
        maxTokens: 8192,
        signal: helpers.signal,
      });
    } catch (e) {
      if (e instanceof LLMError) {
        await helpers.emit("error", { agent: AGENT_ID, message: e.message });
      }
      throw e;
    }

    const output = result.data;

    // Carry the planner's bidding strategy if the model left it blank.
    if (!output.biddingStrategy && ctx.planner?.biddingStrategy) {
      output.biddingStrategy = ctx.planner.biddingStrategy;
    }

    // Persist the structure tree (ad groups + keywords + negatives) to adsDb.
    if (ctx.campaignId) {
      await persistStructure(ctx.campaignId, output, ctx);
    }

    const totalKeywords = output.adGroups.reduce(
      (sum: number, g: PlannedAdGroup) => sum + g.keywords.length,
      0
    );
    const totalGroupNegatives = output.adGroups.reduce(
      (sum: number, g: PlannedAdGroup) => sum + g.negativeKeywords.length,
      0
    );

    await helpers.emit("decision", {
      agent: AGENT_ID,
      summary: `Campaign "${output.campaignName}": ${output.adGroups.length} ad groups, ${totalKeywords} keywords, ${
        totalGroupNegatives + output.sharedNegatives.length
      } negatives. Bidding: ${output.biddingStrategy}.`,
      campaignName: output.campaignName,
      adGroups: output.adGroups.length,
      keywords: totalKeywords,
      negatives: totalGroupNegatives + output.sharedNegatives.length,
      biddingStrategy: output.biddingStrategy,
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

export default a3StructureArchitect;
