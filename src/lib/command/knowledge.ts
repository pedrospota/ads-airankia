// Distilled paid-media thresholds (facts) powering source='regla' suggestions and
// future gate tuning. Sources (MIT): coreyhaines31/marketingskills, AgriciDaniel/
// claude-ads, nowork-studio/NotFair — see docs/knowledge/ads/ATTRIBUTION.md.
// All budgets in micros. Thresholds are starting points; recalibrate per account.

export const META_THRESHOLDS = {
  scaleStepPct: 20,               // +20% per scale move (never >=30% — resets learning)
  scaleCadenceDays: 5,            // wait 5 days between scale steps
  killCpaMultiple: 3,             // spend > 3x target CPA with 0 conv -> pause
  learningConversionsPerWeek: 50, // learning-phase exit ("50 in 7")
  learningResetBudgetDeltaPct: 20,// budget delta >20% resets learning
  freqProspectingWarn: 3.0,       // ad-set frequency/7d warn
  freqProspectingCritical: 4.0,
  freqRetargetingCritical: 6.0,
  ctrDecayPctFatigue: -20,        // CTR down >=20% over 7d = fatigue
  budgetSufficiencyCpaMultiple: 5,// daily budget >= 5x target CPA per ad set
} as const;

export const GOOGLE_THRESHOLDS = {
  smartBiddingMinConv30d: 30,     // >=30 conv/30d before Target CPA/ROAS
  broadMatchMinConv30d: 30,       // broad match only with smart bidding + 30 conv + negatives
  tcpaStepPct: 15,                // move tCPA in +/-10-15% steps
  budgetSpendMultiplierPerDay: 2, // campaigns can spend up to 2x daily budget in a day
  wastedSpendClickFloor: 3,       // search terms with >=3 clicks and 0 conv -> negative candidate
  qualityScoreFloor: 7,           // avg QS >= 7 healthy
} as const;

/** A single budget step must not raise spend by >= META scaleStepPct. Decreases always ok. */
export function budgetStepOk(prevMicros: number, nextMicros: number): boolean {
  if (prevMicros <= 0) return false;
  if (nextMicros <= prevMicros) return true;
  const pct = (nextMicros - prevMicros) / prevMicros * 100;
  return pct < META_THRESHOLDS.scaleStepPct + 0.0001 ? pct <= META_THRESHOLDS.scaleStepPct : false;
}

export interface FatigueSignal { campaignType: "prospecting" | "retargeting"; frequency7d: number; ctrDeltaPct: number }

/** Prospecting fatigue = frequency over critical AND CTR decayed past the fatigue floor. */
export function isFatigued(s: FatigueSignal): boolean {
  const freqCritical = s.campaignType === "prospecting"
    ? META_THRESHOLDS.freqProspectingCritical
    : META_THRESHOLDS.freqRetargetingCritical;
  return s.frequency7d >= freqCritical && s.ctrDeltaPct <= META_THRESHOLDS.ctrDecayPctFatigue;
}

/** Google Responsive Search Ad limits (API-enforced; validateOnly is the authoritative backstop). */
export const RSA_SPEC = {
  headline: { min: 3, max: 15, maxLen: 30 },
  description: { min: 2, max: 4, maxLen: 90 },
  path: { maxLen: 15 },
} as const;

/** Meta link-ad recommended display limits (single-image link ad, feed placement). */
export const META_LINK_AD_SPEC = {
  message: { maxLen: 125 },
  headline: { maxLen: 40 },
  description: { maxLen: 30 },
} as const;
