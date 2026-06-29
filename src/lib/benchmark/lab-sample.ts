// ============================================================================
// Demo sample for the Competitor Benchmark Lab.
//
// Returned by the proxy when the Windmill backend isn't wired yet (no
// WINDMILL_* env), and used to seed the page so it looks great on first paint.
// Clearly flagged `demo: true` everywhere so it's never mistaken for real data.
//
// Pure + deterministic (no network, no secrets). Adapts its labels to the
// chosen query (keywords / country / language).
// ============================================================================

import type { LabAd, LabAdvertiser, LabQuery, LabReport } from "./lab-types";
import { computeAnalytics } from "./lab-analytics";

type Seed = {
  domain: string;
  advertiser: string;
  legalName: string;
  headline: string;
  url: string;
  ads: { format: string; days: number; cta: string }[];
};

const SEEDS: Seed[] = [
  {
    domain: "semrush.com",
    advertiser: "Semrush",
    legalName: "Semrush Inc.",
    headline: "All-in-One SEO Toolkit — Try Semrush Free",
    url: "https://www.semrush.com/lp/seo/",
    ads: [
      { format: "text", days: 612, cta: "Start free trial" },
      { format: "image", days: 430, cta: "Get started" },
      { format: "text", days: 188, cta: "Try it free" },
    ],
  },
  {
    domain: "ahrefs.com",
    advertiser: "Ahrefs",
    legalName: "Ahrefs Pte. Ltd.",
    headline: "Ahrefs — SEO Tools & Resources To Grow Traffic",
    url: "https://ahrefs.com/seo",
    ads: [
      { format: "text", days: 548, cta: "Sign up" },
      { format: "video", days: 274, cta: "Watch demo" },
    ],
  },
  {
    domain: "surferseo.com",
    advertiser: "Surfer",
    legalName: "Surfer sp. z o.o.",
    headline: "Write Content That Ranks — Surfer SEO",
    url: "https://surferseo.com/",
    ads: [
      { format: "image", days: 365, cta: "Try Surfer" },
      { format: "text", days: 121, cta: "Start writing" },
    ],
  },
  {
    domain: "jasper.ai",
    advertiser: "Jasper",
    legalName: "Jasper AI, Inc.",
    headline: "AI Content That Ranks — Jasper for SEO Teams",
    url: "https://www.jasper.ai/",
    ads: [
      { format: "image", days: 309, cta: "Try Jasper" },
      { format: "text", days: 96, cta: "Get a demo" },
    ],
  },
  {
    domain: "writesonic.com",
    advertiser: "Writesonic",
    legalName: "Writesonic Inc.",
    headline: "AI SEO Writer — Rank on Google with Writesonic",
    url: "https://writesonic.com/",
    ads: [
      { format: "text", days: 256, cta: "Try free" },
      { format: "image", days: 73, cta: "Start now" },
    ],
  },
  {
    domain: "clearscope.io",
    advertiser: "Clearscope",
    legalName: "Mushi Labs, Inc.",
    headline: "Clearscope — Content Optimization for SEO",
    url: "https://www.clearscope.io/",
    ads: [{ format: "text", days: 142, cta: "Book a demo" }],
  },
];

function isoDaysAgo(days: number): string {
  // Deterministic-ish: anchor to a fixed reference so the demo never shifts.
  const ref = new Date("2026-06-01T00:00:00Z").getTime();
  return new Date(ref - days * 86_400_000).toISOString().slice(0, 10);
}

