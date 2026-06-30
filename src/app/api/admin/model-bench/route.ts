// ============================================================================
// POST /api/admin/model-bench — head-to-head model comparison for /admin.
//
// Runs the SAME real report-synthesis task across a list of OpenRouter models
// IN PARALLEL and returns, per model: latency (ms), truncation flag, token
// counts, REAL cost (asked from OpenRouter via usage.include), and the full
// output text so quality can be judged side-by-side. Admin-gated. Never touches
// the original Supabase. The OpenRouter key is resolved server-side and NEVER
// returned — only booleans/metrics leave this route.
//
// This exists because "higher benchmark score" ≠ "better for us": our task is
// short markdown synthesis under a tight token budget, where reasoning models
// burn the budget on hidden thinking → slow + truncated + pricier. This proves
// it with hard numbers instead of theory.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin";
import { getOpenRouterKey } from "@/lib/llm/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Default line-up — the five we want to compare. Overridable via POST body.
const DEFAULT_MODELS = [
  "google/gemini-2.5-pro",
  "google/gemini-3.1-pro-preview",
  "qwen/qwen3-235b-a22b-2507",
  "deepseek/deepseek-v3.2",
  "z-ai/glm-4.7-flash",
];

// A realistic stand-in for the CompetitiveBrief we feed synthesize() in prod, so
// the comparison reflects the ACTUAL workload (not a toy prompt).
const SAMPLE_BRIEF = {
  brand: "airankia.com",
  market: "US (English)",
  competitors: ["semrush.com", "surferseo.com", "ahrefs.com", "frase.io", "clearscope.io"],
  keyword_spend: [
    { domain: "semrush.com", est_monthly_paid_cost_usd: 412000, paid_keywords: 9800, est_paid_traffic: 286000 },
    { domain: "ahrefs.com", est_monthly_paid_cost_usd: 188000, paid_keywords: 4100, est_paid_traffic: 122000 },
    { domain: "surferseo.com", est_monthly_paid_cost_usd: 54000, paid_keywords: 1300, est_paid_traffic: 38000 },
    { domain: "frase.io", est_monthly_paid_cost_usd: 21000, paid_keywords: 640, est_paid_traffic: 14500 },
    { domain: "clearscope.io", est_monthly_paid_cost_usd: 9500, paid_keywords: 210, est_paid_traffic: 5200 },
  ],
  keyword_gaps: [
    { keyword: "ai content optimization", volume: 8100, cpc_usd: 12.4, competitors_bidding: ["surferseo.com", "frase.io"], we_bid: false },
    { keyword: "seo content score", volume: 3600, cpc_usd: 9.1, competitors_bidding: ["clearscope.io"], we_bid: false },
    { keyword: "ai search visibility", volume: 2900, cpc_usd: 7.8, competitors_bidding: [], we_bid: false },
    { keyword: "llm prompt monitoring", volume: 1700, cpc_usd: 6.2, competitors_bidding: [], we_bid: false },
  ],
  landing_teardowns: [
    { domain: "surferseo.com", h1: "Write content that ranks", primary_cta: "Start free trial", offer: "7-day trial", proof: "150k+ users", angle: "speed + SERP data" },
    { domain: "frase.io", h1: "Research, write, optimize in minutes", primary_cta: "Try for $1", offer: "$1 first week", proof: "30k+ teams", angle: "all-in-one + cheap entry" },
  ],
  brand_threats: [
    { attacker: "surferseo.com", on_keyword: "airankia alternative", note: "bidding on our brand variants" },
  ],
};

const SYSTEM = [
  "You are a senior paid-search strategist for a non-technical founder.",
  "From the competitive-intelligence JSON, write a tight EXECUTIVE SUMMARY in GitHub-flavored Markdown.",
  "Rules: no H1; start with a 2-sentence 'bottom line'; then '## Where the money is', '## Gaps to attack', '## How to win the click', '## Threats'.",
  "Be specific with the numbers given. End with '## Recommended first move' — one concrete campaign to launch. Keep it crisp; no fluff, no preamble.",
].join(" ");

const PROMPT = `COMPETITIVE INTELLIGENCE (JSON):\n${JSON.stringify(SAMPLE_BRIEF, null, 2)}`;

// ----------------------------------------------------------------------------
// STRUCTURED (tool-calling) probe. The campaign agents A1..A6 depend on the
// model emitting valid JSON via function-calling — markdown quality says nothing
// about whether a model can do that. This proves it: we force a single
// "emit_campaign" tool call and validate the arguments it returns. Same key
// handling / timing / error-name-only branching / real-cost accounting as the
// text path, so the two conditions are directly comparable.
// ----------------------------------------------------------------------------
const STRUCT_SYSTEM = [
  "You are a paid-search strategist that outputs machine-readable plans.",
  "Plan a tiny Google Search campaign and return it ONLY by calling the emit_campaign tool.",
  "Do not write any prose, explanation, or markdown — emit the tool call and nothing else.",
].join(" ");

