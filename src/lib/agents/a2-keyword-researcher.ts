// ============================================================================
// A2 — KEYWORD RESEARCHER
// ----------------------------------------------------------------------------
// Second agent in the Search pipeline. From the Planner's themes + geo/language
// it builds the curated keyword list (text, match type, theme mapping, intent,
// relevance + composite score, source, rationale) and a STRONG negative list
// (free_seeker, wrong_intent, wrong_geo, competitor, ...).
//
// Real metrics first: we call the Google Ads KeywordPlanIdeaService with the
// theme/brand seeds + the landing page URL. If it returns ideas, we attach the
// real avgMonthlySearches / competition / top-of-page bid micros to the LLM
// keyword list by matching text (case-insensitive) and set
// metricsSource = 'google_keyword_planner'. If it returns [] or throws, we keep
// the LLM's own estimates and set metricsSource = 'llm_estimate'.
//
// Model: Sonnet (high-volume agent). Output mirrors KeywordResearchOutput from
// the FROZEN contract EXACTLY.
//
// Persists ONE keyword_research_runs row (seeds, sources, totalIdeas, kept,
// summarized raw). It does NOT write the keywords table — A3 owns keyword rows.
// ============================================================================

import {
  type AgentDefinition,
  type AgentResult,
  type AgentHelpers,
  type RunContext,
  type KeywordResearchOutput,
  type KeywordIdea,
  languageName,
} from "@/lib/engine/types";
import { callStructured, LLMError, defaultAnthropicModel } from "@/lib/llm";
import { generateKeywordIdeas, type KeywordPlanIdea } from "@/lib/google-ads";
import { adsDb } from "@/lib/ads-db";
import { keywordResearchRuns } from "@/lib/schema";

const PROMPT_VERSION = "a2-keyword-researcher-v1";
const TEMPERATURE = 0.5;

// ----------------------------------------------------------------------------
// JSON schema — mirrors KeywordResearchOutput from types.ts EXACTLY.
// ----------------------------------------------------------------------------

const INTENT_ENUM = [
  "brand",
  "transactional",
  "commercial",
  "informational",
  "competitor",
  "local",
] as const;

const MATCH_TYPE_ENUM = ["EXACT", "PHRASE", "BROAD"] as const;

const COMPETITION_ENUM = ["LOW", "MEDIUM", "HIGH"] as const;

const NEGATIVE_CLASS_ENUM = [
  "free_seeker",
  "wrong_intent",
  "wrong_geo",
  "competitor",
  "brand_cross",
  "cross_group",
] as const;

const NEGATIVE_SCOPE_ENUM = ["campaign", "ad_group", "shared"] as const;

const KEYWORD_RESEARCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["keywords", "negatives", "metricsSource", "notes"],
  properties: {
    keywords: {
      type: "array",
      minItems: 1,
      description:
        "Curated keyword list across ALL planner themes (~10-25 per theme), with mixed match types.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "matchType", "theme", "intent", "source"],
        properties: {
          text: {
            type: "string",
            description:
              "The search term in lowercase, without match-type operators (no quotes or brackets).",
          },
          matchType: {
            type: "string",
            enum: MATCH_TYPE_ENUM,
            description:
              "EXACT for high-intent/brand terms, PHRASE for medium intent, BROAD only with Smart Bidding and guarded with negatives.",
          },
          theme: {
            type: "string",
            description:
              "The EXACT Planner theme name (PlannerTheme.name) this keyword belongs to.",
          },
          intent: { type: "string", enum: INTENT_ENUM },
          avgMonthlySearches: {
            type: "number",
            description:
              "Estimated average monthly searches. If no real data is available, your best estimate.",
          },
          competition: {
            type: "string",
            enum: COMPETITION_ENUM,
            description: "Estimated competition (LOW/MEDIUM/HIGH).",
          },
          topOfPageBidLowMicros: {
            type: "number",
            description: "Estimated bid at the low end of the range (in micros).",
          },
          topOfPageBidHighMicros: {
            type: "number",
            description: "Estimated bid at the high end of the range (in micros).",
          },
          relevanceScore: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description:
              "Relevance 0..1 to the business and the landing page (1 = perfect fit).",
          },
          score: {
            type: "number",
            description:
              "Composite score (volume × intent × relevance × affordability). Use it to prioritize.",
          },
          source: {
            type: "string",
            description:
              "Origin of the idea: keyword_seed | url_seed | citation | llm | search_term | historical.",
          },
          rationale: {
            type: "string",
            description:
              "One sentence, in the brand's main language, justifying why this keyword is included.",
          },
        },
      },
    },
    negatives: {
      type: "array",
      minItems: 15,
      description:
        "Strong list of negative keywords (>=15) to protect the budget from day one.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "matchType", "negativeClass"],
        properties: {
          text: {
            type: "string",
            description: "Negative term in lowercase (no operators).",
          },
          matchType: {
            type: "string",
            enum: MATCH_TYPE_ENUM,
            description:
              "Match type of the negative (usually PHRASE or EXACT).",
          },
          negativeClass: {
            type: "string",
            enum: NEGATIVE_CLASS_ENUM,
            description:
              "Why it is negative: free_seeker (free/cheap), wrong_intent, wrong_geo, competitor, brand_cross, cross_group.",
          },
          scope: {
            type: "string",
            enum: NEGATIVE_SCOPE_ENUM,
            description:
              "Suggested scope: campaign (recommended for most), ad_group, or shared.",
          },
        },
      },
    },
    metricsSource: {
      type: "string",
      enum: ["google_keyword_planner", "llm_estimate"],
      description:
        "ALWAYS set 'llm_estimate'. The code switches it to 'google_keyword_planner' if it attaches real metrics.",
    },
    notes: {
      type: "string",
      description:
        "Notes for the business owner, in the brand's main language: selection logic, risks, and recommendations.",
    },
  },
};

