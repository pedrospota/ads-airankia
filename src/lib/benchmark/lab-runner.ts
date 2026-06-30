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
import { benchmarkReport } from "./llm";
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

// Truncate long copy so it stays readable inside a Markdown table cell; also
// strips pipes/newlines that would break the table.
function clip(s: string | null | undefined, max: number): string {
  const t = (s ?? "").replace(/\s*[|\r\n]+\s*/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t || "—";
}

// Normalize any user/API input to a bare registrable domain ("https://www.X.com/a" → "x.com").
function cleanDomain(d: string): string {
  return d.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase().trim();
}
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

// Localized labels for the deterministic appended sections (gallery, word-freq,
// footer) so a non-English AI report doesn't abruptly switch to English. en + es
// cover the active markets; anything else falls back to English.
function labels(lang: string) {
  const es = (lang || "").toLowerCase().startsWith("es");
  return es
    ? {
        displayHeading: "🖼️ Anuncios Display — Creativos Visuales",
        displayIntro: "Creativos de imagen/video activos ahora, del Centro de Transparencia de Google Ads (los más antiguos primero = ganadores probados).",
        competitor: "Competidor", creative: "Creativo", ocrCol: "Texto en el creativo (OCR)", daysActive: "Días activo", landing: "Landing",
        ocrHint: "_Activa **OCR** para leer el texto exacto de cada creativo._",
        wordFreqHeading: "📊 Palabras más usadas (conteo exacto, de los datos)",
        headlineWords: "Palabras más usadas en titulares", descriptionWords: "Palabras más usadas en descripciones",
        word: "Palabra", frequency: "Frecuencia",
        writtenBy: "Escrito por", grounded: "basado en datos reales de anuncios", tokensNa: "uso de tokens no disponible",
      }
    : {
        displayHeading: "🖼️ Display Ads — Visual Creatives",
        displayIntro: "Image/video creatives running right now, from the Google Ads Transparency Center (longest-running first = proven winners).",
        competitor: "Competitor", creative: "Creative", ocrCol: "Text on creative (OCR)", daysActive: "Days active", landing: "Landing",
        ocrHint: "_Turn on **OCR** to read the exact text written on each creative._",
        wordFreqHeading: "📊 Most-used words (exact counts, from the data)",
        headlineWords: "Most-used words in headlines", descriptionWords: "Most-used words in descriptions",
        word: "Word", frequency: "Frequency",
        writtenBy: "Written by", grounded: "grounded in live ad data", tokensNa: "token usage unavailable",
      };
}

// The 🖼️ Display Ads gallery (photos + OCR text) — reused by both the
// deterministic report and the AI-first path (appended after the AI write-up so
// the creative photos ALWAYS render, even though the LLM writes the prose).
function buildDisplaySection(advertisers: LabAdvertiser[], lang = "en"): string {
  const displayAds = advertisers.flatMap((a) =>
    a.oldestTop5.filter((ad) => Boolean(ad.imageUrl)).map((ad) => ({ ad, domain: a.domain })),
  );
  if (!displayAds.length) return "";
  const t = labels(lang);
  const sorted = [...displayAds].sort((a, b) => (b.ad.daysActive ?? 0) - (a.ad.daysActive ?? 0));
  const anyOcr = sorted.some((x) => x.ad.ocrText);
  const L: string[] = [];
  L.push(`## ${t.displayHeading}`);
  L.push(t.displayIntro, ``);
  if (anyOcr) {
    L.push(`| ${t.competitor} | ${t.creative} | ${t.ocrCol} | ${t.daysActive} |`, `| --- | --- | --- | --- |`);
    for (const { ad, domain } of sorted.slice(0, 15)) {
      L.push(`| ${domain} | ![ad](${ad.imageUrl}) | ${clip(ad.ocrText, 130)} | ${ad.daysActive ?? "—"} |`);
    }
  } else {
    L.push(`| ${t.competitor} | ${t.creative} | ${t.landing} | ${t.daysActive} |`, `| --- | --- | --- | --- |`);
    for (const { ad, domain } of sorted.slice(0, 15)) {
      L.push(`| ${domain} | ![ad](${ad.imageUrl}) | ${ad.detailsLink ?? "—"} | ${ad.daysActive ?? "—"} |`);
    }
    L.push(``, t.ocrHint);
  }
  return L.join("\n");
}

// Exact word-frequency tables (computed from the data, never LLM-counted) — the
// LLM is told NOT to fabricate these counts; we append the real ones instead.
function buildWordFreqSection(advertisers: LabAdvertiser[], lang = "en"): string {
  const copyAds = advertisers.flatMap((a) => [a.topAd, ...a.oldestTop5].filter((x): x is LabAd => Boolean(x)));
  const headlines = copyAds.map((a) => a.headline).filter((x): x is string => Boolean(x));
  const ocrTexts = advertisers.flatMap((a) => a.oldestTop5).map((a) => a.ocrText).filter((x): x is string => Boolean(x));
  const descriptions = [...copyAds.map((a) => a.description).filter((x): x is string => Boolean(x)), ...ocrTexts];
  if (!headlines.length && !descriptions.length) return "";
  const t = labels(lang);
  const L: string[] = [];
  L.push(`## ${t.wordFreqHeading}`);
  if (headlines.length) {
    L.push(``, `**${t.headlineWords}** (${headlines.length}):`);
    L.push(`| ${t.word} | ${t.frequency} | % |`, `| --- | --- | --- |`);
    for (const r of wordFreqRows(headlines, 10)) L.push(`| ${r.word} | ${r.count}/${headlines.length} | ${r.pct}% |`);
  }
  if (descriptions.length) {
    L.push(``, `**${t.descriptionWords}** (${descriptions.length}):`);
    L.push(`| ${t.word} | ${t.frequency} | % |`, `| --- | --- | --- |`);
    for (const r of wordFreqRows(descriptions, 10)) L.push(`| ${r.word} | ${r.count}/${descriptions.length} | ${r.pct}% |`);
  }
  return L.join("\n");
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
  // Display creatives = ads carrying a visual (image/video) from Transparency.
  const displayAds = advertisers.flatMap((a) =>
    a.oldestTop5.filter((ad) => Boolean(ad.imageUrl)).map((ad) => ({ ad, domain: a.domain })),
  );
  // Ad-copy corpus: Oxylabs topAd text (transparency creatives carry no text) + OCR.
  const copyAds = advertisers.flatMap((a) => [a.topAd, ...a.oldestTop5].filter((x): x is LabAd => Boolean(x)));
  const headlines = copyAds.map((a) => a.headline).filter((x): x is string => Boolean(x));
  const descriptions = copyAds.map((a) => a.description).filter((x): x is string => Boolean(x));
  const ocrTexts = allAds.map((a) => a.ocrText).filter((x): x is string => Boolean(x));
  const days = allAds.map((a) => a.daysActive ?? 0).filter((n) => n > 0);
  const avg = days.length ? Math.round(days.reduce((s, n) => s + n, 0) / days.length) : 0;
  const totalAds = advertisers.reduce((n, a) => n + a.totalAds, 0);

  // ---- Overview ----
  L.push(`## Competitive Landscape Overview`);
  L.push(`- **Query / input:** ${query.keywords.join(", ")}`);
  L.push(`- **Country analyzed:** ${query.countryName}`);
  L.push(`- **Total ads found:** ${totalAds}`);
  L.push(`- **Competitors (unique domains):** ${advertisers.length}`);
  L.push(`- **Search text ads / Display creatives:** ${headlines.length} / ${displayAds.length}`);
  if (avg > 0) L.push(`- **Average ad age:** ${avg} days`);
  L.push(``);

  // ===================== 🔍 SEARCH ADS =====================
  L.push(`## 🔍 Search Ads — Competitor Teardown`);
  if (!headlines.length && !descriptions.length) {
    L.push(
      `_No Search text ads captured here. Keyword & Extended modes pull Search ad copy from Oxylabs; for image-only competitors, enable **OCR** to read the text off the Display creatives below._`,
    );
  }
  advertisers.slice(0, 10).forEach((a, i) => {
    const ad = a.topAd ?? a.oldestTop5.find((x) => x.headline) ?? a.oldestTop5[0];
    const legal = a.oldestTop5.find((x) => x.legalName)?.legalName ?? a.topAd?.legalName;
    const sitelinks = uniq([...(a.topAd?.sitelinks ?? []), ...a.oldestTop5.flatMap((x) => x.sitelinks ?? [])]);
    const body = ad?.description ?? ad?.ocrText ?? null;
    L.push(``, `### ${i + 1}. ${a.domain}${legal ? ` (${legal})` : ""} — ${a.totalAds} ad(s)`);
    L.push(`| Attribute | Details |`, `| --- | --- |`);
    if (ad?.position) L.push(`| Ad position | #${ad.position} |`);
    if (ad?.headline) L.push(`| Headline | ${clip(ad.headline, 120)} |`);
    if (body) L.push(`| Description${ad?.description ? "" : " (from OCR)"} | ${clip(body, 180)} |`);
    const landing = ad?.detailsLink ?? a.sampleUrl;
    if (landing) L.push(`| Landing page | ${landing} |`);
    if (ad?.campaign) L.push(`| Campaign label | ${clip(ad.campaign, 60)} |`);
    const usps = extractUSPs(ad?.description ?? ad?.ocrText);
    if (usps.length) L.push(`| Key USPs | ${usps.join(" · ")} |`);
    if (sitelinks.length) L.push(`| Sitelinks | ${sitelinks.slice(0, 6).join(", ")} |`);
    const ctas = extractCTAs(ad, sitelinks);
    if (ctas.length) L.push(`| CTAs detected | ${ctas.join(" · ")} |`);
    if (a.viaKeywords.length) L.push(`| Seen on keyword(s) | ${a.viaKeywords.join(", ")} |`);
  });
  L.push(``);

  // ---- Ad copy & headlines analysis (Search) ----
  L.push(`### Ad Copy & Headline Analysis`);
  if (headlines.length) {
    L.push(``, `**Most-used words in headlines** (${headlines.length} headlines):`);
    L.push(`| Word | Frequency | % of headlines |`, `| --- | --- | --- |`);
    for (const r of wordFreqRows(headlines, 10)) L.push(`| ${r.word} | ${r.count}/${headlines.length} | ${r.pct}% |`);
  }
  if (descriptions.length) {
    L.push(``, `**Most-used words in descriptions** (${descriptions.length} descriptions):`);
    L.push(`| Word | Frequency | % of descriptions |`, `| --- | --- | --- |`);
    for (const r of wordFreqRows(descriptions, 10)) L.push(`| ${r.word} | ${r.count}/${descriptions.length} | ${r.pct}% |`);
  }
  if (!headlines.length && !descriptions.length) {
    L.push(`Ad copy text isn't available for these creatives. Enable **OCR** to read the text off the Display images below.`);
  }
  L.push(``);

  // ===================== 🖼️ DISPLAY ADS =====================
  const disp = buildDisplaySection(advertisers, query.language);
  if (disp) L.push(disp, ``);

  // ---- Keyword ranking recommendations (clean, split High-Priority / Niche) ----
  // Corpus now also includes any OCR text so image-only competitors still feed it.
  const corpus = [...headlines, ...descriptions, ...ocrTexts];
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
    const text = [a.topAd, ...a.oldestTop5].map((x) => `${x?.headline ?? ""} ${x?.description ?? ""} ${x?.ocrText ?? ""}`).join(" ").toLowerCase();
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
    // Markdown TABLE (not ASCII art — the renderer collapses whitespace/fences).
    L.push(`## Competitive Positioning Map`);
    L.push(`Two axes: **ad volume** (columns) × **creative breadth / extensions** (rows).`, ``);
    L.push(`| Creative breadth ↓ / Ad volume → | Low volume | High volume |`, `| --- | --- | --- |`);
    L.push(`| **Broad creative, many extensions** | ${cell(q.tl)} | ${cell(q.tr)} |`);
    L.push(`| **Focused** | ${cell(q.bl)} | ${cell(q.br)} |`);
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

// System prompt that makes the LLM write the gold-standard competitor teardown
// (the format Pedro pinned by example). The AI is the PRIMARY writer; it works
// off the REAL scraped data only. The display-ad photo gallery is appended
// deterministically afterwards (guaranteed), so the prompt omits it.
function reportSystemPrompt(languageCode: string): string {
  return [
    `You are a world-class Google Ads competitive strategist. You receive REAL, freshly-scraped competitor ad data (Oxylabs Google Ads SERPs + Google Ads Transparency Center + OCR). Write a sharp, decision-ready COMPETITIVE INTELLIGENCE REPORT.`,
    ``,
    `LANGUAGE: write the entire report in the language with code "${languageCode}".`,
    ``,
    `ABSOLUTE RULES:`,
    `- Use ONLY the data provided. NEVER invent advertisers, headlines, descriptions, URLs, sitelinks or campaigns. If a field is missing, omit it — do not guess.`,
    `- Quote headlines, descriptions, sitelinks and campaign labels VERBATIM.`,
    `- Do NOT compute or state exact word-frequency counts or percentages — you cannot count reliably, and exact frequency tables are added automatically after your text. Describe messaging patterns qualitatively instead.`,
    `- Be interpretive and specific — read like an expert analyst, not a data dump. End each section with the "so what / do this".`,
    `- No preamble and no "let me know if…" closing. Just the report.`,
    ``,
    `FORMATTING (a minimal Markdown renderer — stay strictly within this):`,
    `- Use only: "# / ## / ###" headings, "|" tables, "-" bullet lists, "1." numbered lists, "> " quotes, **bold**, and [text](url) links.`,
    `- NEVER use fenced code blocks (\`\`\`), ASCII art, HTML, nested tables, or nested lists — they render broken.`,
    `- TABLE CELLS: never put a raw "|" or a line break inside a cell. If ad copy contains "|", replace it with "/". Keep each cell on one line.`,
    `- Do NOT output any image markdown — the creative photo gallery is appended automatically; never invent image URLs.`,
    `- Begin the report with a single "# " H1 title (e.g. "# Competitive Intelligence Report").`,
    ``,
    `Produce EXACTLY these sections, in order:`,
    ``,
    `## Competitive Landscape Overview`,
    `One tight paragraph + bullets: country, the search query/input, total ads found, number of unique competitors, and the single biggest takeaway.`,
    ``,
    `## Top Competitors & Their Ad Strategies`,
    `For EACH competitor (ranked by ad position, then ad volume), a "### N. BRAND (domain) — position #X" block with a 2-column | Attribute | Details | table containing: Ad position, Headline (verbatim), Description (verbatim), Landing page, Campaign label, Key USPs (the concrete number-claims). Then a short bulleted "Sitelinks strategy" and "Calls to action detected", and ONE sentence interpreting their angle. Use the ad-longevity (oldestAdDaysActive) to flag proven, long-running winners.`,
    ``,
    `## Ad Copy & Messaging Patterns`,
    `2–3 sentences on the dominant words/angles every competitor leans on and what's conspicuously absent. Qualitative only — NO frequency tables (those are appended with exact counts).`,
    ``,
    `## Keyword Ranking Recommendations`,
    `🔥 High-priority keywords (anchored to the category with commercial intent) and 🔍 Niche keywords (the distinctive angles competitors use). Real, buyable phrases only — no junk word-pairs.`,
    ``,
    `## Brand vs. Competitor Strategy`,
    `Are advertisers naming/comparing rivals, or running "vs / alternative" angles? Name who and how — or state plainly that nobody is (an open lane to capture switchers).`,
    ``,
    `## Landing Page Strategy`,
    `A | Competitor | Landing page | Offer type | table, reading the destination URL + campaign label to infer the offer (free trial, demo, pricing, etc.).`,
    ``,
    `## Strategic Recommendations`,
    `Concrete plays for the user's own campaign: the winning headline pattern, description angles to test, sitelinks to add, and — most important — the GAPS no competitor covers (the opportunity to own).`,
    ``,
    `## Competitive Positioning Map`,
    `A Markdown TABLE (not ASCII art) placing each competitor by the two axes that best separate them in THIS data (e.g. ad-volume vs creative breadth). Use a 3-column grid: header "| <row axis> ↓ / <col axis> → | Low | High |", then two rows for the low/high of the row axis, putting each competitor's name in the matching cell. Note in one line where the open "[YOUR OPPORTUNITY]" quadrant is.`,
    ``,
    `## Legal Entities Running Ads`,
    `The real legal entities from the data, ranked by ad presence, each with a one-line note (biggest spender, new entrant, etc.).`,
  ].join("\n");
}

async function analyze(
  query: LabQuery,
  mode: BenchmarkMode,
  advertisers: LabAdvertiser[],
  cost: BenchmarkCostContext
): Promise<{ model: string; markdown: string } | null> {
  // Empty result → still return an honest report (buildFullReport renders the
  // "no advertisers found — try a broader keyword" guidance), never null, so the
  // UI always shows SOMETHING and explains why.
  if (!advertisers.length) {
    return { model: "No competitors found", markdown: buildFullReport(query, advertisers) };
  }

  // Deterministic, EXACT data sections appended after the AI prose: the word-freq
  // tables (the LLM is told not to fabricate counts) and the creative photo
  // gallery (the LLM can't render images). Both localized to the brand language.
  const wordFreqSection = buildWordFreqSection(advertisers, query.language);
  const displaySection = buildDisplaySection(advertisers, query.language);
  const t = labels(query.language);

  // Rich, fully-grounded data payload for the AI writer (the real scraped fields).
  const competitors = advertisers.slice(0, 10).map((a, i) => {
    const ad = a.topAd ?? a.oldestTop5.find((x) => x.headline) ?? a.oldestTop5[0];
    const sitelinks = uniq([...(a.topAd?.sitelinks ?? []), ...a.oldestTop5.flatMap((x) => x.sitelinks ?? [])]).slice(0, 8);
    const body = ad?.description ?? ad?.ocrText ?? null;
    const oldestDays = Math.max(0, ...a.oldestTop5.map((x) => x.daysActive ?? 0));
    return {
      rank: i + 1,
      domain: a.domain,
      legalName: a.oldestTop5.find((x) => x.legalName)?.legalName ?? a.topAd?.legalName ?? null,
      totalAds: a.totalAds,
      adPosition: ad?.position ?? null,
      headline: ad?.headline ?? null,
      description: body,
      landingPage: ad?.detailsLink ?? a.sampleUrl ?? null,
      campaignLabel: ad?.campaign ?? null,
      sitelinks,
      keyUSPs: extractUSPs(body),
      ctasDetected: extractCTAs(ad, sitelinks),
      oldestAdDaysActive: oldestDays || null,
      seenOnKeywords: a.viaKeywords,
      ocrTextOnImages: uniq(a.oldestTop5.map((x) => x.ocrText).filter((t): t is string => Boolean(t))).slice(0, 2),
    };
  });
  const data = {
    searchQueryOrInput: query.keywords,
    country: query.countryName,
    languageCode: query.language,
    mode,
    totalAdsFound: advertisers.reduce((n, a) => n + a.totalAds, 0),
    uniqueCompetitors: advertisers.length,
    competitors,
  };

  // AI is the PRIMARY writer. benchmarkReport never silently nulls — on failure it
  // returns a precise reason we surface to the user.
  const r = await benchmarkReport({
    cost,
    maxTokens: 4200,
    timeoutMs: 95_000,
    system: reportSystemPrompt(query.language),
    prompt: `COMPETITOR AD DATA (JSON — use ONLY this, quote it verbatim):\n${JSON.stringify(data)}`,
  });

  if (r.markdown) {
    const tokensLine =
      r.tokensIn || r.tokensOut
        ? `${r.tokensIn.toLocaleString("en-US")} in + ${r.tokensOut.toLocaleString("en-US")} tokens`
        : t.tokensNa;
    const footer = `\n\n---\n_🤖 ${t.writtenBy} **${r.model}** · ${tokensLine} · ${t.grounded}._`;
    const appendix = [wordFreqSection, displaySection].filter(Boolean).join("\n\n");
    const markdown = r.markdown + (appendix ? `\n\n${appendix}` : "") + footer;
    return { model: r.model ?? "AI", markdown };
  }

  // AI unavailable → full deterministic report, but TELL the user exactly why on a
  // SINGLE blockquote line (no more silent "Deterministic", no empty quote boxes).
  const banner = `> ⚠️ **The AI strategist didn't run:** ${r.error ?? "unknown reason"} — showing the complete data report below; fix it in /admin to get the AI write-up.\n\n`;
  return { model: `Deterministic — AI unavailable`, markdown: banner + buildFullReport(query, advertisers) };
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
  regionOverride: string | null = null
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
  } else {
    // extended_company: use keywords as domain list directly.
    discoveredDomains = query.keywords.map(cleanDomain).filter(Boolean);
  }

  // GUARANTEE: domains the caller explicitly requested are ALWAYS analyzed, even
  // when Oxylabs returned nothing for the brand-name search (a flaky scrape must
  // never produce an empty report). Prioritized first so they survive the cap.
  const guaranteed = (query.guaranteedDomains ?? []).map(cleanDomain).filter(Boolean);
  discoveredDomains = uniq([...guaranteed, ...discoveredDomains]).slice(0, query.numCompetitors);

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

  // OCR is now centralized in runBenchmarkLabInApp (user toggle, any mode).
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
      result = await runExtendedMode(query, costCtx, false, regionOverride);
      break;
    case "extended_company":
      result = await runExtendedMode(query, costCtx, true, regionOverride);
      break;
    case "keyword":
    default:
      result = await runKeywordMode(query, costCtx);
      break;
  }

  const { advertisers, allImageUrls } = result;

  // Firecrawl OCR — user-toggled, works in ANY mode that returned creative images
  // (company / extended / extended_company). Reads the exact text off each image
  // and attaches it to its ad so the report can show it next to the photo + mine
  // it for copy analysis. Centralized here so a single toggle drives every mode.
  let ocrCount = 0;
  const runOcr = (query.ocr ?? false) && !skipOcr && allImageUrls.length > 0;
  if (runOcr) {
    // Cap the number of images we OCR so an opt-in run can't fan out to 100+ paid
    // calls; 48 comfortably covers the creatives the report surfaces.
    const toOcr = uniq(allImageUrls).slice(0, 48);
    const ocrMap = await ocrImagesBatch(toOcr);
    const attach = (ad: LabAd | null | undefined) => {
      if (ad?.imageUrl && ocrMap.has(ad.imageUrl)) {
        const txt = (ocrMap.get(ad.imageUrl) ?? "").trim();
        if (txt) { ad.ocrText = txt; ocrCount++; }
      }
    };
    for (const adv of advertisers) {
      attach(adv.topAd);
      adv.oldestTop5.forEach(attach);
    }
  }

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
  if (runOcr && ocrCount > 0) {
    sources.push({
      label: "Ad image text (OCR)",
      provider: "Firecrawl · ocr_image_simple_text",
      detail: `Text read from ${ocrCount} of ${allImageUrls.length} ad image(s) in parallel`,
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