const STRUCT_PROMPT = [
  "Plan a small Google Search campaign for airankia.com.",
  'Target exactly these two zero-competition keywords: "ai search visibility" and "llm prompt monitoring".',
  "Use a $30/day budget. Pick the most sensible objective.",
  "Return the plan ONLY via the emit_campaign tool.",
].join(" ");

// One function the model is FORCED to call (tool_choice below). Its parameters
// are the exact JSON Schema the A1..A6 agents expect for a campaign payload.
const EMIT_CAMPAIGN_TOOL = {
  type: "function" as const,
  function: {
    name: "emit_campaign",
    description: "Emit a Google Search campaign plan as structured data.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", enum: ["leads", "sales", "traffic"] },
        daily_budget_usd: { type: "number" },
        ad_groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              keywords: { type: "array", items: { type: "string" } },
            },
            required: ["name", "keywords"],
          },
        },
      },
      required: ["objective", "daily_budget_usd", "ad_groups"],
    },
  },
};

type ModelResult = {
  model: string;
  ok: boolean;
  status: number;
  ms: number;
  finishReason: string | null;
  truncated: boolean;
  chars: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  output: string;
  error: string | null;
};

// The campaign shape we require back from the forced tool call.
type StructuredCampaign = {
  objective: string;
  daily_budget_usd: number;
  ad_groups: { name: string; keywords: string[] }[];
};

type StructuredResult = {
  model: string;
  ok: boolean;          // valid tool JSON = validJson && hasAllFields
  status: number;
  ms: number;
  validJson: boolean;   // tool arguments JSON.parse'd cleanly
  hasAllFields: boolean; // parsed object has every required field, correctly typed
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  parsed: StructuredCampaign | null;
  error: string | null;
};

// Structural validation of the tool arguments: objective (string),
// daily_budget_usd (number), and a NON-EMPTY ad_groups array where every entry
// has a string name + a keywords array. Mirrors what A1..A6 actually consume.
function isValidCampaign(v: unknown): v is StructuredCampaign {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.objective !== "string") return false;
  if (typeof o.daily_budget_usd !== "number") return false;
  if (!Array.isArray(o.ad_groups) || o.ad_groups.length === 0) return false;
  return o.ad_groups.every((g) => {
    if (!g || typeof g !== "object") return false;
    const ag = g as Record<string, unknown>;
    return typeof ag.name === "string" && Array.isArray(ag.keywords);
  });
}

async function runOne(model: string, key: string, maxTokens: number): Promise<ModelResult> {
  const base: ModelResult = {
    model, ok: false, status: 0, ms: 0, finishReason: null, truncated: false,
    chars: 0, tokensIn: 0, tokensOut: 0, costUsd: null, output: "", error: null,
  };
  const started = Date.now();
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: PROMPT },
        ],
        max_tokens: maxTokens,
        temperature: 0.5,
        // Ask OpenRouter to include real cost accounting in the response usage.
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(150_000),
    });
    base.ms = Date.now() - started;
    base.status = resp.status;
    const bodyText = await resp.text().catch(() => "");
    if (!resp.ok) {
      base.error = `HTTP ${resp.status}: ${clip(bodyText)}`;
      return base;
    }
    let j: {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      error?: { message?: string };
    };
    try {
      j = JSON.parse(bodyText);
    } catch {
      base.error = `non-JSON response (${bodyText.length} bytes)`;
      return base;
    }
    if (j?.error?.message) {
      base.error = clip(j.error.message);
      return base;
    }
    const text = j?.choices?.[0]?.message?.content?.trim() ?? "";
    base.finishReason = j?.choices?.[0]?.finish_reason ?? null;
    base.truncated = base.finishReason === "length";
    base.tokensIn = j?.usage?.prompt_tokens ?? 0;
    base.tokensOut = j?.usage?.completion_tokens ?? 0;
    base.costUsd = typeof j?.usage?.cost === "number" ? j.usage.cost : null;
    base.output = text;
    base.chars = text.length;
    base.ok = Boolean(text);
    if (!text) base.error = "empty response";
    return base;
  } catch (e) {
    base.ms = Date.now() - started;
    // Branch on name only — never interpolate the raw exception (key-leak safe).
    const name = (e as Error)?.name;
    base.error = name === "TimeoutError" || name === "AbortError" ? "timed out (>150s)" : "network error";
    return base;
  }
}