// ----------------------------------------------------------------------------
// Seeds — derive keyword seeds for the Keyword Planner from the planner output.
// ----------------------------------------------------------------------------

function buildKeywordSeeds(ctx: RunContext): string[] {
  const seeds = new Set<string>();
  const planner = ctx.planner;
  if (planner) {
    for (const theme of planner.themes) {
      const name = theme.name?.trim();
      if (name) seeds.add(name.toLowerCase());
    }
  }
  const brandName = ctx.brand.brandName?.trim();
  if (brandName) seeds.add(brandName.toLowerCase());
  return [...seeds];
}

function landingSeed(ctx: RunContext): string | undefined {
  return (
    ctx.brand.landingPageUrl?.trim() ||
    ctx.brand.brandWebsite?.trim() ||
    undefined
  );
}

// ----------------------------------------------------------------------------
// Attach real Keyword Planner metrics to the LLM keyword list by text match.
// ----------------------------------------------------------------------------

function attachMetrics(
  keywords: KeywordIdea[],
  ideas: KeywordPlanIdea[]
): { keywords: KeywordIdea[]; matched: number } {
  const byText = new Map<string, KeywordPlanIdea>();
  for (const idea of ideas) {
    byText.set(idea.text.trim().toLowerCase(), idea);
  }

  let matched = 0;
  const enriched = keywords.map((kw) => {
    const hit = byText.get(kw.text.trim().toLowerCase());
    if (!hit) return kw;
    matched++;
    const competition =
      hit.competition === "LOW" ||
      hit.competition === "MEDIUM" ||
      hit.competition === "HIGH"
        ? hit.competition
        : kw.competition;
    return {
      ...kw,
      avgMonthlySearches: hit.avgMonthlySearches,
      competition,
      topOfPageBidLowMicros:
        hit.topOfPageBidLowMicros ?? kw.topOfPageBidLowMicros,
      topOfPageBidHighMicros:
        hit.topOfPageBidHighMicros ?? kw.topOfPageBidHighMicros,
      source: "keyword_seed",
    } satisfies KeywordIdea;
  });

  return { keywords: enriched, matched };
}

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are the world's best Google Ads (Search) specialist for keyword research,",
    "with deep, native intuition for how people actually search. You think like a",
    "senior PPC strategist who can defend every keyword (and every negative) to the",
    "business owner.",
    "",
    "Your job: starting from the plan's THEMES (each theme = a future single-intent",
    "ad group) and the brand, build:",
    "1. A CURATED keyword list per theme (~10-25 per theme), with mixed, well-reasoned",
    "   match types.",
    "2. A STRONG negative list (>=15) that protects the budget from day one.",
    "",
    "PRINCIPLES YOU ALWAYS APPLY:",
    "1. INTENT FIRST. Prioritize terms with real commercial/transactional intent.",
    "   People about to hire/buy search differently from those just gathering info.",
    "   Map each keyword to the correct theme (theme = the EXACT PlannerTheme.name).",
    "2. MATCH TYPES with judgment:",
    "   - EXACT for brand terms and very high intent (tight budget control).",
    "   - PHRASE for the bulk of medium-high intent (control + reach).",
    "   - BROAD only when it makes sense with Smart Bidding, and ALWAYS paired with",
    "     negatives that contain it. Do not overuse BROAD.",
    "3. NEGATIVES as a weapon. At least 15. Cover at minimum:",
    "   - free_seeker: 'free', 'cheap', 'second-hand', 'reviews', 'course', 'pdf',",
    "     'template', 'how to'... (people who will not pay).",
    "   - wrong_intent: informational/DIY searches that do NOT convert.",
    "   - wrong_geo: areas or countries outside the target.",
    "   - competitor: competitor brands (unless running a competitor strategy).",
    "   Use the correct negativeClass and a sensible scope (campaign by default).",
    "4. RELEVANCE: relevanceScore 0..1 based on the real fit with the business and",
    "   the landing page. Penalize ambiguous or tangential terms.",
    "5. COMPOSITE SCORE: combine volume × intent × relevance × affordability (bids)",
    "   so A3 can prioritize. Higher = stronger candidate.",
    "6. NO operators in 'text': no quotes or brackets; the matchType already signals",
    "   the match. Everything in lowercase.",
    "",
    "METRICS: set metricsSource = 'llm_estimate' and fill avgMonthlySearches /",
    "competition / bids with your BEST estimate. If the system has real data from the",
    "Keyword Planner, the code will attach it afterward and switch metricsSource to",
    "'google_keyword_planner'. Even so, always give your estimate so there are no gaps.",
    "",
    "Write all user-facing text (each keyword's rationale and notes) in the brand's",
    "MAIN language -- the one the user prompt specifies. Keep it simple, warm, and",
    "clear for a NON-technical business owner. No jargon, short sentences.",
    "",
    "Return EXCLUSIVELY the structured tool. Do not add free-form text.",
  ].join("\n");
}

