// ============================================================================
// In-app Benchmark Lab runner — 4 exact modes matching Pedro's n8n workflow.
//
// MODES:
//   keyword          → Oxylabs (keyword → ads + domains) only
//   company          → SerpApi Transparency (domain → creatives) only
//   extended         → Oxylabs → discover domains → SerpApi + Firecrawl OCR in parallel
//   extended_company → SerpApi + Firecrawl OCR (skip keyword search)
//
// TOOLS (exactly 3, matching the n8n nodes):
//   1. Oxylabs realtime.oxylabs.io — source:google_ads (keyword → advertisers)
//   2. SerpApi serpapi.com/search — engine:google_ads_transparency_center (domain → creatives)
//   3. Firecrawl OCR — ocr_image_simple_text (image URL → text)
//
// RULES:
//   - SerpApi: NO region by default (global) unless user asks
//   - Transparency report: only accepts DOMAINS, not company names
//   - Always return full image URLs (tpc.googlesyndication.com/...) never CR IDs
//   - Top 5 oldest ads by days_active
//   - Firecrawl OCR called in parallel on all image URLs
//   - Final analysis: the app's unified LLM layer (model/provider per /admin)
// ============================================================================

import { oxylabsKeywordAds } from "./oxylabs";
import { serpApiTransparency, type SerpApiTransparencyOpts } from "./serpapi-transparency";
import { ocrImagesBatch } from "./firecrawl-ocr";
import { computeAnalytics } from "./lab-analytics";
import { benchmarkNarrative } from "./llm";
import type {
  LabAd,
  LabAdvertiser,
  LabQuery,
  LabReport,
  LabSource,
  BenchmarkMode,
} from "./lab-types";
import type { BenchmarkCostContext } from "./types";

export function labRunnerConfigured(): boolean {
  const hasOxylabs =
    Boolean(process.env.OXYLABS_USERNAME?.trim() || process.env.OXYLABS_USER?.trim());
  const hasSerpApi =
    Boolean(process.env.SERPAPI_KEY?.trim() || process.env.SERPAPI_API_KEY?.trim());
  // keyword/extended need Oxylabs; company/extended_company only need SerpApi.
  // We report as configured if either is available.
  return hasOxylabs || hasSerpApi;
}

// ---------------------------------------------------------------------------
// SerpApi raw creative shape (what comes back from the API).
// ---------------------------------------------------------------------------
// Real SerpApi google_ads_transparency_center creative shape (confirmed by probe):
//   advertiser_id, advertiser (= legal name e.g. "Semrush INC"), ad_creative_id (CR…),
//   format, target_domain, image (FULL tpc.googlesyndication.com URL), width, height,
//   total_days_shown, first_shown/last_shown (UNIX seconds), details_link.
// Text-format creatives carry NO headline/description here — that text only comes
// from Oxylabs (keyword mode) or the Firecrawl OCR (extended mode).
interface RawTransCreative {
  advertiser?: string | null;
  advertiser_id?: string | null;
  advertiser_legal_name?: string | null;
  legal_name?: string | null;
  ad_creative_id?: string | null;
  target_domain?: string | null;
  format?: string | null;
  first_shown?: string | number | null;
  first_shown_date?: string | null;
  last_shown?: string | number | null;
  last_shown_date?: string | null;
  total_days_shown?: number | null;
  days?: number | null;
  image?: string | null;
  thumbnail?: string | null;
  preview?: string | null;
  details_link?: string | null;
  link?: string | null;
  final_url?: string | null;
  url?: string | null;
  headline?: string | null;
  description?: string | null;
  body?: string | null;
}

// UNIX-seconds (or ISO) → "YYYY-MM-DD" for display; null-safe.
function toDateStr(v: string | number | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    try { return new Date(v * 1000).toISOString().slice(0, 10); } catch { return null; }
  }
  return v;
}

function rawToLabAd(c: RawTransCreative, domain: string, keyword: string): LabAd & {
  imageUrlRaw?: string; daysActive: number | null; legalNameRaw?: string | null;
} {
  const daysActive =
    typeof c.total_days_shown === "number"
      ? c.total_days_shown
      : typeof c.days === "number"
        ? c.days
        : null;

  // Full image URL — prefer the actual image, NOT the CR id format.
  const imageUrl =
    (c.image?.startsWith("http") ? c.image : null) ??
    (c.thumbnail?.startsWith("http") ? c.thumbnail : null) ??
    (c.preview?.startsWith("http") ? c.preview : null) ??
    null;

  // Real landing isn't in the transparency payload — use the verified target
  // domain as the destination; details_link is the ad-detail page on Google.
  const landingUrl =
    c.final_url ?? c.url ?? (c.target_domain ? `https://${c.target_domain}` : null) ?? c.details_link ?? null;
  // Legal name lives in `advertiser` (e.g. "Semrush INC"), NOT advertiser_legal_name.
  const legal = c.advertiser_legal_name ?? c.legal_name ?? c.advertiser ?? null;

  return {
    advertiser: c.advertiser ?? null,
    advertiserDomain: c.target_domain ?? domain,
    legalName: legal,
    legalNameRaw: legal,
    format: c.format ?? "text",
    firstShown: toDateStr(c.first_shown ?? c.first_shown_date),
    lastShown: toDateStr(c.last_shown ?? c.last_shown_date),
    daysActive,
    imageUrl,
    imageUrlRaw: imageUrl ?? undefined,
    detailsLink: landingUrl,
    targetDomain: c.target_domain ?? domain,
    viaKeyword: keyword,
    headline: c.headline ?? null,
    cta: null,
  };
}

