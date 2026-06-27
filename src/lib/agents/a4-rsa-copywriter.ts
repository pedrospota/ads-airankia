// ============================================================================
// A4 — RSA COPYWRITER
// ----------------------------------------------------------------------------
// Turns the campaign structure (A3) + the strategy (A1) into Responsive Search
// Ads: for EACH ad group, exactly 15 headlines (<= 30 chars) and 4 descriptions
// (<= 90 chars), with varied angles and sparing pinning.
//
// Google Ads char limits are HARD. We ask the model to respect them, then we
// ENFORCE them in code after the call (truncating at word boundaries) so a
// rogue character count can never reach the Activator.
//
// Persists one `search_ads` row per ad group (this agent OWNS ad copy rows).
// ============================================================================

import { adsDb } from "@/lib/ads-db";
import { adGroups, searchAds } from "@/lib/schema";
import { and, eq } from "drizzle-orm";
import { callStructured, LLMError, defaultAnthropicModel } from "@/lib/llm";
import {
  AGENT_TITLES,
  RSA_LIMITS,
  languageName,
  type AdGroupAds,
  type AgentDefinition,
  type AgentHelpers,
  type DescriptionPin,
  type HeadlinePin,
  type JSONSchema,
  type PlannedAdGroup,
  type RSADescription,
  type RSAHeadline,
  type RSAOutput,
  type RunContext,
} from "@/lib/engine/types";

const PROMPT_VERSION = "a4-rsa-copywriter@1";

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior copywriter and world-class Google Ads strategist, specialized in responsive search ads (RSA). You have managed millions of euros in spend and know Google's policies inside out, along with what truly drives CTR and conversion.

Your job: write a flawless RSA for EACH ad group.

GOOGLE HARD RULES (non-negotiable, these are real character limits):
- Exactly 15 headlines. Each headline <= 30 characters, counting spaces.
- Exactly 4 descriptions. Each description <= 90 characters, counting spaces.
- path1 and path2 (visible URL paths) are optional; if you use them, each is <= 15 characters, a single word or short term, no spaces, no slashes, no URL.
- Count the characters yourself before submitting. If in doubt, shorten it. Never go over.

QUALITY (what a senior PPC defends):
- Variety of ANGLES across the 15 headlines: benefit, feature/differentiator, call to action (CTA), social proof/trust, urgency/scarcity, and brand. Do not repeat the same idea in other words.
- No two headlines should be nearly identical: Google rotates the assets and needs combinations that make sense together.
- Include at least 2-3 headlines with a primary keyword from the group (relevance = Quality Score), but written naturally, not forced.
- Include clear CTAs ("Book today", "Reserve now", "Request a quote").
- The 4 descriptions must expand on the value, not repeat the headlines: one benefit, one proof/trust, one with a CTA, one with an offer/differentiator.
- Tone according to the brand and the market.
- LANGUAGE: Write ALL ad copy — every headline, description and path — in the brand's MAIN language, which is specified in the user prompt. It is the language the brand's customers actually search and read in. Do not mix languages.
- No prohibited superlatives or unsupported promises ("the best", "100% guaranteed", "#1"), no sustained ALL-CAPS, no odd symbols/emoji, no repeated exclamation marks. Comply with Google's policies.

PINNING: pin with GREAT restraint. At most 1-2 pinned headlines in total (typically the brand in HEADLINE_1 or a CTA), and normally 0 descriptions. Over-pinning kills Google's optimization. Leave the vast majority unpinned (pinnedField = null).

