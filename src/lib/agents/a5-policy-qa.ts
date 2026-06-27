// ============================================================================
// A5 — POLICY / QA  (model: Opus, temperature ~0.2)
// ----------------------------------------------------------------------------
// The last gate before the Activator pushes anything to Google Ads. It reads
// the WHOLE plan (planner + keywords + structure + rsa) and returns a single
// verdict: pass | fix | block, plus a list of issues and a human-readable
// checklist. It is the senior PPC reviewer that protects the account from
// hard-limit violations, policy red-flags and broken landing pages.
//
// CONTRACT (see src/lib/engine/types.ts): export default an AgentDefinition.
// OUTPUT = QAOutput. PERSISTS NOTHING. Emits a 'gate' event with the verdict.
//
// SAFETY: this agent never enables a campaign and never mutates Google Ads. It
// only judges. A 'block' verdict stops the pipeline at an approval gate
// (handled by the orchestrator).
// ============================================================================

import { callStructured, LLMError, defaultAnthropicModel } from "@/lib/llm";
import {
  RSA_LIMITS,
  BUDGET,
  languageName,
  type AgentDefinition,
  type AgentResult,
  type AgentHelpers,
  type RunContext,
  type QAOutput,
} from "@/lib/engine/types";

const AGENT_ID = "policy_qa" as const;
const PROMPT_VERSION = "a5-policy-qa@1";

// ----------------------------------------------------------------------------
// JSON schema — mirrors QAOutput EXACTLY.
//   QAOutput {
//     verdict: "pass" | "fix" | "block";
//     issues: QAIssue[]            // severity, area, message, suggestion?, locator?
//     checklist: QAChecklistItem[] // name, ok, detail?
//     rationale: string;
//   }
// ----------------------------------------------------------------------------

