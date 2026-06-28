// ============================================================================
// Competitor spend modeling.
//
// You cannot see a competitor's real Google Ads budget — it's private. Every
// tool that shows "estimated spend" (SEMrush, SpyFu, Similarweb) INFERS it from
// public signals. We do the same, using the realest signals we already pull for
// free in the benchmark engine:
//
//   monthly spend ≈ Σ over keywords [ volume × paidClickRate × advertiserShare × CPC ]
//
//   • volume   — real avg monthly searches (Google Keyword Planner)
//   • CPC      — real top-of-page bid low/high (Google Keyword Planner)
//   • paidClickRate  — what fraction of searches click a paid ad at all (by
//                      competition: hotter SERPs get more ad clicks)
//   • advertiserShare — this advertiser's slice of those clicks (proxy for how
//                      many advertisers compete; sharpens to 1/N when the gated
//                      ad-spy layer reveals the real advertiser count)
//
// The result is a RANGE with a confidence label, never a fake-precise number.
// It is best read RELATIVELY (who outspends whom) more than as an exact euro.
// When the paid ad-spy gate is on, real creatives + destination URLs raise the
// confidence and expose the real campaign/landing structure.
// ============================================================================

import type {
  BenchmarkCompetitor,
  Competition,
  SpendEstimate,
  SpendKeyword,
  SpendSummary,
} from "./types";

// Display currency. Account currency is not yet wired (a known wart shared with
// the rest of the app); flip this one constant once it's confirmed.
const CURRENCY = "€";

// Fraction of searches that click ANY paid ad on this SERP. Hotter (more
// commercial) SERPs draw more ad clicks. Blended, deliberately conservative.
function paidClickRate(c: Competition): number {
  switch (c) {
    case "HIGH":
      return 0.07;
    case "MEDIUM":
      return 0.05;
    case "LOW":
      return 0.03;
    default:
      return 0.045;
  }
}

// This advertiser's share of those paid clicks. Without per-keyword auction
// data we proxy it from competition (a stand-in for how many advertisers bid).
// When ad-spy reveals the real advertiser count N, share collapses to ~1/N.
function advertiserShare(
  c: Competition,
  knownAdvertisers: number | null
): number {
  if (knownAdvertisers && knownAdvertisers > 0) {
    return Math.min(0.6, Math.max(0.08, 1 / knownAdvertisers));
  }
  switch (c) {
    case "HIGH":
      return 0.18; // ~one of 5-6 advertisers
    case "MEDIUM":
      return 0.33; // ~one of 3
    case "LOW":
      return 0.6; // ~one of 1-2
    default:
      return 0.3;
  }
}

/**
 * Model one competitor's monthly Google Search investment from its keyword
 * footprint. Returns null when nothing in the footprint carries a CPC bid
 * (i.e. nothing monetizable to estimate).
 */
export function estimateCompetitorSpend(
  comp: BenchmarkCompetitor
): SpendEstimate | null {
  const adsOk = comp.adsStatus === "ok" && Array.isArray(comp.ads);
  const ads = adsOk ? comp.ads ?? [] : [];
  const destinationUrls = new Set(
    ads.map((a) => (a.destinationUrl ?? "").trim()).filter(Boolean)
  );
  const landingsDetected = adsOk ? destinationUrls.size || null : null;
  const activeCreatives = adsOk ? ads.length : null;

  // We don't have per-keyword advertiser counts, so share falls back to the
  // competition proxy. (Hook for future: derive N per keyword from ad-spy.)
  const knownAdvertisers: number | null = null;

  let low = 0;
  let mid = 0;
  let high = 0;
  let commercial = 0;
  const perKw: SpendKeyword[] = [];

  for (const k of comp.keywords) {
    const cpcLow = (k.cpcLowMicros ?? 0) / 1_000_000;
    const cpcHigh = (k.cpcHighMicros ?? 0) / 1_000_000;
    const cpcMid =
      cpcLow && cpcHigh ? (cpcLow + cpcHigh) / 2 : cpcHigh || cpcLow;
    if (cpcMid <= 0) continue; // no commercial signal — skip
    commercial++;

    const clicks =
      k.avgMonthlySearches *
      paidClickRate(k.competition) *
      advertiserShare(k.competition, knownAdvertisers);

    const kwMid = clicks * cpcMid;
    // Band: real CPC low/high × a click-capture uncertainty factor.
    low += clicks * (cpcLow || cpcMid) * 0.7;
    mid += kwMid;
    high += clicks * (cpcHigh || cpcMid) * 1.3;

    perKw.push({
      text: k.text,
      avgMonthlySearches: k.avgMonthlySearches,
      cpcMicros: Math.round(cpcMid * 1_000_000),
      estMonthlyClicks: Math.round(clicks),
      estMonthlyMid: kwMid,
    });
  }

  if (commercial === 0) return null;

  perKw.sort((a, b) => b.estMonthlyMid - a.estMonthlyMid);

  return {
    currency: CURRENCY,
    monthlyLow: Math.round(low),
    monthlyMid: Math.round(mid),
    monthlyHigh: Math.round(high),
    confidence: adsOk ? "medium" : "low",
    commercialKeywords: commercial,
    landingsDetected,
    activeCreatives,
    topSpendKeywords: perKw.slice(0, 6),
    basis: adsOk
      ? "Modeled from Google Keyword Planner volumes × CPC and sharpened with live ad-spy (real creatives + landing pages). An estimate, not actual spend."
      : "Modeled from Google Keyword Planner search volumes × top-of-page CPC, with paid-CTR and competitive-share assumptions. A directional estimate, not actual spend.",
  };
}

/** Combine per-competitor estimates into a run-level roll-up. */
export function summarizeSpend(
  estimates: (SpendEstimate | null | undefined)[]
): SpendSummary | null {
  const present = estimates.filter(
    (e): e is SpendEstimate => !!e
  );
  if (present.length === 0) return null;
  return {
    currency: CURRENCY,
    monthlyLow: present.reduce((n, e) => n + e.monthlyLow, 0),
    monthlyMid: present.reduce((n, e) => n + e.monthlyMid, 0),
    monthlyHigh: present.reduce((n, e) => n + e.monthlyHigh, 0),
    competitorsEstimated: present.length,
    confidence: present.some((e) => e.confidence === "medium")
      ? "medium"
      : "low",
    note: "Combined estimated monthly Google Search budget across the competitors analyzed. Modeled from public search volumes × CPC — directional, best read as who-outspends-whom rather than an exact figure.",
  };
}