Return ALL the ad groups you are given. For each group use its landingPageUrl as-is for finalUrl. Add a short rationale explaining your copy approach.`;

function buildUserPrompt(ctx: RunContext): string {
  const { brand, planner, structure } = ctx;

  const lang = languageName(ctx.planner?.geo.languageCode);

  const brandBlock = [
    `Brand: ${brand.brandName}`,
    brand.brandWebsite ? `Website: ${brand.brandWebsite}` : null,
    brand.description ? `Description: ${brand.description}` : null,
    brand.geoHint ? `Geo (hint): ${brand.geoHint}` : null,
    brand.languageHint ? `Language (hint): ${brand.languageHint}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const planBlock = planner
    ? [
        `Objective: ${planner.objectiveType} — ${planner.objectiveSummary}`,
        `Geo: ${planner.geo.locations.join(", ")} (language ${planner.geo.languageCode})`,
        `Brand summary: ${planner.brandSummary}`,
        planner.kpis.length
          ? `KPIs: ${planner.kpis.map((k) => `${k.primary} → ${k.target}`).join("; ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "(no plan available)";

  const groupsBlock = (structure?.adGroups ?? [])
    .map((g, i) => formatAdGroup(g, i))
    .join("\n\n");

  return `Write the RSA ads for this campaign.

== BRAND CONTEXT ==
${brandBlock}

== STRATEGY (A1) ==
${planBlock}

== STRUCTURE (A3) — ${structure?.campaignName ?? "campaign"} ==
Generate one RSA for EACH of these ${structure?.adGroups.length ?? 0} groups. Use the "name" field exactly as adGroupName and the "landingPageUrl" exactly as finalUrl.

${groupsBlock}

LANGUAGE: Write EVERY headline, description and path in ${lang} (the brand's main language — the language its customers actually search and read in). Do not mix languages. Write the rationale in ${lang} as well.

Remember: per group, 15 headlines (<=30 characters each) and 4 descriptions (<=90 characters each), varied angles, minimal pinning.`;
}

function formatAdGroup(g: PlannedAdGroup, index: number): string {
  const kws = g.keywords
    .slice(0, 12)
    .map((k) => `${k.text} [${k.matchType}]`)
    .join(", ");
  return [
    `Group ${index + 1}: "${g.name}"`,
    `  Theme/intent: ${g.theme} (${g.archetype})`,
    `  Landing (finalUrl): ${g.landingPageUrl}`,
    kws ? `  Key keywords: ${kws}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ----------------------------------------------------------------------------
// JSON schema — mirrors RSAOutput exactly
// ----------------------------------------------------------------------------

const HEADLINE_PINS: HeadlinePin[] = ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3", null];
const DESCRIPTION_PINS: DescriptionPin[] = ["DESCRIPTION_1", "DESCRIPTION_2", null];

const OUTPUT_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ads", "rationale"],
  properties: {
    ads: {
      type: "array",
      description: "One RSA for each ad group received.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["adGroupName", "headlines", "descriptions", "finalUrl"],
        properties: {
          adGroupName: {
            type: "string",
            description: "EXACT group name (the name field from the structure).",
          },
          headlines: {
            type: "array",
            description: "Exactly 15 headlines, each <= 30 characters.",
            minItems: RSA_LIMITS.minHeadlines,
            maxItems: RSA_LIMITS.maxHeadlines,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text"],
              properties: {
                text: { type: "string", maxLength: RSA_LIMITS.headlineMaxChars },
                pinnedField: {
                  type: ["string", "null"],
                  enum: HEADLINE_PINS,
                  description: "Optional pinning; use with great restraint.",
                },
              },
            },
          },
          descriptions: {
            type: "array",
            description: "Exactly 4 descriptions, each <= 90 characters.",
            minItems: RSA_LIMITS.minDescriptions,
            maxItems: RSA_LIMITS.maxDescriptions,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text"],
              properties: {
                text: { type: "string", maxLength: RSA_LIMITS.descriptionMaxChars },
                pinnedField: {
                  type: ["string", "null"],
                  enum: DESCRIPTION_PINS,
                  description: "Optional pinning; normally null.",
                },
              },
            },
          },
          path1: {
            type: "string",
            maxLength: RSA_LIMITS.path1MaxChars,
            description: "Visible path 1, optional, <= 15 characters, no spaces.",
          },
          path2: {
            type: "string",
            maxLength: RSA_LIMITS.path2MaxChars,
            description: "Visible path 2, optional, <= 15 characters, no spaces.",
          },
          finalUrl: {
            type: "string",
            description: "Destination URL = the group's landingPageUrl.",
          },
        },
      },
    },
    rationale: {
      type: "string",
      description:
        "Short explanation of the copy approach (in the brand's main language).",
    },
  },
};

// ----------------------------------------------------------------------------
// Enforcement helpers (Google limits are hard — never trust the LLM blindly)
// ----------------------------------------------------------------------------