export function buildSampleReport(query: LabQuery): LabReport {
  const kws = query.keywords.length ? query.keywords : ["ai seo tools"];
  const primaryKw = kws[0];
  const competitors = SEEDS.slice(0, Math.max(3, Math.min(SEEDS.length, query.numCompetitors)));

  const advertisers: LabAdvertiser[] = competitors.map((s, i) => {
    // Spread coverage across the entered keywords so the matrix looks alive.
    const viaKeywords = [...new Set([primaryKw, kws[i % kws.length]])];
    const oldestTop5: LabAd[] = [...s.ads]
      .sort((a, b) => b.days - a.days)
      .slice(0, 5)
      .map((ad) => ({
        advertiser: s.advertiser,
        advertiserDomain: s.domain,
        legalName: s.legalName,
        format: ad.format,
        firstShown: isoDaysAgo(ad.days),
        lastShown: isoDaysAgo(2),
        daysActive: ad.days,
        imageUrl: null, // demo → UI renders a styled placeholder
        detailsLink: `https://adstransparency.google.com/?domain=${s.domain}`,
        targetDomain: s.domain,
        viaKeyword: viaKeywords[0],
        headline: s.headline,
        cta: ad.cta,
      }));
    return {
      domain: s.domain,
      source: "oxylabs" as const,
      totalAds: s.ads.length,
      oldestTop5,
      sampleHeadline: s.headline,
      sampleUrl: s.url,
      viaKeywords,
    };
  });

  const allAds = advertisers.flatMap((a) => a.oldestTop5);
  const topOldestAds = [...allAds].sort((a, b) => (b.daysActive ?? 0) - (a.daysActive ?? 0)).slice(0, 6);
  const totalAds = advertisers.reduce((n, a) => n + a.totalAds, 0);
  const daysList = allAds.map((a) => a.daysActive ?? 0).filter((n) => n > 0);
  const avgDaysActive = daysList.length ? Math.round(daysList.reduce((s, n) => s + n, 0) / daysList.length) : 0;
  const oldestDays = daysList.length ? Math.max(...daysList) : 0;

  return {
    generatedAt: new Date().toISOString(),
    demo: true,
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
    analysis: {
      model: "demo",
      language: query.language,
      markdown: sampleMarkdown(primaryKw, query.countryName, advertisers),
    },
    sources: [
      {
        label: "Advertiser discovery",
        provider: "Oxylabs · google_ads",
        detail: `Real Google Search ads running on “${primaryKw}” in ${query.countryName}`,
        live: false,
      },
      {
        label: "Ad creatives & age",
        provider: "SerpApi · Transparency Center",
        detail: "Active creatives per competitor domain, with first/last shown dates",
        live: false,
      },
      {
        label: "Strategic teardown",
        provider: "OpenRouter · Claude",
        detail: "Synthesis of headlines, CTAs, keyword gaps and recommendations",
        live: false,
      },
    ],
  };
}

function sampleMarkdown(keyword: string, country: string, advertisers: LabAdvertiser[]): string {
  const names = advertisers.map((a) => a.domain).join(", ");
  return `## Competitive landscape — “${keyword}” (${country})

**${advertisers.length} advertisers** are actively bidding on this term: ${names}. The longest-running creative has been live for **${Math.max(
    ...advertisers.flatMap((a) => a.oldestTop5.map((x) => x.daysActive ?? 0)),
  )} days**, a strong signal that the keyword is *profitable* — nobody keeps an unprofitable ad running that long.

### What the winners do
- **Free-trial-first CTAs.** "Start free trial" / "Try free" dominate the headlines — low-friction offers win this category.
- **Toolkit positioning.** Leaders sell an *all-in-one* suite, not a single feature.
- **Long-lived text ads.** The oldest survivors are plain text ads, not image — proof that message-market fit beats creative polish here.

### Keyword recommendations (mined from competitor copy)
1. all in one seo toolkit
2. seo tools free trial
3. ai content that ranks
4. rank on google
5. content optimization tool
6. seo writer ai
7. grow organic traffic
8. keyword research tool
9. on-page seo software
10. seo audit tool

### Threats & gaps
- Every competitor leads with a **free trial** — entering without one puts you at an immediate CTR disadvantage.
- Nobody is running **comparison ("vs") ads** yet — an open lane to capture high-intent switchers.

> _Demo data. Connect the Windmill backend to replace this with a live teardown of the real advertisers._`;
}
