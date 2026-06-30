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

  let body: { models?: unknown; maxTokens?: unknown } = {};
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

  // Run all models in parallel so total wall-clock ≈ the slowest single model
  // (keeps the endpoint under the platform timeout even with a slow reasoner).
  const results = await Promise.all(models.map((m) => runOne(m, safeKey, maxTokens)));

  return NextResponse.json({
    maxTokens,
    task: "executive-summary synthesis from a sample CompetitiveBrief",
    ranAt: new Date().toISOString(),
    results,
  });
}