function buildUserPrompt(ctx: RunContext): string {
  const b = ctx.brand;
  const planner = ctx.planner;
  const landing = landingSeed(ctx) ?? "(not provided)";
  const lang = languageName(ctx.planner?.geo.languageCode);

  const lines: string[] = [
    "Context for the keyword research:",
    "",
    `- Brand: ${b.brandName}`,
    `- Website: ${b.brandWebsite ?? "(not provided)"}`,
    `- Landing page (where the ads will point): ${landing}`,
  ];
  if (b.description) lines.push(`- Business description: ${b.description}`);
  if (b.offering) lines.push(`- What they offer: ${b.offering}`);
  if (b.audience) lines.push(`- Target audience (who they serve): ${b.audience}`);
  if (b.competitors?.length)
    lines.push(`- Known competitors: ${b.competitors.join(", ")}`);

  // Real AI-assistant signals AirAnkia already has — strong keyword seeds and a
  // competitor/citation signal. The schema's `source` field already allows
  // "citation", so the model can tag ideas it derives from these.
  const ai = b.aiContext;
  if (ai && (ai.topQueries.length || ai.citationDomains.length)) {
    lines.push(
      "",
      "AIRANKIA SIGNALS — real data on how people query AI assistants about this brand/market. Mine these for genuine search language and intent:"
    );
    if (ai.topQueries.length) {
      lines.push("- Real questions people ask AI assistants here (great keyword seeds):");
      for (const q of ai.topQueries) lines.push(`    • ${q}`);
    }
    if (ai.citationDomains.length) {
      lines.push(
        `- Domains AI assistants cite for these topics (treat well-known ones as competitor/citation signals): ${ai.citationDomains
          .map((d) => d.domain)
          .join(", ")}`
      );
    }
  }

  if (planner) {
    lines.push(
      "",
      `- Objective: ${planner.objectiveType} — ${planner.objectiveSummary}`,
      `- Geo: ${planner.geo.locations.join(", ")} (countries: ${planner.geo.countryCodes.join(", ")})`,
      `- Language: ${planner.geo.languageCode}`,
      `- Brand summary: ${planner.brandSummary}`,
      "",
      "PLAN THEMES (each one = a single-intent ad group).",
      "Use the EXACT 'name' in the 'theme' field of each keyword:"
    );
    for (const theme of planner.themes) {
      lines.push(
        `  • ${theme.name} [intent: ${theme.intent}] — ${theme.description}`
      );
    }
  } else {
    lines.push(
      "",
      "- (No Planner output available; infer reasonable themes from the brand.)"
    );
  }

  lines.push(
    "",
    "Instructions:",
    "- Generate ~10-25 keywords per theme, with mixed, well-reasoned match types.",
    "- Map each keyword to its theme using the EXACT theme name.",
    "- 'text' in lowercase and WITHOUT operators (no quotes or brackets).",
    "- Create at least 15 strong negatives (free_seeker, wrong_intent, wrong_geo, competitor).",
    "- Give your best estimate of volume, competition, and bids (metricsSource = 'llm_estimate').",
    `- Write all user-facing text (each keyword's rationale, and notes) in ${lang}.`,
    `- The keywords and negatives themselves must be in ${lang} — the language real customers use to search.`
  );

  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Agent
// ----------------------------------------------------------------------------

const a2KeywordResearcher: AgentDefinition<KeywordResearchOutput> = {
  id: "keyword_researcher",
  title: "Keyword Researcher",
  model: defaultAnthropicModel("keyword_researcher"),
  kind: "llm",
  promptVersion: PROMPT_VERSION,

  async execute(
    ctx: RunContext,
    helpers: AgentHelpers
  ): Promise<AgentResult<KeywordResearchOutput>> {
    const system = buildSystemPrompt();
    const prompt = buildUserPrompt(ctx);

    // --- 1) Try REAL metrics from the Keyword Planner (best-effort) ----------
    const keywordSeeds = buildKeywordSeeds(ctx);
    const urlSeed = landingSeed(ctx);
    const languageCode = ctx.planner?.geo.languageCode ?? "es";
    const countryCodes = ctx.planner?.geo.countryCodes ?? [];

    // TEMP instrumentation (remove once the keyword-step latency incident is
    // closed): time the Keyword Planner call and the LLM call separately so the
    // logs show exactly where a slow run spends its time.
    let plannerIdeas: KeywordPlanIdea[] = [];
    const tPlanner = Date.now();
    try {
      plannerIdeas = await generateKeywordIdeas({
        keywordSeeds,
        urlSeed,
        languageCode,
        countryCodes,
        costContext: {
          userId: ctx.run.userId,
          brandId: ctx.run.brandId,
          workspaceId: ctx.run.workspaceId,
          runId: ctx.run.id,
          stepId: helpers.stepId,
        },
      });
    } catch {
      plannerIdeas = [];
    }
    console.log(
      `[a2] keyword planner: ${plannerIdeas.length} ideas in ${Date.now() - tPlanner}ms`
    );

    // --- 2) Curate the list with the LLM -------------------------------------
    let result;
    const tLlm = Date.now();
    try {
      result = await callStructured<KeywordResearchOutput>({
        agentId: "keyword_researcher",
        system,
        prompt,
        schema: KEYWORD_RESEARCH_SCHEMA,
        toolName: "submit_keyword_research",
        toolDescription:
          "Submit the keyword research (curated keywords + negatives) as a structured object.",
        temperature: TEMPERATURE,
        signal: helpers.signal,
      });
    } catch (err) {
      console.error(
        `[a2] LLM call FAILED after ${Date.now() - tLlm}ms:`,
        err instanceof Error ? err.message : err
      );
      if (err instanceof LLMError) {
        await helpers.emit("error", {
          agent: "keyword_researcher",
          message: err.message,
        });
      }
      throw err;
    }
    console.log(`[a2] LLM call OK in ${Date.now() - tLlm}ms`);

    const llmOutput = result.data;

    // --- 3) Attach real metrics if we have them ------------------------------
    let keywords = llmOutput.keywords;
    let metricsSource: KeywordResearchOutput["metricsSource"] = "llm_estimate";
    let matched = 0;
    if (plannerIdeas.length > 0) {
      const attached = attachMetrics(keywords, plannerIdeas);
      keywords = attached.keywords;
      matched = attached.matched;
      if (matched > 0) metricsSource = "google_keyword_planner";
    }

    const output: KeywordResearchOutput = {
      ...llmOutput,
      keywords,
      metricsSource,
    };

    // --- 4) Persist ONE keyword_research_runs row (NOT the keywords table) ----
    const sources = Array.from(
      new Set(output.keywords.map((k) => k.source).filter(Boolean))
    );
    await adsDb.insert(keywordResearchRuns).values({
      campaignId: ctx.campaignId ?? null,
      runId: ctx.run.id,
      seeds: { keywordSeeds, urlSeed: urlSeed ?? null, languageCode, countryCodes },
      sources,
      rounds: 1,
      totalIdeas: output.keywords.length + plannerIdeas.length,
      kept: output.keywords.length,
      raw: {
        metricsSource,
        plannerIdeasReturned: plannerIdeas.length,
        plannerIdeasMatched: matched,
        keywords: output.keywords,
        negatives: output.negatives,
        notes: output.notes,
      },
    });

    // --- 5) Emit + return -----------------------------------------------------
    const metricsLabel =
      metricsSource === "google_keyword_planner"
        ? `real Planner metrics (${matched} matches)`
        : "estimated metrics";
    await helpers.emit("decision", {
      agent: "keyword_researcher",
      summary: `${output.keywords.length} keywords · ${output.negatives.length} negatives · ${metricsLabel}.`,
    });
    if (metricsSource === "llm_estimate") {
      await helpers.emit("decision", {
        agent: "keyword_researcher",
        summary:
          plannerIdeas.length === 0
            ? "Google didn't return search data this time, so we used our own estimates. The figures are approximate and will adjust automatically with real data as soon as the campaign starts running."
            : "Some keywords don't have exact data from Google, so for those we used our own estimates. The figures will adjust automatically once the campaign starts running.",
      });
    }
    await helpers.emit("artifact", { output });

    return {
      output,
      rationale: output.notes,
      model: result.model,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      costMicros: result.costMicros,
    };
  },
};

export default a2KeywordResearcher;
