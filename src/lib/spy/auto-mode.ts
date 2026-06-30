// ============================================================================
// runAutoMode — the deterministic orchestrator behind the Premium Report.
//
// It fans out the standalone spy tools (each a typed function), assembles ONE
// CompetitiveBrief, runs a single LLM synthesis pass over it, and renders a
// premium consolidated markdown report. This is Layer 2–4 of the strategy memo:
// cheap deterministic orchestration + reliable tools, LLM reserved for judgment.
// The same brief later feeds the campaign agents (A1–A6).
//
// Cost-bounded: ≤5 competitors; Landing X-Ray only on the top 2 by spend.
// Never throws — partial failures degrade gracefully (one dead API ≠ no report).
// ============================================================================

import { domainSpendOverview, domainPaidKeywords } from "./dataforseo";
import { runBrandDefense, toBrandThreatSlices } from "./brand-defense";
import { analyzeLanding } from "./landing";
import { benchmarkReport } from "@/lib/benchmark/llm";
import { findCountry } from "@/lib/benchmark/countries";
import type { BenchmarkCostContext } from "@/lib/benchmark/types";
import {
  emptyBrief,
  type CompetitiveBrief,
  type KeywordSpendSlice,
} from "./brief";

const normKw = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const money = (n: number) => "$" + Math.round(Math.max(0, n)).toLocaleString("en-US");
const fmt = (n: number) => Math.round(Math.max(0, n)).toLocaleString("en-US");

export interface AutoModeInput {
  brandName: string;
  brandDomain: string | null;
  competitors: string[]; // domains
  countryCode: string;
  cost: BenchmarkCostContext;
}

export interface AutoModeResult {
  brief: CompetitiveBrief;
  reportMarkdown: string;
  cost: number;
}

export async function runAutoMode(input: AutoModeInput): Promise<AutoModeResult> {
  const country = findCountry(input.countryCode);
  const locationCode = parseInt(country.region, 10) || 2840;
  const lang = country.lang || "en";
  const competitors = [...new Set(input.competitors.map((d) => d.toLowerCase().trim()).filter(Boolean))].slice(0, 5);

  const brief = emptyBrief(
    { name: input.brandName, domain: input.brandDomain },
    { countryCode: country.code, countryName: country.name, language: lang },
    competitors
  );
  let totalCost = 0;
  const addSource = (tool: string, provider: string, costUsd = 0) => {
    totalCost += costUsd;
    brief.sources.push({ tool, provider, ranAt: new Date().toISOString(), costUsd });
  };

  // ---- Layer 2: deterministic fan-out of the tools (parallel, bounded) ----
  // 1) Spend + paid keywords for each competitor.
  const spendResults = await Promise.all(
    competitors.map(async (domain) => {
      const [ov, kw] = await Promise.all([
        domainSpendOverview(domain, locationCode, lang),
        domainPaidKeywords(domain, locationCode, lang, 50),
      ]);
      return { domain, ov, kw };
    })
  );
  for (const { domain, ov, kw } of spendResults) {
    addSource("keyword_spend", "DataForSEO Labs", (ov.cost || 0) + (kw.cost || 0));
    if (ov.data) {
      const slice: KeywordSpendSlice = {
        domain,
        estimatedMonthlySpend: ov.data.estimatedMonthlySpend,
        paidKeywords: ov.data.paidKeywords || kw.total,
        estimatedPaidTraffic: ov.data.estimatedPaidTraffic,
        topKeywords: kw.data.slice(0, 25).map((k) => ({ keyword: k.keyword, volume: k.volume, cpc: k.cpc, position: k.position, etv: k.etv })),
      };
      brief.keywordSpend.push(slice);
    }
  }

  // 2) Keyword gap vs the brand (if we know the brand domain).
  if (input.brandDomain) {
    const brandKw = await domainPaidKeywords(input.brandDomain, locationCode, lang, 200);
    addSource("keyword_spend", "DataForSEO Labs", brandKw.cost || 0);
    const brandSet = new Set(brandKw.data.map((k) => normKw(k.keyword)));
    const rivalKw = new Set(brief.keywordSpend.flatMap((s) => s.topKeywords.map((k) => normKw(k.keyword))));
    const steal = [...rivalKw].filter((k) => !brandSet.has(k));
    const shared = [...rivalKw].filter((k) => brandSet.has(k));
    const defendCount = [...brandSet].filter((k) => !rivalKw.has(k)).length;
    brief.keywordGap = { steal: steal.slice(0, 50), shared: shared.slice(0, 50), defendCount };
  }

  // 3) Brand Defense — who bids on the brand's own terms.
  const brandTerm = input.brandDomain ? input.brandDomain.replace(/\.[a-z.]+$/i, "") : input.brandName;
  if (brandTerm) {
    try {
      const bd = await runBrandDefense({
        brandDomain: input.brandDomain ?? input.brandName,
        keywords: [brandTerm].filter(Boolean),
        geo: country.geo,
        cost: input.cost,
      });
      brief.brandThreats = toBrandThreatSlices(bd.threats);
      addSource("brand_defense", "Oxylabs");
    } catch {
      /* non-fatal */
    }
  }

  // 4) Landing X-Ray on the top 2 competitors by spend (cost control).
  const topBySpend = [...brief.keywordSpend].sort((a, b) => b.estimatedMonthlySpend - a.estimatedMonthlySpend).slice(0, 2);
  const landings = await Promise.all(
    topBySpend.map((s) => analyzeLanding({ url: `https://${s.domain}` }).catch(() => null))
  );
  for (const lx of landings) {
    if (lx && lx.slice) {
      brief.landing.push(lx.slice);
      addSource("landing", "Firecrawl + AI", lx.cost || 0);
    }
  }

  // ---- Layer 4: ONE LLM synthesis pass over the assembled brief ----
  // Returns MARKDOWN (not JSON) — robust across models that wrap/garble JSON.
  const synthesisMd = await synthesize(brief, input.cost);
  if (synthesisMd) addSource("synthesis", "OpenRouter", 0);

  // ---- Render the premium consolidated report ----
  const reportMarkdown = renderReport(brief, synthesisMd);
  return { brief, reportMarkdown, cost: Number(totalCost.toFixed(4)) };
}

