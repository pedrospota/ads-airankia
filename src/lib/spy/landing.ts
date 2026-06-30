// ============================================================================
// Landing X-Ray — read a competitor's landing page and tear it down.
//
// Powers the "🔬 Landing X-Ray" tool: point at a competitor landing URL (or
// domain) and get a structured teardown — the offer, pricing tiers, primary CTA,
// value props, social proof, the funnel steps, the marketing/tracking stack, and
// (when you paste the ad's headline/description) a verdict on whether the page
// delivers on the ad's promise (message match: strong / partial / weak).
//
// Scrape: PRIMARY is the Firecrawl MCP `firecrawl_markdown_scrapper` tool
//   (https://automations.ideacharge.com/mcp/firecrawlscrapper — streamable HTTP /
//   JSON-RPC over SSE; see firecrawl-ocr.ts for the base contract). The server
//   requires the MCP init handshake first, so we initialize → grab the
//   mcp-session-id → notifications/initialized → tools/call. If Firecrawl is
//   unavailable we FALL BACK to a plain server-side fetch (desktop UA, timeout)
//   and strip the HTML to text (page-fetch.ts). Either path: NEVER throws.
//
// We always do a free raw-HTML fetch in parallel so the tracking stack
// (GTM / GA / Ads / Meta / TikTok pixels) is mined deterministically from the
// real markup (markdown strips scripts), rather than guessed by the LLM.
//
// Extract: ONE plain-text OpenRouter completion that returns JSON, parsed
// defensively (code-fence tolerant). Mirrors the benchmark LLM pattern
// (getLlmConfig / getOpenRouterKey), maxTokens ~1500, key-leak safe.
//
// The result carries the typed `LandingSlice` (the brief contract) plus a
// friendly UI shape, the source label, and the metered cost. Never throws.
// ============================================================================

import type { LandingSlice } from "@/lib/spy/brief";
import { fetchPage, extractTracking, toUrl, toDomain } from "@/lib/benchmark/page-fetch";
import { getLlmConfig, getOpenRouterKey } from "@/lib/llm/settings";

const FIRECRAWL_ENDPOINT = "https://automations.ideacharge.com/mcp/firecrawlscrapper";
const TEXT_CAP = 12_000;

// ---------------------------------------------------------------------------
// Firecrawl MCP — markdown scrape (with the required init handshake).
// ---------------------------------------------------------------------------

interface FirecrawlScrape {
  markdown: string;
  title: string;
  creditsUsed: number;
}

/** Parse the SSE / JSON body of an MCP response → the JSON-RPC `result`. */
function parseMcpResult(bodyText: string, contentType: string): unknown {
  const grab = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  if (contentType.includes("text/event-stream")) {
    const lines = bodyText.split("\n").filter((l) => l.startsWith("data:"));
    for (let i = lines.length - 1; i >= 0; i--) {
      const d = grab(lines[i].slice(5).trim()) as { result?: unknown } | null;
      if (d?.result !== undefined) return d.result;
    }
    return null;
  }
  const j = grab(bodyText) as { result?: unknown } | null;
  return j?.result ?? null;
}

/**
 * Scrape a URL to clean markdown via the Firecrawl MCP. Does the full streamable
 * -HTTP MCP handshake (initialize → initialized → tools/call) because the server
 * rejects bare calls with "Server not initialized". Returns null on any failure.
 */