const QA_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "checklist", "rationale"],
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "fix", "block"],
      description:
        "block = at least one hard-limit violation or serious policy issue; fix = improvable but publishable; pass = everything is correct.",
    },
    issues: {
      type: "array",
      description:
        "List of detected problems. Empty only if the plan is flawless.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "area", "message"],
        properties: {
          severity: {
            type: "string",
            enum: ["block", "fix", "warn"],
            description:
              "block = prevents publishing; fix = correct before activating; warn = minor notice.",
          },
          area: {
            type: "string",
            description:
              "Affected area: budget | bidding | structure | rsa_limits | policy | landing_page | geo | language | negatives | keywords | urls.",
          },
          message: {
            type: "string",
            description:
              "What is wrong, in clear and concrete terms, written in the brand's main language.",
          },
          suggestion: {
            type: "string",
            description:
              "How to fix it, clearly, written in the brand's main language. Optional.",
          },
          locator: {
            type: "string",
            description:
              'Where it is, e.g. "adGroup[0].headline[4]" or "campaign.budget". Optional.',
          },
        },
      },
    },
    checklist: {
      type: "array",
      description:
        "Verifiable summary of each control. One entry per check performed.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "ok"],
        properties: {
          name: {
            type: "string",
            description:
              "Short name of the control, written in the brand's main language.",
          },
          ok: {
            type: "boolean",
            description: "true if the control passes.",
          },
          detail: {
            type: "string",
            description: "Brief detail of the result. Optional.",
          },
        },
      },
    },
    rationale: {
      type: "string",
      description:
        "Final explanation in simple terms, written in the brand's main language: why this verdict and what the person should do.",
    },
  },
};

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are the SENIOR quality and policy reviewer of a Google Ads (Search) account.",
    "You have 15 years publishing Search campaigns and have seen thousands rejected for avoidable mistakes.",
    "Your job is NOT to give marketing opinions: it is to protect the account before anything is published.",
    "You are the last gate before the system pushes the campaign to Google (always PAUSED).",
    "",
    "You return ONE verdict: pass | fix | block.",
    "  - block  → there is at least one Google HARD-LIMIT violation or a serious policy issue. It CANNOT be published as is.",
    "  - fix    → there is no hard violation, but there is something clearly improvable that should be corrected before activating.",
    "  - pass   → everything is correct and ready to activate.",
    "",
    "Severity rules (apply them without exception):",
    `  1) BUDGET: the daily budget must be >= $${BUDGET.minDailyUsd}/day. Less than that = 'block' (area "budget").`,
    "  2) BIDDING: the bidding strategy must be consistent with the objective. E.g.: TARGET_CPA/MAXIMIZE_CONVERSIONS require a conversion objective (leads/sales/calls);",
    "     TARGET_ROAS/MAXIMIZE_CONVERSION_VALUE require conversion value (sales). For pure traffic, MAXIMIZE_CLICKS or MANUAL_CPC is usually enough.",
    "     If TARGET_CPA has no targetCpaUsd, or TARGET_ROAS has no targetRoas, that is inconsistent. Reasonable inconsistency = 'fix'; complete nonsense = 'block' (area \"bidding\").",
    "  3) STRUCTURE: each ad group must have >= 1 keyword AND exactly ONE RSA. Zero keywords or zero/duplicate RSA = 'block' (area \"structure\").",
    `  4) RSA LIMITS (Google HARD limits): each RSA with between ${RSA_LIMITS.minHeadlines} and ${RSA_LIMITS.maxHeadlines} headlines and between ${RSA_LIMITS.minDescriptions} and ${RSA_LIMITS.maxDescriptions} descriptions.`,
    `     Each headline <= ${RSA_LIMITS.headlineMaxChars} characters. Each description <= ${RSA_LIMITS.descriptionMaxChars} characters. Path1/Path2 <= ${RSA_LIMITS.path1MaxChars} characters.`,
    "     ANY character or min/max count violation = 'block' (area \"rsa_limits\"). Count the characters yourself, one by one.",
    "  5) URLS: each ad's finalUrl and each group's landingPageUrl must be absolute and start with https://. Relative URL, http:// or empty = 'block' (area \"urls\"/\"landing_page\").",
    "  6) LANDING PAGE: a landing page must exist (at campaign or group level). If missing = 'block' (area \"landing_page\").",
    "  7) NEGATIVES: there must be negative keywords (at campaign/shared level or per group). If there is NO negative at all = 'fix' (area \"negatives\").",
    "  8) DUPLICATES: the SAME exact keyword (same normalized text + same EXACT matchType) cannot be repeated across different groups. Exact duplicate = 'fix' (area \"keywords\"), because they compete with each other.",
    "  9) GEO + LANGUAGE: they must be defined. Empty geo.locations or geo.countryCodes, or empty languageCode = 'fix' (area \"geo\"/\"language\").",
    " 10) POLICY in the copy (headlines/descriptions): no unsupported superlatives (\"the best\", \"#1\", \"number one\") unless they are verifiable;",
    "     no medical or health claims (cures, guaranteed results); no misleading financial claims (guaranteed returns);",
    "     no improper use of third-party trademarks; no clickbait. Clear risk of rejection = 'block'; mild/improvable risk = 'fix' (area \"policy\").",
    "",
    "How to decide the overall verdict:",
    "  - If ANY issue with severity 'block' EXISTS → verdict = 'block'.",
    "  - If there is no 'block' but there is some 'fix' → verdict = 'fix'.",
    "  - If there is only 'warn' or nothing → verdict = 'pass'.",
    "",
    "Also return a readable checklist (one entry per control) so a non-technical person understands what was reviewed and whether it passed.",
    "Be exhaustive but honest: do not invent problems that do not exist, nor let real violations slip through.",
    "Write all user-facing text (message, suggestion, detail, checklist.name, rationale) in the brand's MAIN language, specified in the user prompt; the campaign content is expected to be in that language.",
  ].join("\n");
}