// ---------------------------------------------------------------------------
// DETERMINISTIC full report — computes EVERY section from the real data so the
// benchmark ALWAYS renders completely, with zero dependency on the (flaky) LLM.
// Rendered by <MarkdownReport> (GFM tables + clickable image/landing URLs).
// ---------------------------------------------------------------------------
const STOP = new Set([
  "the","a","an","and","or","for","to","of","in","on","with","your","you","our","my","is","are","be",
  "get","got","now","best","top","new","free","all","one","it","that","this","from","by","at","as","more",
  "most","up","out","no","yes","vs","&","el","la","los","las","un","una","y","o","para","de","del","en",
  "con","tu","tus","su","sus","mi","es","son","ya","lo","que","por","más","mas","mejor","gratis","nuevo","todo","todos",
]);
function tokenize(s: string | null | undefined): string[] {
  return (s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}
const goodTerm = (t: string) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t);

// Collapse plural/singular so "tool"/"tools", "agency"/"agencies" count together.
function normWord(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("es") && !/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -1);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function wordFreqRows(texts: string[], limit: number): { word: string; count: number; pct: number }[] {
  const docs = texts.map((t) => (t || "").trim()).filter(Boolean);
  const freq = new Map<string, number>();
  for (const t of docs) {
    for (const w of new Set(tokenize(t).filter(goodTerm).map(normWord))) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .map(([word, count]) => ({ word, count, pct: docs.length ? Math.round((count / docs.length) * 100) : 0 }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit);
}

const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Concrete, number-bearing USP claims pulled from the ad copy ("21 tools",
// "140+ SEO issues", "1000+ agencies", "save 30+ hours").
function extractUSPs(text: string | null | undefined): string[] {
  if (!text) return [];
  const frags = text.split(/[.•|]|—|\s-\s/).map((s) => s.trim()).filter(Boolean);
  return uniq(frags.filter((f) => /\d/.test(f) && f.length >= 4 && f.length <= 55)).slice(0, 4);
}

const ACTION =
  /\b(get|try|track|save|fix|compare|start|boost|reach|optimi[sz]e|score|deliver|run|improve|create|build|find|see|learn|download|sign up|book|request|automate|generate|grow|manage|scale|join|discover|unlock|drive)\b/i;

// CTAs = sitelink extensions + imperative phrases mined from the copy.
function extractCTAs(ad: LabAd | null | undefined, sitelinks: string[]): string[] {
  const out: string[] = [...sitelinks];
  const text = `${ad?.headline ?? ""}. ${ad?.description ?? ""}`;
  for (const frag of text.split(/[.•|]|—/).map((s) => s.trim())) {
    if (ACTION.test(frag) && frag.length >= 6 && frag.length <= 50) out.push(frag);
  }
  return uniq(out).slice(0, 6);
}

function buildFullReport(query: LabQuery, advertisers: LabAdvertiser[]): string {
  const L: string[] = [];
  L.push(`# Competitive Intelligence Report`, ``);

  if (!advertisers.length) {
    L.push(`No advertisers were found running ads for **${query.keywords.join(", ")}** in ${query.countryName} right now.`);
    L.push(``, `_This can happen when no one is bidding on the term at this moment, or for a very niche query. Try a broader keyword._`);
    return L.join("\n");
  }

  const allAds = advertisers.flatMap((a) => a.oldestTop5);
  // Ad-copy corpus: include the Oxylabs topAd (transparency creatives carry no text).
  const copyAds = advertisers.flatMap((a) => [a.topAd, ...a.oldestTop5].filter((x): x is LabAd => Boolean(x)));
  const headlines = copyAds.map((a) => a.headline).filter((x): x is string => Boolean(x));
  const descriptions = copyAds.map((a) => a.description).filter((x): x is string => Boolean(x));
  const days = allAds.map((a) => a.daysActive ?? 0).filter((n) => n > 0);
  const avg = days.length ? Math.round(days.reduce((s, n) => s + n, 0) / days.length) : 0;
  const totalAds = advertisers.reduce((n, a) => n + a.totalAds, 0);

  // ---- Overview ----
  L.push(`## Competitive Landscape Overview`);
  L.push(`- **Query / input:** ${query.keywords.join(", ")}`);
  L.push(`- **Country analyzed:** ${query.countryName}`);
  L.push(`- **Total ads found:** ${totalAds}`);
  L.push(`- **Competitors (unique domains):** ${advertisers.length}`);
  if (avg > 0) L.push(`- **Average ad age:** ${avg} days`);
  L.push(``);

  // ---- Top competitors & their ad strategies ----
  L.push(`## Top Competitors & Their Ad Strategies`);
  advertisers.slice(0, 10).forEach((a, i) => {
    const ad = a.topAd ?? a.oldestTop5[0];
    const legal = a.oldestTop5.find((x) => x.legalName)?.legalName ?? a.topAd?.legalName;
    const sitelinks = uniq([...(a.topAd?.sitelinks ?? []), ...a.oldestTop5.flatMap((x) => x.sitelinks ?? [])]);
    L.push(``, `### ${i + 1}. ${a.domain}${legal ? ` (${legal})` : ""} — ${a.totalAds} ad(s)`);
    L.push(`| Attribute | Details |`, `| --- | --- |`);
    if (ad?.position) L.push(`| Ad position | #${ad.position} |`);
    if (ad?.headline) L.push(`| Headline | ${ad.headline} |`);
    if (ad?.description) L.push(`| Description | ${ad.description} |`);
    const landing = ad?.detailsLink ?? a.sampleUrl;
    if (landing) L.push(`| Landing page | ${landing} |`);
    if (ad?.campaign) L.push(`| Campaign label | ${ad.campaign} |`);
    const usps = extractUSPs(ad?.description);
    if (usps.length) L.push(`| Key USPs | ${usps.join(" · ")} |`);
    if (sitelinks.length) L.push(`| Sitelinks | ${sitelinks.slice(0, 6).join(", ")} |`);
    const ctas = extractCTAs(ad, sitelinks);
    if (ctas.length) L.push(`| CTAs detected | ${ctas.join(" · ")} |`);
    if (a.viaKeywords.length) L.push(`| Seen on keyword(s) | ${a.viaKeywords.join(", ")} |`);
  });
  L.push(``);

  // ---- Top 5 oldest ads (only when transparency images exist) ----
  const withImages = allAds.filter((a) => a.imageUrl && (a.daysActive ?? 0) > 0)
    .sort((a, b) => (b.daysActive ?? 0) - (a.daysActive ?? 0));
  if (withImages.length) {
    L.push(`## Top 5 Oldest Ads (longest-running = proven winners)`);
    L.push(`| Advertiser | Days active | Image URL | Landing |`, `| --- | --- | --- | --- |`);
    for (const ad of withImages.slice(0, 5)) {
      L.push(`| ${ad.advertiser ?? ad.advertiserDomain ?? "—"} | ${ad.daysActive} | ${ad.imageUrl} | ${ad.detailsLink ?? "—"} |`);
    }
    L.push(``);
  }

  // ---- Ad copy & headlines analysis ----
  L.push(`## Ad Copy & Headlines Analysis`);
  if (headlines.length) {
    L.push(``, `**Most used words in headlines** (${headlines.length} headlines):`);
    L.push(`| Word | Frequency | % of headlines |`, `| --- | --- | --- |`);
    for (const r of wordFreqRows(headlines, 10)) L.push(`| ${r.word} | ${r.count}/${headlines.length} | ${r.pct}% |`);
  }
  if (descriptions.length) {
    L.push(``, `**Most used words in descriptions** (${descriptions.length} descriptions):`);
    L.push(`| Word | Frequency | % of descriptions |`, `| --- | --- | --- |`);
    for (const r of wordFreqRows(descriptions, 10)) L.push(`| ${r.word} | ${r.count}/${descriptions.length} | ${r.pct}% |`);
  }
  if (!headlines.length && !descriptions.length) {
    L.push(`Ad copy text isn't available for these creatives (image ads — run Extended mode for OCR text).`);
  }
  L.push(``);

  // ---- Keyword ranking recommendations (clean, split High-Priority / Niche) ----
  const corpus = [...headlines, ...descriptions];
  const terms = wordFreqRows(corpus, 20).map((r) => r.word).filter((t) => t.length > 2);
  const qset = new Set(query.keywords.map((k) => k.toLowerCase().trim()));
  const primary = (query.keywords[0] ?? "").toLowerCase().trim();
  const cat = primary.replace(/^(best|top|cheap|free)\s+/i, "").trim() || primary; // "ai seo tools"
  const catWords = cat.split(/\s+/);
  const tail = catWords[catWords.length - 1] || "tools";            // "tools"
  const base = catWords.slice(0, -1).join(" ") || cat;              // "ai seo"
  // High-priority: the query + commercial-intent variants anchored to the category.
  const high = uniq(
    [
      primary,
      cat,
      `${base} software`,
      `${base} platform`,
      `${cat} pricing`,
      `${cat} comparison`,
      `${base} for agencies`,
      `${base} reviews`,
    ].map((s) => s.trim()).filter((k) => k.length > 3),
  ).slice(0, 10);
  // Niche: the distinctive terms competitors actually use, as buyable phrases —
  // dropping generic words that make weak keywords ("issue tools", "brand tools").
  const catSet = new Set(catWords);
  const NICHE_STOP = new Set([
    "search", "brand", "brands", "insight", "insights", "result", "results", "issue", "issues",
    "content", "traffic", "online", "platform", "tool", "team", "teams", "data", "report", "reports",
    "time", "way", "ways", "customer", "customers", "growth", "performance", "reach", "score", "boost",
  ]);
  const niche = uniq(
    terms
      .filter((t) => !catSet.has(t) && !qset.has(t) && t.length > 2 && !NICHE_STOP.has(t))
      .slice(0, 6)
      .map((t) => `${t} ${tail}`),
  ).slice(0, 6);
  L.push(`## Keyword Ranking Recommendations`);
  L.push(`Mined from the terms competitors actually use in their ads.`, ``);
  L.push(`**🔥 High-priority keywords**`);
  high.forEach((k) => L.push(`- ${k}`));
  if (niche.length) {
    L.push(``, `**🔍 Niche / angle keywords**`);
    niche.forEach((k) => L.push(`- ${k}`));
  }
  L.push(``);

  // ---- Brand-vs-competitor detection ----
  const brandTokens = new Set(advertisers.flatMap((a) => (a.domain.split(".")[0] || "").split(/[-_]/).filter((t) => t.length > 2)));
  const vs: string[] = [];
  for (const a of advertisers) {
    const own = new Set((a.domain.split(".")[0] || "").split(/[-_]/));
    const text = [a.topAd, ...a.oldestTop5].map((x) => `${x?.headline ?? ""} ${x?.description ?? ""}`).join(" ").toLowerCase();
    const namesRival = [...brandTokens].some((t) => !own.has(t) && text.includes(t));
    if (namesRival || /\b(vs|versus|alternative|compare|better than)\b/.test(text)) vs.push(a.domain);
  }
  L.push(`## Brand vs. Competitor Strategy`);
  L.push(vs.length
    ? `**Yes** — these advertisers reference rival brands or comparison angles in their copy: ${uniq(vs).join(", ")}.`
    : `**No** — no advertiser is openly bidding on or naming a competitor brand in the copy we captured.`);
  L.push(``);

  // ---- Landing page strategy ----
  L.push(`## Landing Page Strategy`);
  L.push(`| Competitor | Landing page | Campaign |`, `| --- | --- | --- |`);
  for (const a of advertisers.slice(0, 10)) {
    const ad = a.topAd ?? a.oldestTop5[0];
    L.push(`| ${a.domain} | ${ad?.detailsLink ?? a.sampleUrl ?? "—"} | ${ad?.campaign ?? "—"} |`);
  }
  L.push(``);

  // ---- Strategic recommendations (data-derived) ----
  const topHead = wordFreqRows(headlines, 4).map((r) => r.word);
  const topDesc = wordFreqRows(descriptions, 4).map((r) => r.word);
  const topSitelinks = uniq(advertisers.flatMap((a) => [...(a.topAd?.sitelinks ?? []), ...a.oldestTop5.flatMap((x) => x.sitelinks ?? [])]));
  const allUSPs = uniq(advertisers.flatMap((a) => extractUSPs(a.topAd?.description))).slice(0, 6);
  L.push(`## Strategic Recommendations`);
  if (topHead.length) L.push(`- **Winning headline pattern:** lead with ${topHead.map((w) => `\`${w}\``).join(", ")} — the terms most competitors put in their headlines.`);
  if (topDesc.length) L.push(`- **Description angles to test:** ${topDesc.map((w) => `\`${w}\``).join(", ")}.`);
  if (allUSPs.length) L.push(`- **Proof points rivals lean on:** ${allUSPs.join(" · ")} — counter with your own concrete numbers.`);
  if (topSitelinks.length) L.push(`- **Sitelinks to add:** ${topSitelinks.slice(0, 6).join(", ")} — match or beat these.`);
  L.push(`- **Gaps to exploit:** angles few/none use — pricing transparency, speed ("in minutes"), small-business focus, guarantees/ROI. These stand out in a crowded auction.`);
  L.push(``);

  // ---- Competitive positioning map (2×2: ad volume × creative breadth) ----
  if (advertisers.length >= 2) {
    const pts = advertisers.slice(0, 8).map((a) => ({
      name: (a.domain.split(".")[0] || a.domain).toUpperCase(),
      vol: a.totalAds,
      breadth:
        uniq([...(a.topAd?.sitelinks ?? []), ...a.oldestTop5.flatMap((x) => x.sitelinks ?? [])]).length +
        extractUSPs(a.topAd?.description).length,
    }));
    const mv = median(pts.map((p) => p.vol));
    const mb = median(pts.map((p) => p.breadth));
    const q: Record<"tl" | "tr" | "bl" | "br", string[]> = { tl: [], tr: [], bl: [], br: [] };
    for (const p of pts) {
      const top = p.breadth >= mb;
      const right = p.vol >= mv;
      q[top ? (right ? "tr" : "tl") : right ? "br" : "bl"].push(p.name);
    }
    const cell = (xs: string[]) => (xs.length ? xs.join(", ") : "—");
    L.push(`## Competitive Positioning Map`);
    L.push("```");
    L.push("BROAD CREATIVE / MANY EXTENSIONS");
    L.push(`  ${cell(q.tl)}   │   ${cell(q.tr)}`);
    L.push("  ───────────────────────┼───────────────────────");
    L.push(`  ${cell(q.bl)}   │   ${cell(q.br)}`);
    L.push("FOCUSED          LOW AD VOLUME → HIGH AD VOLUME");
    L.push("```");
    L.push(``);
  }

  // ---- Legal entities (ranked by ad presence) ----
  const legals = advertisers
    .map((a) => ({ domain: a.domain, legal: a.oldestTop5.find((x) => x.legalName)?.legalName, ads: a.totalAds }))
    .filter((x) => x.legal)
    .sort((a, b) => b.ads - a.ads);
  if (legals.length) {
    L.push(`## Legal Entities Running Ads`);
    legals.forEach((x, i) =>
      L.push(`- **${x.legal}** (${x.domain})${i === 0 ? " — biggest ad presence" : ""} · ${x.ads} ads tracked`),
    );
    L.push(``);
  }

  return L.join("\n");
}

async function analyze(
  query: LabQuery,
  mode: BenchmarkMode,
  advertisers: LabAdvertiser[],
  cost: BenchmarkCostContext
): Promise<{ model: string; markdown: string } | null> {
  if (!advertisers.length) return null;

  // The DETERMINISTIC report is the guaranteed base — every section, always,
  // straight from the data. No LLM dependency for completeness ("siempre sale").
  const base = buildFullReport(query, advertisers);

  // Best-effort AI strategic narrative ON TOP, from a SMALL summary (not raw JSON).
  // Uses a PLAIN-TEXT call (no schema) so it works with the /admin model even when
  // that model is weak at structured output. If it fails, the report is complete.
  const summary = advertisers.slice(0, 8).map((a) => ({
    domain: a.domain,
    totalAds: a.totalAds,
    legal: a.oldestTop5.find((x) => x.legalName)?.legalName ?? null,
    topAd: a.topAd
      ? { headline: a.topAd.headline, description: a.topAd.description, campaign: a.topAd.campaign, sitelinks: a.topAd.sitelinks, landing: a.topAd.detailsLink }
      : null,
    oldestDays: a.oldestTop5.map((x) => x.daysActive ?? 0).filter((n) => n > 0).slice(0, 3),
  }));
  const narrative = await benchmarkNarrative({
    cost,
    maxTokens: 2200,
    system:
      `You are a senior Google Ads strategist. From the competitor ad data, write a sharp STRATEGIC ANALYSIS ` +
      `in the brand's language (language code: ${query.language}). Cover, with specifics from the data: ` +
      `(1) the headline/angle patterns that win, (2) description angles to test, (3) sitelinks to add, ` +
      `(4) gaps NO competitor covers, (5) each competitor's positioning in one line. ` +
      `GitHub-flavored Markdown, concise, decision-ready. Use ONLY the data provided; invent nothing. ` +
      `Do NOT repeat raw tables — give the "so what, do this" interpretation.`,
    prompt:
      `Keyword/input: ${query.keywords.join(", ")} · Country: ${query.countryName} · Mode: ${mode}\n` +
      `Competitor ad data (JSON):\n${JSON.stringify(summary)}`,
  });
  const aiSection = narrative ? `\n\n---\n\n## AI Strategic Analysis\n\n${narrative}` : "";

  return {
    model: aiSection ? "Data report + AI strategy" : "Deterministic (always complete)",
    markdown: base + aiSection,
  };
}

// ---------------------------------------------------------------------------
// MODE: keyword — Oxylabs only.
// Input: a keyword. Returns structured report of who's advertising on it.
// ---------------------------------------------------------------------------
async function runKeywordMode(
  query: LabQuery,
  cost: BenchmarkCostContext
): Promise<{ advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] }> {
  const byDomain = new Map<string, LabAdvertiser>();
  const rawForLlm: unknown[] = [];
  const allImageUrls: string[] = [];

  // Oxylabs calls in PARALLEL (were sequential).
  const results = await Promise.all(
    query.keywords.map(async (keyword) => ({ keyword, result: await oxylabsKeywordAds(keyword, query.geo, cost) }))
  );

  for (const { keyword, result } of results) {
    rawForLlm.push(result);

    for (const ad of result.ads) {
      if (!ad.domain) continue;
      const key = ad.domain.replace(/^www\./, "").toLowerCase();
      let adv = byDomain.get(key);
      if (!adv) {
        adv = {
          domain: key,
          source: "oxylabs",
          totalAds: 0,
          oldestTop5: [],
          sampleHeadline: ad.title ?? null,
          sampleUrl: ad.url ?? ad.destinationUrl ?? null,
          viaKeywords: [],
        };
        byDomain.set(key, adv);
      }
      if (!adv.viaKeywords.includes(keyword)) adv.viaKeywords.push(keyword);
      adv.totalAds++;

      // Build a rich LabAd from the Oxylabs ad — this is the keyword-mode data
      // that feeds every report section (headline, description, landing, campaign,
      // sitelinks, CTAs, position).
      const sitelinks = (ad.sitelinks ?? []).map((s) => s.title).filter((t): t is string => Boolean(t));
      const labAd: LabAd = {
        advertiser: ad.title ?? null,
        advertiserDomain: key,
        legalName: null,
        format: "text",
        firstShown: null,
        lastShown: null,
        daysActive: null,
        imageUrl: null,
        detailsLink: ad.url ?? ad.destinationUrl ?? null,
        targetDomain: key,
        viaKeyword: keyword,
        headline: ad.title ?? null,
        description: ad.description ?? null,
        campaign: ad.campaignLabel ?? ad.campaign ?? null,
        sitelinks,
        position: ad.position ?? null,
        cta: sitelinks[0] ?? null,
      };
      if (!adv.topAd) adv.topAd = labAd; // representative ad with copy
      if (adv.oldestTop5.length < 5) adv.oldestTop5.push(labAd);
    }
  }

  return {
    advertisers: [...byDomain.values()].slice(0, query.numCompetitors),
    rawData: rawForLlm,
    allImageUrls,
  };
}