async function firecrawlMarkdown(url: string, timeoutMs = 45_000): Promise<FirecrawlScrape | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    // 1) initialize → session id.
    const initResp = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "landing-xray", version: "1.0" },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!initResp.ok) return null;
    const sessionId = initResp.headers.get("mcp-session-id");
    await initResp.text().catch(() => "");
    const sessioned = sessionId ? { ...headers, "mcp-session-id": sessionId } : headers;

    // 2) notifications/initialized (best effort).
    if (sessionId) {
      await fetch(FIRECRAWL_ENDPOINT, {
        method: "POST",
        headers: sessioned,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.text()).catch(() => "");
    }

    // 3) tools/call.
    const resp = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: sessioned,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "firecrawl_markdown_scrapper", arguments: { url } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;

    const ct = resp.headers.get("content-type") ?? "";
    const bodyText = await resp.text();
    const result = parseMcpResult(bodyText, ct) as
      | { content?: { type?: string; text?: string }[] }
      | null;
    const inner = result?.content?.[0]?.text;
    if (!inner) return null;

    // inner is a JSON string: [{ success, data: { markdown, metadata } }]
    let payload: unknown;
    try {
      payload = JSON.parse(inner);
    } catch {
      return null;
    }
    const first = Array.isArray(payload) ? payload[0] : payload;
    const data = (first as { data?: { markdown?: string; metadata?: Record<string, unknown> } })?.data;
    const markdown = typeof data?.markdown === "string" ? data.markdown : "";
    if (!markdown.trim()) return null;
    const meta = data?.metadata ?? {};
    return {
      markdown,
      title: typeof meta.title === "string" ? meta.title : "",
      creditsUsed: typeof meta.creditsUsed === "number" ? meta.creditsUsed : 1,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM extraction — one plain-text OpenRouter completion that returns JSON.
// ---------------------------------------------------------------------------

interface ExtractedFields {
  offer: string | null;
  pricing: string[];
  primaryCta: string | null;
  valueProps: string[];
  socialProof: string[];
  funnelSteps: string[];
  adMessageMatch: "strong" | "partial" | "weak" | null;
  matchRationale: string | null;
}

interface LlmOutcome {
  fields: ExtractedFields | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  error: string | null;
}

const EMPTY_FIELDS: ExtractedFields = {
  offer: null,
  pricing: [],
  primaryCta: null,
  valueProps: [],
  socialProof: [],
  funnelSteps: [],
  adMessageMatch: null,
  matchRationale: null,
};

function clip(s: string): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 159) + "…" : t;
}

const asStrArray = (v: unknown, cap = 12): string[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim())).filter(Boolean).slice(0, cap)
    : [];

const asStrOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** Pull the first balanced JSON object out of an LLM response (fence-tolerant). */
function parseJsonLoose(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function extractWithLlm(opts: {
  url: string;
  text: string;
  title: string;
  adHeadline: string | null;
  adDescription: string | null;
}): Promise<LlmOutcome> {
  const fail = (error: string, model: string | null = null): LlmOutcome => ({
    fields: null,
    model,
    tokensIn: 0,
    tokensOut: 0,
    error,
  });

  let model: string | null = null;
  try {
    const config = await getLlmConfig();
    const key = await getOpenRouterKey();
    model = config.defaultModel;
    if (config.provider !== "openrouter") {
      return fail(`LLM provider is "${config.provider}", not OpenRouter — set provider to OpenRouter in /admin.`);
    }
    if (!key) return fail("No OpenRouter API key is set — add it in /admin.");
    if (!model) return fail("No OpenRouter model is selected — pick one in /admin.");

    const safeKey = key.replace(/[^\x20-\x7E]/g, "");

    const adBlock =
      adHeadlineOrDesc(opts.adHeadline, opts.adDescription) ||
      "(No ad provided — set adMessageMatch and matchRationale to null.)";

    const system =
      "You are a senior performance-marketing strategist. You read a competitor's " +
      "landing page and return a precise, factual teardown as STRICT JSON only — no " +
      "prose, no markdown, no code fences. Only use information present on the page; " +
      "never invent prices or claims. Write the string values in the same language as " +
      "the page.";

    const prompt = [
      `LANDING PAGE URL: ${opts.url}`,
      opts.title ? `PAGE TITLE: ${opts.title}` : "",
      "",
      "AD (the promise that drove the click — judge whether the page delivers on it):",
      adBlock,
      "",
      "PAGE CONTENT (scraped, may be truncated):",
      '"""',
      opts.text,
      '"""',
      "",
      "Return EXACTLY this JSON shape:",
      "{",
      '  "offer": string | null,                // the core offer / what they sell, one sentence',
      '  "pricing": string[],                   // each plan/price as seen, e.g. "Pro — $49/mo"; [] if none shown',
      '  "primaryCta": string | null,           // the dominant call-to-action button text',
      '  "valueProps": string[],                // 3-6 concrete benefits/value propositions',
      '  "socialProof": string[],               // testimonials, logos, ratings, customer counts, awards',
      '  "funnelSteps": string[],               // the conversion path, e.g. ["Sign up free","Add card","Start trial"]',
      '  "adMessageMatch": "strong" | "partial" | "weak" | null,  // null if no ad provided',
      '  "matchRationale": string | null        // 1-2 sentences justifying the match verdict; null if no ad',
      "}",
    ]
      .filter(Boolean)
      .join("\n");

    let resp: Response;
    try {
      resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${safeKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          max_tokens: 1500,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(70_000),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      console.warn("[landing] llm fetch failed:", (e as Error)?.name);
      return fail(
        timedOut
          ? `Model "${model}" timed out — try a faster model in /admin.`
          : "Network error reaching OpenRouter — check connectivity and try again.",
        model,
      );
    }

    const bodyText = await resp.text().catch(() => "");
    if (!resp.ok) {
      const hint =
        resp.status === 401 ? " (bad or expired key)"
        : resp.status === 402 ? " (out of credits)"
        : resp.status === 404 ? " (model id not found)"
        : resp.status === 400 ? " (bad request — often an invalid model id)"
        : "";
      return fail(`The AI model "${model}" couldn't be reached — HTTP ${resp.status}${hint}. ${clip(bodyText)}`.trim(), model);
    }

    let j: {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    try {
      j = JSON.parse(bodyText);
    } catch {
      return fail(`The AI model "${model}" returned a non-JSON response (HTTP ${resp.status}) — try another model in /admin.`, model);
    }
    if (j?.error?.message) return fail(`The AI model "${model}" returned an error: ${clip(j.error.message)}`, model);

    const tokensIn = j?.usage?.prompt_tokens ?? 0;
    const tokensOut = j?.usage?.completion_tokens ?? 0;
    const content = j?.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = parseJsonLoose(content);
    if (!parsed) {
      return { fields: null, model, tokensIn, tokensOut, error: `The AI model "${model}" didn't return valid JSON — try another model in /admin.` };
    }

    const matchRaw = typeof parsed.adMessageMatch === "string" ? parsed.adMessageMatch.toLowerCase() : null;
    const adMessageMatch =
      matchRaw === "strong" || matchRaw === "partial" || matchRaw === "weak" ? matchRaw : null;

    const fields: ExtractedFields = {
      offer: asStrOrNull(parsed.offer),
      pricing: asStrArray(parsed.pricing, 10),
      primaryCta: asStrOrNull(parsed.primaryCta),
      valueProps: asStrArray(parsed.valueProps, 8),
      socialProof: asStrArray(parsed.socialProof, 8),
      funnelSteps: asStrArray(parsed.funnelSteps, 8),
      adMessageMatch,
      matchRationale: asStrOrNull(parsed.matchRationale),
    };
    return { fields, model, tokensIn, tokensOut, error: null };
  } catch (e) {
    console.warn("[landing] llm extraction error:", (e as Error)?.name);
    return fail("Unexpected error running the AI extraction — check the model/key in /admin.", model);
  }
}

function adHeadlineOrDesc(h: string | null, d: string | null): string {
  const parts: string[] = [];
  if (h) parts.push(`Headline: ${h}`);
  if (d) parts.push(`Description: ${d}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface LandingXrayInput {
  url: string;
  adHeadline?: string | null;
  adDescription?: string | null;
}

export interface LandingXray {
  url: string;
  domain: string;
  /** The brief contract slice. */
  slice: LandingSlice;
  title: string;
  source: string; // "Firecrawl + AI"
  scrape: { ok: boolean; provider: "firecrawl" | "fetch" | "none"; chars: number; creditsUsed: number };
  llm: { ran: boolean; model: string | null; tokensIn: number; tokensOut: number; error: string | null };
  /** Estimated metered cost for this run, USD. */
  cost: number;
  error: string | null;
}

const FIRECRAWL_CREDIT_USD = 0.001; // directional — Firecrawl scrape ≈ 1 credit.

/**
 * Tear down a competitor landing page. Scrapes (Firecrawl → fallback fetch),
 * mines the tracking stack from raw HTML, and runs one LLM extraction pass.
 * NEVER throws — on any failure the slice fields are null and `error` explains.
 */
export async function analyzeLanding(input: LandingXrayInput): Promise<LandingXray> {
  const url = toUrl(input.url) ?? input.url.trim();
  const domain = toDomain(input.url) ?? "";
  const adHeadline = (input.adHeadline ?? "").trim() || null;
  const adDescription = (input.adDescription ?? "").trim() || null;

  const baseSlice: LandingSlice = {
    domain,
    url,
    offer: null,
    pricing: null,
    primaryCta: null,
    valueProps: [],
    socialProof: [],
    funnelSteps: null,
    trackingStack: [],
    adMessageMatch: null,
    matchRationale: null,
  };

  // Scrape (Firecrawl markdown) + free raw-HTML fetch (tracking + fallback text)
  // in parallel. Neither throws.
  const [fc, page] = await Promise.all([firecrawlMarkdown(url), fetchPage(url)]);

  const trackingStack = page.html ? extractTracking(page.html).pixels : [];

  let text = "";
  let provider: LandingXray["scrape"]["provider"] = "none";
  let creditsUsed = 0;
  let title = "";
  if (fc && fc.markdown.trim()) {
    text = fc.markdown.slice(0, TEXT_CAP);
    provider = "firecrawl";
    creditsUsed = fc.creditsUsed;
    title = fc.title || page.title;
  } else if (page.ok && page.text.trim()) {
    text = page.text.slice(0, TEXT_CAP);
    provider = "fetch";
    title = page.title;
  }

  baseSlice.trackingStack = trackingStack;

  const scrapeCost = provider === "firecrawl" ? creditsUsed * FIRECRAWL_CREDIT_USD : 0;

  if (!text) {
    return {
      url,
      domain,
      slice: baseSlice,
      title,
      source: "Firecrawl + AI",
      scrape: { ok: false, provider, chars: 0, creditsUsed },
      llm: { ran: false, model: null, tokensIn: 0, tokensOut: 0, error: null },
      cost: Number(scrapeCost.toFixed(4)),
      error: "Couldn't read this page — it may block bots, require JavaScript, or be unreachable.",
    };
  }

  const llm = await extractWithLlm({ url, text, title, adHeadline, adDescription });
  const f = llm.fields ?? EMPTY_FIELDS;

  const slice: LandingSlice = {
    domain,
    url,
    offer: f.offer,
    pricing: f.pricing.length ? f.pricing : null,
    primaryCta: f.primaryCta,
    valueProps: f.valueProps,
    socialProof: f.socialProof,
    funnelSteps: f.funnelSteps.length ? f.funnelSteps : null,
    trackingStack,
    adMessageMatch: f.adMessageMatch,
    matchRationale: f.matchRationale,
  };

  return {
    url,
    domain,
    slice,
    title,
    source: "Firecrawl + AI",
    scrape: { ok: true, provider, chars: text.length, creditsUsed },
    llm: { ran: llm.fields !== null, model: llm.model, tokensIn: llm.tokensIn, tokensOut: llm.tokensOut, error: llm.error },
    cost: Number(scrapeCost.toFixed(4)),
    error: llm.fields === null ? llm.error : null,
  };
}