function buildUserPrompt(ctx: RunContext): string {
  const planner = ctx.planner ?? null;
  const keywords = ctx.keywords ?? null;
  const structure = ctx.structure ?? null;
  const rsa = ctx.rsa ?? null;
  const lang = languageName(ctx.planner?.geo.languageCode);

  const limitsBlock = JSON.stringify(
    {
      budgetMinDailyUsd: BUDGET.minDailyUsd,
      rsa: {
        headlineMaxChars: RSA_LIMITS.headlineMaxChars,
        descriptionMaxChars: RSA_LIMITS.descriptionMaxChars,
        minHeadlines: RSA_LIMITS.minHeadlines,
        maxHeadlines: RSA_LIMITS.maxHeadlines,
        minDescriptions: RSA_LIMITS.minDescriptions,
        maxDescriptions: RSA_LIMITS.maxDescriptions,
        path1MaxChars: RSA_LIMITS.path1MaxChars,
        path2MaxChars: RSA_LIMITS.path2MaxChars,
      },
    },
    null,
    2
  );

  return [
    "Review the COMPLETE plan of this Search campaign and issue your verdict.",
    "",
    `LANGUAGE: All user-facing text you produce (issue descriptions, fix suggestions, notes, checklist names, and any summary the user reads) MUST be written in ${lang}.`,
    `Also JUDGE the ad copy against ${lang}: the campaign content is expected to be in the brand's main language, ${lang}, NOT Spanish. Do NOT flag non-Spanish copy as wrong and do NOT "correct" ${lang} (or any other-language) copy back to Spanish.`,
    "",
    "=== BRAND (seed) ===",
    JSON.stringify(
      {
        brandName: ctx.brand?.brandName,
        brandWebsite: ctx.brand?.brandWebsite,
        landingPageUrl: ctx.brand?.landingPageUrl,
        objectiveHint: ctx.brand?.objectiveHint,
        geoHint: ctx.brand?.geoHint,
        languageHint: ctx.brand?.languageHint,
        budgetHintUsd: ctx.brand?.budgetHintUsd,
      },
      null,
      2
    ),
    "",
    "=== A1 — PLANNER (objective, geo/language, budget, bidding, themes, KPIs) ===",
    planner
      ? JSON.stringify(planner, null, 2)
      : "The Planner output is MISSING. Treat it as a serious structural problem.",
    "",
    "=== A2 — KEYWORDS (keywords + negatives) ===",
    keywords
      ? JSON.stringify(keywords, null, 2)
      : "The keyword researcher output is MISSING.",
    "",
    "=== A3 — STRUCTURE (campaign → groups, keywords per group, negatives, landing pages) ===",
    structure
      ? JSON.stringify(structure, null, 2)
      : "The structure architect output is MISSING. Without groups it cannot be published.",
    "",
    "=== A4 — RSA (headlines and descriptions per group, paths, finalUrl) ===",
    rsa
      ? JSON.stringify(rsa, null, 2)
      : "The ad copywriter output is MISSING. Without ads it cannot be published.",
    "",
    "=== REFERENCE HARD LIMITS (apply them to the letter) ===",
    limitsBlock,
    "",
    "Remember to pair each group from A3 with its RSA from A4 by the group name (adGroupName === PlannedAdGroup.name).",
    "Count the characters of each headline, description and path one by one. Verify that each group has >= 1 keyword and exactly 1 RSA.",
    "Check that all finalUrl and landingPageUrl are absolute and https. Look for duplicate exact keywords across groups.",
    "Emit issues[] with a precise locator, a readable checklist[] and a final verdict consistent with the severity rules.",
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Landing-page reachability check (real HTTP, NON-BLOCKING)
// ----------------------------------------------------------------------------
// The LLM can only verify a URL is well-formed (https + absolute). It cannot
// know whether the page actually LOADS. A typo'd or dead landing page is the
// number-one silent way to waste budget, so here we actually FETCH each distinct
// landing URL. SAFETY: this NEVER blocks. Anything wrong is a 'warn' only — a
// transient blip, a slow server or a bot-blocked page must not stop a campaign.
// The verdict is decided by the LLM and is never changed here.

const LANDING_CHECK_TIMEOUT_MS = 6000;
const LANDING_CHECK_MAX_URLS = 12;

function collectLandingUrls(ctx: RunContext): string[] {
  const raw: string[] = [];
  for (const ad of ctx.rsa?.ads ?? []) {
    if (ad.finalUrl) raw.push(ad.finalUrl);
  }
  for (const g of ctx.structure?.adGroups ?? []) {
    if (g.landingPageUrl) raw.push(g.landingPageUrl);
  }
  if (ctx.brand?.landingPageUrl) raw.push(ctx.brand.landingPageUrl);

  // Dedupe (case-insensitive), keep only absolute https URLs, cap the count.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of raw) {
    const url = (u ?? "").trim();
    if (!url.toLowerCase().startsWith("https://")) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= LANDING_CHECK_MAX_URLS) break;
  }
  return out;
}