// ---------------------------------------------------------------------------
// MODE: company — SerpApi Transparency only.
// Input: domain(s). Returns creatives for each domain.
// NOTE: Transparency report ONLY accepts domains, not company names.
// ---------------------------------------------------------------------------

// Resolve the effective Transparency params for a run: manual values from the
// Lab's advanced panel win; otherwise NO region (global) per Pedro's rule.
function serpParamsFor(
  query: LabQuery,
  regionOverride: string | null
): { region: string | null; num: number; opts: SerpApiTransparencyOpts } {
  const t = query.transparency ?? {};
  return {
    region: (t.region && t.region.trim()) || regionOverride || null,
    num: t.num ?? 100,
    opts: {
      platform: t.platform ?? null,
      creativeFormat: t.creativeFormat ?? null,
      advertiserId: t.advertiserId ?? null,
      startDate: t.startDate ?? null,
      endDate: t.endDate ?? null,
      num: t.num ?? null,
    },
  };
}

async function runCompanyMode(
  query: LabQuery,
  cost: BenchmarkCostContext,
  regionOverride: string | null = null
): Promise<{ advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] }> {
  const byDomain = new Map<string, LabAdvertiser>();
  const rawForLlm: unknown[] = [];
  const allImageUrls: string[] = [];
  const { region, num, opts } = serpParamsFor(query, regionOverride);

  // In company mode, the "keywords" field holds the domain(s) to look up.
  const domains = query.keywords.slice(0, query.numCompetitors);

  for (const domain of domains) {
    // Clean to bare domain (transparency only accepts domains).
    const cleanDomain = domain
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .toLowerCase()
      .trim();

    const result = await serpApiTransparency(cleanDomain, region, cost, num, opts);
    const rawAds = result.rawCreatives as RawTransCreative[];

    const labAds: LabAd[] = rawAds.map((c) => {
      const ad = rawToLabAd(c, cleanDomain, cleanDomain);
      if (ad.imageUrl) allImageUrls.push(ad.imageUrl);
      return ad;
    });

    // Sort oldest-first.
    labAds.sort((a, b) => (b.daysActive ?? 0) - (a.daysActive ?? 0));

    const adv: LabAdvertiser = {
      domain: cleanDomain,
      source: "serpapi",
      totalAds: result.totalAds,
      oldestTop5: labAds.slice(0, 5),
      sampleHeadline: labAds[0]?.headline ?? null,
      sampleUrl: labAds[0]?.detailsLink ?? null,
      viaKeywords: [cleanDomain],
    };
    byDomain.set(cleanDomain, adv);

    rawForLlm.push({
      domain: cleanDomain,
      total_ads: result.totalAds,
      region: result.region,
      ads: rawAds,
    });
  }

  return {
    advertisers: [...byDomain.values()],
    rawData: rawForLlm,
    allImageUrls,
  };
}

