// ============================================================================
// Deterministic analytics for the Competitor Benchmark Lab.
//
// This is the DATA-FIRST half of the master-prompt deliverables: instead of
// asking the LLM for them, we COMPUTE formats, CTAs, headline-term frequency
// (with %), share of voice, keyword coverage, ad-age distribution, mined
// keyword recommendations and brand-competitor ("vs") detection straight from
// the raw ad data. The LLM is left to do only the narrative synthesis.
//
// Pure + deterministic, no server imports — runs the same for demo and live.
// ============================================================================

import type {
  LabAdvertiser,
  LabAnalytics,
  LabCompetitorStat,
  LabQuery,
  LabStat,
} from "./lab-types";

// Common EN + ES stopwords so mined terms surface real intent, not filler.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with", "your",
  "you", "our", "my", "is", "are", "be", "get", "got", "now", "best", "top",
  "new", "free", "all", "one", "it", "that", "this", "from", "by", "at", "as",
  "more", "most", "up", "out", "no", "yes", "vs", "&",
  "el", "la", "los", "las", "un", "una", "y", "o", "para", "de", "del", "en",
  "con", "tu", "tus", "su", "sus", "mi", "es", "son", "ya", "lo", "que", "por",
  "más", "mas", "mejor", "gratis", "nuevo", "todo", "todos",
]);

const VS_SIGNALS = [
  "vs", "vs.", "versus", "alternative", "alternatives", "alternativa",
  "compare", "comparison", "comparativa", "switch from", "better than",
];