/** Truncate to maxChars at a word boundary; falls back to a hard cut. */
function truncateAtWord(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const candidate = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  // Drop trailing punctuation/space left by the cut.
  return candidate.replace(/[\s,;:.!¡¿?-]+$/u, "").trim() || cut.trim();
}

/** Path segments: no spaces, no slashes, <= maxChars. */
function sanitizePath(raw: string | undefined, maxChars: number): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/[\s/\\]+/g, "").replace(/[{}]/g, "");
  if (!cleaned) return undefined;
  return cleaned.slice(0, maxChars);
}

interface EnforceResult {
  ad: AdGroupAds;
  truncations: number;
}

/**
 * Validate + repair one ad group's RSA against Google's hard limits and our
 * policy (max items, pin caps, char limits). Records how many fields were
 * truncated so we can surface it.
 */
function enforceAdGroup(ad: AdGroupAds, fallbackFinalUrl: string): EnforceResult {
  let truncations = 0;

  // --- Headlines ---
  const seenHeadlines = new Set<string>();
  let pinnedHeadlines = 0;
  const headlines: RSAHeadline[] = [];
  for (const h of ad.headlines ?? []) {
    if (headlines.length >= RSA_LIMITS.maxHeadlines) break;
    const original = (h?.text ?? "").trim();
    if (!original) continue;
    const text = truncateAtWord(original, RSA_LIMITS.headlineMaxChars);
    if (text.length < original.length) truncations += 1;
    const key = text.toLowerCase();
    if (!text || seenHeadlines.has(key)) continue;
    seenHeadlines.add(key);

    // Cap total pins at 2 across the whole RSA's headlines.
    let pinnedField: HeadlinePin = isHeadlinePin(h?.pinnedField) ? h.pinnedField : null;
    if (pinnedField !== null) {
      if (pinnedHeadlines >= 2) pinnedField = null;
      else pinnedHeadlines += 1;
    }
    headlines.push(pinnedField ? { text, pinnedField } : { text });
  }

  // --- Descriptions ---
  const seenDescriptions = new Set<string>();
  let pinnedDescriptions = 0;
  const descriptions: RSADescription[] = [];
  for (const d of ad.descriptions ?? []) {
    if (descriptions.length >= RSA_LIMITS.maxDescriptions) break;
    const original = (d?.text ?? "").trim();
    if (!original) continue;
    const text = truncateAtWord(original, RSA_LIMITS.descriptionMaxChars);
    if (text.length < original.length) truncations += 1;
    const key = text.toLowerCase();
    if (!text || seenDescriptions.has(key)) continue;
    seenDescriptions.add(key);

    let pinnedField: DescriptionPin = isDescriptionPin(d?.pinnedField)
      ? d.pinnedField
      : null;
    if (pinnedField !== null) {
      if (pinnedDescriptions >= 1) pinnedField = null;
      else pinnedDescriptions += 1;
    }
    descriptions.push(pinnedField ? { text, pinnedField } : { text });
  }

  const path1 = sanitizePath(ad.path1, RSA_LIMITS.path1MaxChars);
  const path2 = sanitizePath(ad.path2, RSA_LIMITS.path2MaxChars);
  const finalUrl = (ad.finalUrl ?? "").trim() || fallbackFinalUrl;

  const repaired: AdGroupAds = {
    adGroupName: ad.adGroupName,
    headlines,
    descriptions,
    finalUrl,
    ...(path1 ? { path1 } : {}),
    ...(path2 ? { path2 } : {}),
  };

  return { ad: repaired, truncations };
}

function isHeadlinePin(v: unknown): v is Exclude<HeadlinePin, null> {
  return v === "HEADLINE_1" || v === "HEADLINE_2" || v === "HEADLINE_3";
}

function isDescriptionPin(v: unknown): v is Exclude<DescriptionPin, null> {
  return v === "DESCRIPTION_1" || v === "DESCRIPTION_2";
}

// ----------------------------------------------------------------------------
// Agent definition
// ----------------------------------------------------------------------------