// Tool-calling sibling of runOne(). Same fetch shape, same key handling (the
// caller passes the already-cleaned safe key), same usage:{include:true} cost
// accounting, same AbortSignal.timeout, and the SAME error-name-only branching
// in catch (never interpolate the raw exception — key-leak safe).
async function runStructured(model: string, key: string, maxTokens: number): Promise<StructuredResult> {
  const base: StructuredResult = {
    model, ok: false, status: 0, ms: 0, validJson: false, hasAllFields: false,
    tokensIn: 0, tokensOut: 0, costUsd: null, parsed: null, error: null,
  };
  const started = Date.now();
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: STRUCT_SYSTEM },
          { role: "user", content: STRUCT_PROMPT },
        ],
        // Force the single function call — this is what we're actually testing.
        tools: [EMIT_CAMPAIGN_TOOL],
        tool_choice: { type: "function", function: { name: "emit_campaign" } },
        max_tokens: maxTokens,
        temperature: 0.2, // low temp: structured emission, not prose
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(150_000),
    });
    base.ms = Date.now() - started;
    base.status = resp.status;
    const bodyText = await resp.text().catch(() => "");
    if (!resp.ok) {
      base.error = `HTTP ${resp.status}: ${clip(bodyText)}`;
      return base;
    }
    let j: {
      choices?: {
        message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] };
        finish_reason?: string;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      error?: { message?: string };
    };
    try {
      j = JSON.parse(bodyText);
    } catch {
      base.error = `non-JSON response (${bodyText.length} bytes)`;
      return base;
    }
    if (j?.error?.message) {
      base.error = clip(j.error.message);
      return base;
    }
    base.tokensIn = j?.usage?.prompt_tokens ?? 0;
    base.tokensOut = j?.usage?.completion_tokens ?? 0;
    base.costUsd = typeof j?.usage?.cost === "number" ? j.usage.cost : null;

    const rawArgs = j?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (typeof rawArgs !== "string" || !rawArgs) {
      base.error = "model returned no tool call";
      return base;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      base.error = "tool arguments were not valid JSON";
      return base;
    }
    base.validJson = true;
    base.hasAllFields = isValidCampaign(parsed);
    if (base.hasAllFields) {
      base.parsed = parsed as StructuredCampaign;
      base.ok = true;
    } else {
      base.error = "tool JSON missing or mistyped required campaign fields";
    }
    return base;
  } catch (e) {
    base.ms = Date.now() - started;
    // Branch on name only — never interpolate the raw exception (key-leak safe).
    const name = (e as Error)?.name;
    base.error = name === "TimeoutError" || name === "AbortError" ? "timed out (>150s)" : "network error";
    return base;
  }
}

function clip(s: string): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > 200 ? t.slice(0, 199) + "…" : t;
}

export async function POST(request: NextRequest) {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const key = await getOpenRouterKey();
  if (!key) {
    return NextResponse.json({ error: "No OpenRouter key is set in /admin." }, { status: 400 });
  }
  const safeKey = key.replace(/[^\x20-\x7E]/g, "");

  let body: { models?: unknown; maxTokens?: unknown; mode?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // empty body → defaults
  }
  const models = Array.isArray(body.models) && body.models.length
    ? body.models.filter((m): m is string => typeof m === "string" && m.length > 0).slice(0, 12)
    : DEFAULT_MODELS;
  const maxTokens = Number.isFinite(Number(body.maxTokens))
    ? Math.min(4000, Math.max(400, Math.round(Number(body.maxTokens))))
    : 1600; // matches the real synthesize() budget — the honest condition
  // "text" (default, fully backward-compatible) | "structured" | "both".
  const mode: "text" | "structured" | "both" =
    body.mode === "structured" || body.mode === "both" ? body.mode : "text";

  // Run all models in parallel so total wall-clock ≈ the slowest single model
  // (keeps the endpoint under the platform timeout even with a slow reasoner).
  // In "both" we also run text+structured concurrently inside one Promise.all so
  // the wall-clock is still ≈ the single slowest call, not the sum.
  let results: ModelResult[] = [];
  let structuredResults: StructuredResult[] | undefined;

  if (mode === "structured") {
    structuredResults = await Promise.all(models.map((m) => runStructured(m, safeKey, maxTokens)));
  } else if (mode === "both") {
    const [textResults, structResults] = await Promise.all([
      Promise.all(models.map((m) => runOne(m, safeKey, maxTokens))),
      Promise.all(models.map((m) => runStructured(m, safeKey, maxTokens))),
    ]);
    results = textResults;
    structuredResults = structResults;
  } else {
    results = await Promise.all(models.map((m) => runOne(m, safeKey, maxTokens)));
  }

  return NextResponse.json({
    maxTokens,
    mode,
    task: "executive-summary synthesis from a sample CompetitiveBrief",
    ranAt: new Date().toISOString(),
    results,
    // Only present when structured ran ("structured" or "both") — keeps the
    // default text response { maxTokens, task, ranAt, results } unbroken.
    ...(structuredResults ? { structuredResults } : {}),
  });
}