// ---------------------------------------------------------------------------
// MODE: extended — Oxylabs keyword search → discover domains → SerpApi + OCR.
// MODE: extended_company — SerpApi + OCR only (no keyword search step).
// ---------------------------------------------------------------------------
async function runExtendedMode(
  query: LabQuery,
  cost: BenchmarkCostContext,
  skipKeywordSearch: boolean,
  regionOverride: string | null = null,
  skipOcr = false
): Promise<{ advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] }> {
  const byDomain = new Map<string, LabAdvertiser>();
  const rawForLlm: unknown[] = [];
  const allImageUrls: string[] = [];
  const { region, num, opts } = serpParamsFor(query, regionOverride);

  let discoveredDomains: string[] = [];
  // Keep the Oxylabs ad COPY per domain (headline/description/campaign/sitelinks);
  // transparency creatives have no text, so this is what feeds the per-competitor
  // cards. Without it, extended-mode cards were thin (landing only).
  const oxyAdByDomain = new Map<string, LabAd>();

  if (!skipKeywordSearch) {
    // Step 1: Oxylabs — keyword → advertiser domains. In PARALLEL (was sequential,
    // which stacked up wall-clock and helped freeze the brand run).
    const oxyResults = await Promise.all(
      query.keywords.map((keyword) => oxylabsKeywordAds(keyword, query.geo, cost))
    );
    for (const result of oxyResults) {
      rawForLlm.push({ step: "oxylabs", ...result });
      for (const domain of result.advertisers) {
        if (!discoveredDomains.includes(domain)) discoveredDomains.push(domain);
      }
      for (const ad of result.ads) {
        if (!ad.domain || oxyAdByDomain.has(ad.domain)) continue;
        const sitelinks = (ad.sitelinks ?? []).map((s) => s.title).filter((t): t is string => Boolean(t));
        oxyAdByDomain.set(ad.domain, {
          advertiser: ad.title ?? null,
          advertiserDomain: ad.domain,
          legalName: null,
          format: "text",
          firstShown: null,
          lastShown: null,
          daysActive: null,
          imageUrl: null,
          detailsLink: ad.url ?? ad.destinationUrl ?? null,
          targetDomain: ad.domain,
          viaKeyword: result.keyword,
          headline: ad.title ?? null,
          description: ad.description ?? null,
          campaign: ad.campaignLabel ?? ad.campaign ?? null,
          sitelinks,
          position: ad.position ?? null,
          cta: sitelinks[0] ?? null,
        });
      }
    }
    discoveredDomains = discoveredDomains.slice(0, query.numCompetitors);
  } else {
    // extended_company: use keywords as domain list directly.
    discoveredDomains = query.keywords
      .map((k) =>
        k.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase().trim()
      )
      .filter(Boolean)
      .slice(0, query.numCompetitors);
  }

  // Step 2: SerpApi Transparency per domain + collect image URLs — in parallel.
  const transparencyResults = await Promise.all(
    discoveredDomains.map((domain) =>
      serpApiTransparency(domain, region, cost, num, opts)
    )
  );

  // Collect all image URLs for OCR batch.
  const imageUrlsByDomain = new Map<string, string[]>();
  for (let i = 0; i < discoveredDomains.length; i++) {
    const domain = discoveredDomains[i];
    const result = transparencyResults[i];
    const rawAds = result.rawCreatives as RawTransCreative[];
    const domainImages: string[] = [];

    const labAds: LabAd[] = rawAds.map((c) => {
      const ad = rawToLabAd(c, domain, query.keywords[0] ?? domain);
      if (ad.imageUrl) {
        domainImages.push(ad.imageUrl);
        allImageUrls.push(ad.imageUrl);
      }
      return ad;
    });

    labAds.sort((a, b) => (b.daysActive ?? 0) - (a.daysActive ?? 0));
    imageUrlsByDomain.set(domain, domainImages);

    const oxyAd = oxyAdByDomain.get(domain) ?? null;
    byDomain.set(domain, {
      domain,
      source: "serpapi",
      totalAds: result.totalAds,
      oldestTop5: labAds.slice(0, 5),
      sampleHeadline: oxyAd?.headline ?? labAds[0]?.headline ?? null,
      sampleUrl: oxyAd?.detailsLink ?? labAds[0]?.detailsLink ?? null,
      viaKeywords: [oxyAd?.viaKeyword ?? query.keywords[0] ?? domain].filter((x): x is string => Boolean(x)),
      // Oxylabs copy for the per-competitor card; transparency creatives stay in oldestTop5.
      topAd: oxyAd,
    });

    rawForLlm.push({
      step: "serpapi",
      domain,
      total_ads: result.totalAds,
      region: result.region,
      ads: rawAds,
    });
  }

  // Step 3: Firecrawl OCR — all image URLs in parallel. Skippable (the brand
  // benchmark runs Oxylabs→domains→transparency only, no OCR).
  if (!skipOcr && allImageUrls.length > 0) {
    const ocrMap = await ocrImagesBatch(allImageUrls);
    rawForLlm.push({
      step: "ocr",
      texts: Object.fromEntries(ocrMap),
    });
  }

  return {
    advertisers: [...byDomain.values()],
    rawData: rawForLlm,
    allImageUrls,
  };
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------
export async function runBenchmarkLabInApp(
  query: LabQuery,
  cost?: BenchmarkCostContext,
  regionOverride: string | null = null,   // null = global (don't send region to SerpApi)
  opts?: { skipOcr?: boolean }
): Promise<LabReport> {
  const costCtx: BenchmarkCostContext = cost ?? {
    userId: null, brandId: null, workspaceId: null, runId: null,
  };

  const mode: BenchmarkMode = query.mode;
  const skipOcr = opts?.skipOcr ?? false;
  let result: { advertisers: LabAdvertiser[]; rawData: unknown[]; allImageUrls: string[] };

  switch (mode) {
    case "company":
      result = await runCompanyMode(query, costCtx, regionOverride);
      break;
    case "extended":
      result = await runExtendedMode(query, costCtx, false, regionOverride, skipOcr);
      break;
    case "extended_company":
      result = await runExtendedMode(query, costCtx, true, regionOverride, skipOcr);
      break;
    case "keyword":
    default:
      result = await runKeywordMode(query, costCtx);
      break;
  }

  const { advertisers, allImageUrls } = result;

  // Report = deterministic full teardown (always complete) + best-effort AI strategy.
  const analysis = await analyze(query, mode, advertisers, costCtx);

  // Aggregate stats.
  const allAds = advertisers.flatMap((a) => a.oldestTop5);
  const topOldestAds = [...allAds]
    .sort((a, b) => (b.daysActive ?? 0) - (a.daysActive ?? 0))
    .slice(0, 6);
  const totalAds = advertisers.reduce((n, a) => n + a.totalAds, 0);
  const daysList = allAds.map((a) => a.daysActive ?? 0).filter((n) => n > 0);
  const avgDaysActive = daysList.length
    ? Math.round(daysList.reduce((s, n) => s + n, 0) / daysList.length)
    : 0;
  const oldestDays = daysList.length ? Math.max(...daysList) : 0;

  const sources: LabSource[] = [];
  if (mode === "keyword" || mode === "extended") {
    sources.push({
      label: "Keyword ad discovery",
      provider: "Oxylabs · google_ads",
      detail: `Real Google Search ads for: ${query.keywords.join(", ")} in ${query.countryName}`,
      live: true,
    });
  }
  if (mode !== "keyword") {
    sources.push({
      label: "Ad creatives & age",
      provider: "SerpApi · Transparency Center",
      detail: `Active creatives per domain${regionOverride ? ` · region ${regionOverride}` : " · global"}`,
      live: true,
    });
  }
  if ((mode === "extended" || mode === "extended_company") && allImageUrls.length > 0) {
    sources.push({
      label: "Ad image text (OCR)",
      provider: "Firecrawl · ocr_image_simple_text",
      detail: `Text extracted from ${allImageUrls.length} ad image(s) in parallel`,
      live: true,
    });
  }
  if (analysis) {
    sources.push({
      label: "Strategic teardown",
      provider: `OpenRouter · ${analysis.model}`,
      detail: "Professional competitor analysis per Pedro's benchmark spec",
      live: true,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    demo: false,
    query,
    summary: {
      advertisers: advertisers.length,
      totalAds,
      avgDaysActive,
      oldestDays,
      keywordsAnalyzed: query.keywords.length,
    },
    advertisers,
    topOldestAds,
    analytics: computeAnalytics(advertisers, query),
    analysis: analysis ? { model: analysis.model, language: query.language, markdown: analysis.markdown } : null,
    sources,
  };
}