// ---------------------------------------------------------------------------
async function synthesize(brief: CompetitiveBrief, cost: BenchmarkCostContext): Promise<string | null> {
  const data = {
    brand: brief.brand,
    market: brief.market.countryName,
    competitors: brief.keywordSpend.map((s) => ({
      domain: s.domain,
      monthlySpend: Math.round(s.estimatedMonthlySpend),
      paidKeywords: s.paidKeywords,
      topKeywords: s.topKeywords.slice(0, 8).map((k) => k.keyword),
    })),
    keywordGap: brief.keywordGap ? { stealCount: brief.keywordGap.steal.length, topSteal: brief.keywordGap.steal.slice(0, 12) } : null,
    brandThreats: brief.brandThreats.map((t) => ({ keyword: t.brandKeyword, conquesters: t.conquesters.map((c) => c.domain) })),
    landings: brief.landing.map((l) => ({ domain: l.domain, offer: l.offer, pricing: l.pricing, primaryCta: l.primaryCta, valueProps: l.valueProps })),
  };
  // Plain-MARKDOWN output (no JSON) — reliable across every model. Becomes the
  // report's Executive Summary, layered on top of the deterministic data.
  const r = await benchmarkReport({
    cost,
    maxTokens: 1600,
    timeoutMs: 110_000,
    system:
      `You are a senior Google Ads strategist. From the competitor intelligence JSON, write a tight EXECUTIVE SUMMARY in GitHub-flavored Markdown (no H1). Cover, grounded in the data (cite domains/keywords): ` +
      `where this brand can win vs these rivals (positioning), 3-5 concrete opportunities, the real threats (who spends most, who attacks the brand), and the single sharpest **Recommended angle** for the campaign. ` +
      `Use ONLY the data provided; be specific and decision-ready; no preamble.`,
    prompt: `COMPETITIVE INTELLIGENCE (JSON):\n${JSON.stringify(data)}`,
  });
  return r.markdown && r.markdown.trim() ? r.markdown.trim() : null;
}