type LandingProblem = { url: string; reason: string };

async function checkOneLanding(
  url: string,
  parentSignal?: AbortSignal
): Promise<LandingProblem | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    LANDING_CHECK_TIMEOUT_MS
  );
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AirankiaBot/1.0; +https://ads.airankia.com)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (res.status === 404 || res.status === 410) {
      return { url, reason: "does not exist (page not found)" };
    }
    if (res.status >= 500) {
      return { url, reason: `the server returned an error (${res.status})` };
    }
    // 2xx, 3xx and "gated" 4xx (401/403/405/429…) → the page exists.
    return null;
  } catch {
    // Network error, DNS failure, timeout or abort.
    if (parentSignal?.aborted) return null; // run cancelled — don't warn.
    return { url, reason: "did not respond in time or could not be opened" };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

// ----------------------------------------------------------------------------
// Agent definition
// ----------------------------------------------------------------------------

const a5PolicyQa: AgentDefinition<QAOutput> = {
  id: AGENT_ID,
  title: "Quality and policy reviewer",
  model: defaultAnthropicModel("policy_qa"),
  kind: "llm",
  promptVersion: PROMPT_VERSION,

  async execute(
    ctx: RunContext,
    helpers: AgentHelpers
  ): Promise<AgentResult<QAOutput>> {
    const system = buildSystemPrompt();
    const prompt = buildUserPrompt(ctx);

    let result;
    try {
      result = await callStructured<QAOutput>({
        agentId: AGENT_ID,
        system,
        prompt,
        schema: QA_SCHEMA,
        toolName: "submit_qa_review",
        toolDescription:
          "Returns the verdict (pass|fix|block), the detected problems, the checklist and the explanation.",
        temperature: 0.2,
        signal: helpers.signal,
      });
    } catch (e) {
      if (e instanceof LLMError) {
        await helpers.emit("error", { agent: AGENT_ID, message: e.message });
      }
      throw e;
    }

    const output = result.data;

    // --- Landing-page reachability (real HTTP, NON-BLOCKING warn) -----------
    // Adds 'warn' issues + a checklist line only. NEVER changes the verdict.
    try {
      const landingUrls = collectLandingUrls(ctx);
      if (landingUrls.length > 0 && !helpers.signal?.aborted) {
        const results = await Promise.all(
          landingUrls.map((u) => checkOneLanding(u, helpers.signal))
        );
        const problems = results.filter(
          (r): r is LandingProblem => r != null
        );
        const okCount = landingUrls.length - problems.length;
        output.checklist.push({
          name: "Landing pages reachable",
          ok: problems.length === 0,
          detail:
            problems.length === 0
              ? `${landingUrls.length} page(s) open correctly.`
              : `${okCount} of ${landingUrls.length} open fine; ${problems.length} with warnings.`,
        });
        for (const p of problems) {
          output.issues.push({
            severity: "warn",
            area: "landing_page",
            message: `The page ${p.url} ${p.reason}. If the link is wrong or down, whoever clicks will not see your offer and you would spend without results.`,
            suggestion:
              "Open the link in your browser. If it does not load, fix the landing page address before launching the campaign.",
            locator: "landingPageUrl",
          });
        }
        if (problems.length > 0) {
          await helpers.emit("decision", {
            agent: AGENT_ID,
            summary: `Notice: ${problems.length} landing page(s) did not respond well when checked. The campaign can still be created, but the link should be reviewed.`,
          });
        }
      }
    } catch {
      // Best-effort only: if the whole check fails, skip it silently so it can
      // NEVER block or break QA.
    }

    const blockers = output.issues.filter((i) => i.severity === "block").length;
    const fixes = output.issues.filter((i) => i.severity === "fix").length;
    const warns = output.issues.filter((i) => i.severity === "warn").length;

    await helpers.emit("decision", {
      agent: AGENT_ID,
      verdict: output.verdict,
      summary: `Verdict: ${output.verdict.toUpperCase()} — ${blockers} blocker(s), ${fixes} to fix, ${warns} notice(s).`,
    });

    // Gate event carrying the verdict (the orchestrator stops on 'block').
    await helpers.emit("gate", {
      agent: AGENT_ID,
      verdict: output.verdict,
      blockers,
      fixes,
      warns,
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

export default a5PolicyQa;