function tokenize(s: string | null | undefined): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function countBy(values: (string | null | undefined)[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    const k = String(v).trim();
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function statList(counts: Map<string, number>, total: number, limit: number): LabStat[] {
  return [...counts.entries()]
    .map(([label, count]) => ({
      label,
      count,
      pct: total ? Math.round((count / total) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];
const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0);

// Brand tokens derived from the competitor set (e.g. semrush.com -> "semrush"),
// used to detect when an advertiser names a RIVAL in its copy.
function brandTokens(domain: string): string[] {
  const base = domain.replace(/^www\./, "").split(".")[0] ?? "";
  return base.split(/[-_]/).filter((t) => t.length > 2);
}

export function computeAnalytics(advertisers: LabAdvertiser[], query: LabQuery): LabAnalytics {
  const allAds = advertisers.flatMap((a) => a.oldestTop5);
  const totalAdsAll = advertisers.reduce((n, a) => n + a.totalAds, 0);

  // ---- overall format mix --------------------------------------------------
  const formatCounts = countBy(allAds.map((a) => a.format));
  const formatTotal = [...formatCounts.values()].reduce((s, n) => s + n, 0);
  const formats = statList(formatCounts, formatTotal, 5);

  // ---- CTA leaderboard (empty when not extracted) --------------------------
  const ctaCounts = countBy(allAds.map((a) => a.cta));
  const ctaTotal = [...ctaCounts.values()].reduce((s, n) => s + n, 0);
  const ctas = statList(ctaCounts, ctaTotal, 8);

  // ---- headline / description term frequency (doc-frequency, with %) --------
  const headlineStrings = uniq(
    [
      ...advertisers.map((a) => a.sampleHeadline ?? ""),
      ...allAds.map((a) => a.headline ?? ""),
    ].filter(Boolean),
  );
  const queryTokens = new Set(query.keywords.flatMap((k) => tokenize(k)));
  const termDocFreq = new Map<string, number>();
  for (const h of headlineStrings) {
    const terms = uniq(
      tokenize(h).filter(
        (t) => t.length > 2 && !STOPWORDS.has(t) && !queryTokens.has(t) && !/^\d+$/.test(t),
      ),
    );
    for (const t of terms) termDocFreq.set(t, (termDocFreq.get(t) ?? 0) + 1);
  }
  const headlineTerms = statList(termDocFreq, headlineStrings.length, 12);

  // ---- mined keyword recommendations (>= 10) -------------------------------
  const bigramCounts = new Map<string, number>();
  for (const h of headlineStrings) {
    const toks = tokenize(h).filter((t) => t.length > 2 && !STOPWORDS.has(t));
    for (let i = 0; i < toks.length - 1; i++) {
      const bg = `${toks[i]} ${toks[i + 1]}`;
      bigramCounts.set(bg, (bigramCounts.get(bg) ?? 0) + 1);
    }
  }
  const qset = new Set(query.keywords.map((k) => k.toLowerCase().trim()));
  let recommendedKeywords = uniq([
    ...[...bigramCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
    ...headlineTerms.map((t) => t.label),
  ]).filter((k) => !qset.has(k));
  // Top up to >= 10 with the primary keyword + high-intent modifiers.
  const primary = query.keywords[0] ?? "";
  const MODS = ["software", "tool", "pricing", "alternative", "for teams", "reviews", "online", "platform", "comparison", "for business"];
  for (const m of MODS) {
    if (recommendedKeywords.length >= 12) break;
    const cand = primary ? `${primary} ${m}` : m;
    if (!qset.has(cand) && !recommendedKeywords.includes(cand)) recommendedKeywords.push(cand);
  }
  recommendedKeywords = recommendedKeywords.slice(0, 12);

  // ---- per-competitor share of voice + breakdown ---------------------------
  const allBrandTokens = new Set(advertisers.flatMap((a) => brandTokens(a.domain)));
  const competitors: LabCompetitorStat[] = advertisers
    .map((a) => {
      const ads = a.oldestTop5;
      const days = ads.map((x) => x.daysActive ?? 0).filter((n) => n > 0);
      const own = new Set(brandTokens(a.domain));
      const text = [a.sampleHeadline ?? "", ...ads.map((x) => x.headline ?? "")]
        .join(" ")
        .toLowerCase();
      const namesRival = [...allBrandTokens].some((t) => !own.has(t) && text.includes(t));
      const hasVsSignal = VS_SIGNALS.some((s) => text.includes(s));
      return {
        domain: a.domain,
        advertiser: ads.find((x) => x.advertiser)?.advertiser ?? null,
        legalName: ads.find((x) => x.legalName)?.legalName ?? null,
        totalAds: a.totalAds,
        sharePct: totalAdsAll ? Math.round((a.totalAds / totalAdsAll) * 100) : 0,
        oldestDays: days.length ? Math.max(...days) : 0,
        avgDays: days.length ? Math.round(avg(days)) : 0,
        formats: statList(countBy(ads.map((x) => x.format)), ads.length, 5),
        topCtas: uniq(ads.map((x) => x.cta).filter(Boolean) as string[]).slice(0, 3),
        landingUrl: a.sampleUrl ?? null,
        viaKeywords: a.viaKeywords,
        runsVsAds: namesRival || hasVsSignal,
      };
    })
    .sort((a, b) => b.totalAds - a.totalAds || b.oldestDays - a.oldestDays);

  const vsAdvertisers = competitors.filter((c) => c.runsVsAds).map((c) => c.domain);

  // ---- keyword coverage (who shows up per keyword) -------------------------
  const keywordCoverage = query.keywords.map((kw) => ({
    keyword: kw,
    domains: advertisers.filter((a) => a.viaKeywords.includes(kw)).map((a) => a.domain),
  }));

  // ---- ad-age distribution -------------------------------------------------
  const BUCKETS: { label: string; test: (d: number) => boolean }[] = [
    { label: "0–30d", test: (d) => d <= 30 },
    { label: "31–90d", test: (d) => d > 30 && d <= 90 },
    { label: "91–180d", test: (d) => d > 90 && d <= 180 },
    { label: "181–365d", test: (d) => d > 180 && d <= 365 },
    { label: "365d+", test: (d) => d > 365 },
  ];
  const ageDays = allAds.map((a) => a.daysActive ?? 0).filter((n) => n > 0);
  const ageBuckets: LabStat[] = BUCKETS.map((b) => {
    const count = ageDays.filter(b.test).length;
    return { label: b.label, count, pct: ageDays.length ? Math.round((count / ageDays.length) * 100) : 0 };
  });

  return {
    formats,
    ctas,
    headlineTerms,
    recommendedKeywords,
    competitors,
    keywordCoverage,
    ageBuckets,
    vsAdvertisers,
    creativesAnalyzed: allAds.length,
  };
}