const a4RsaCopywriter: AgentDefinition<RSAOutput> = {
  id: "rsa_copywriter",
  title: AGENT_TITLES.rsa_copywriter,
  model: defaultAnthropicModel("rsa_copywriter"),
  kind: "llm",
  promptVersion: PROMPT_VERSION,

  async execute(ctx: RunContext, helpers: AgentHelpers) {
    if (!ctx.structure || ctx.structure.adGroups.length === 0) {
      const message =
        "No campaign structure: the ad copywriter needs the Architect's (A3) ad groups before writing.";
      await helpers.emit("error", { agent: "rsa_copywriter", message });
      throw new LLMError(message);
    }

    const system = SYSTEM_PROMPT;
    const prompt = buildUserPrompt(ctx);

    let result;
    try {
      result = await callStructured<RSAOutput>({
        agentId: "rsa_copywriter",
        system,
        prompt,
        schema: OUTPUT_SCHEMA,
        toolName: "submit_rsa_ads",
        toolDescription:
          "Returns the RSA ads (15 headlines + 4 descriptions per group) respecting Google's character limits.",
        temperature: 0.8,
        maxTokens: 8192,
        signal: helpers.signal,
      });
    } catch (err) {
      if (err instanceof LLMError) {
        await helpers.emit("error", {
          agent: "rsa_copywriter",
          message: err.message,
        });
      }
      throw err;
    }

    const raw = result.data;

    // Build a lookup so every structure group is matched even if the model
    // re-orders, renames slightly, or drops one.
    const byName = new Map<string, PlannedAdGroup>(
      ctx.structure.adGroups.map((g) => [g.name.toLowerCase(), g])
    );
    const rawByName = new Map<string, AdGroupAds>(
      (raw.ads ?? []).map((a) => [(a.adGroupName ?? "").toLowerCase(), a])
    );

    // ENFORCE limits in code for every planned ad group (source of truth = A3).
    let totalTruncations = 0;
    const enforcedAds: AdGroupAds[] = [];
    for (const group of ctx.structure.adGroups) {
      const proposed = rawByName.get(group.name.toLowerCase());
      if (!proposed) continue; // model skipped this group; cannot fabricate copy.
      const { ad, truncations } = enforceAdGroup(
        { ...proposed, adGroupName: group.name, finalUrl: group.landingPageUrl },
        group.landingPageUrl
      );
      // Only keep ads that still satisfy the minimums after repair.
      if (
        ad.headlines.length >= RSA_LIMITS.minHeadlines &&
        ad.descriptions.length >= RSA_LIMITS.minDescriptions
      ) {
        enforcedAds.push(ad);
        totalTruncations += truncations;
      }
    }

    const output: RSAOutput = {
      ads: enforcedAds,
      rationale: raw.rationale ?? "",
    };

    // ------------------------------------------------------------------
    // Persist: one search_ads row per ad group (this agent OWNS ad copy).
    // ------------------------------------------------------------------
    const campaignId = ctx.campaignId;
    let persisted = 0;
    if (campaignId) {
      for (const ad of output.ads) {
        const group = byName.get(ad.adGroupName.toLowerCase());
        const [row] = await adsDb
          .select({ id: adGroups.id })
          .from(adGroups)
          .where(
            and(
              eq(adGroups.campaignId, campaignId),
              eq(adGroups.name, ad.adGroupName)
            )
          )
          .limit(1);
        if (!row) continue;

        await adsDb.insert(searchAds).values({
          adGroupId: row.id,
          campaignId,
          headlines: ad.headlines,
          descriptions: ad.descriptions,
          finalUrls: [ad.finalUrl || group?.landingPageUrl || ""],
          path1: ad.path1 ?? null,
          path2: ad.path2 ?? null,
          status: "draft",
        });
        persisted += 1;
      }
    }

    await helpers.emit("decision", {
      agent: "rsa_copywriter",
      summary: `Wrote ads for ${output.ads.length} group(s): ${RSA_LIMITS.maxHeadlines} headlines and ${RSA_LIMITS.maxDescriptions} descriptions per group.${
        totalTruncations > 0
          ? ` Adjusted ${totalTruncations} text(s) to respect the character limits.`
          : ""
      }${persisted > 0 ? ` Saved ${persisted} ad(s).` : ""}`,
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

export default a4RsaCopywriter;