// ---------------------------------------------------------------------------
// Deterministic premium report — always complete, AI synthesis layered on top.
function renderReport(b: CompetitiveBrief, synthesisMd: string | null): string {
  const L: string[] = [];
  L.push(`# Competitive Intelligence — ${b.brand.name || b.brand.domain || "Your brand"}`);
  L.push(`_${b.market.countryName} · ${b.competitors.length} competitors · generated ${new Date(b.generatedAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}_`, ``);

  // Executive summary (AI synthesis, markdown) — layered on the deterministic data.
  if (synthesisMd) {
    L.push(`## Executive Summary`, ``, synthesisMd, ``);
  }

  // Spend leaderboard.
  if (b.keywordSpend.length) {
    L.push(`## 💰 Estimated Ad Spend`);
    L.push(`| Competitor | Est. monthly spend | Paid keywords | Est. monthly clicks |`, `| --- | --- | --- | --- |`);
    [...b.keywordSpend].sort((a, c) => c.estimatedMonthlySpend - a.estimatedMonthlySpend).forEach((s) => {
      L.push(`| ${s.domain} | ${s.estimatedMonthlySpend > 0 ? money(s.estimatedMonthlySpend) : "—"} | ${fmt(s.paidKeywords)} | ${fmt(s.estimatedPaidTraffic)} |`);
    });
    L.push(``);
  }

  // Keyword gap.
  if (b.keywordGap && (b.keywordGap.steal.length || b.keywordGap.shared.length)) {
    L.push(`## 🥊 Keyword Gap`);
    L.push(`🔥 **${b.keywordGap.steal.length} to steal** (rivals bid, you don't) · ⚔️ ${b.keywordGap.shared.length} shared · 🛡️ ${b.keywordGap.defendCount} you defend`, ``);
    if (b.keywordGap.steal.length) {
      L.push(`**Top keywords to steal:** ${b.keywordGap.steal.slice(0, 15).join(", ")}`, ``);
    }
  }

  // Landing teardowns.
  if (b.landing.length) {
    L.push(`## 🔬 Landing Pages`);
    for (const l of b.landing) {
      L.push(`### ${l.domain}`);
      L.push(`| Attribute | Details |`, `| --- | --- |`);
      if (l.offer) L.push(`| Offer | ${clip(l.offer)} |`);
      if (l.pricing?.length) L.push(`| Pricing | ${clip(l.pricing.join(" · "))} |`);
      if (l.primaryCta) L.push(`| Primary CTA | ${clip(l.primaryCta)} |`);
      if (l.valueProps.length) L.push(`| Value props | ${clip(l.valueProps.slice(0, 5).join(" · "))} |`);
      if (l.socialProof.length) L.push(`| Social proof | ${clip(l.socialProof.slice(0, 4).join(" · "))} |`);
      if (l.adMessageMatch) L.push(`| Ad↔landing match | ${l.adMessageMatch}${l.matchRationale ? ` — ${clip(l.matchRationale)}` : ""} |`);
      if (l.trackingStack.length) L.push(`| Tracking stack | ${l.trackingStack.slice(0, 8).join(", ")} |`);
      L.push(``);
    }
  }

  // Brand defense.
  if (b.brandThreats.length) {
    const conq = b.brandThreats.flatMap((t) => t.conquesters);
    L.push(`## 🛡️ Brand Defense`);
    if (conq.length) {
      L.push(`These advertisers bid on your brand terms:`, ``);
      L.push(`| Advertiser | Their ad |`, `| --- | --- |`);
      for (const c of conq.slice(0, 10)) L.push(`| ${c.domain} | ${clip(c.headline ?? c.description ?? "—")} |`);
    } else {
      L.push(`No one is bidding on your brand terms right now — clean.`);
    }
    L.push(``);
  }

  // Sources & method.
  const used = new Map<string, number>();
  for (const s of b.sources) used.set(`${s.provider}`, (used.get(s.provider) ?? 0) + 1);
  L.push(`## 📡 Sources & Method`);
  L.push(`| Source | Calls |`, `| --- | --- |`);
  for (const [provider, n] of used) L.push(`| ${provider} | ${n} |`);
  L.push(``);
  return L.join("\n");
}

function clip(s: string, max = 200): string {
  const t = (s ?? "").replace(/\s*[|\r\n]+\s*/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t || "—";
}
