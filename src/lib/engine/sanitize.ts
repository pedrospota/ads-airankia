// ============================================================================
// PRE-FLIGHT SANITIZER  (pure, no LLM, no I/O)
// ----------------------------------------------------------------------------
// The very last safety net before A6 writes anything to Google Ads. It takes
// the structure (A3) + ads (A4) + brand seed and produces a CLEANED, VALIDATED
// build plan. Its whole job is to protect the user's money: a campaign must
// never be created half-broken (duplicate keywords that make Google reject a
// whole batch, an ad with no valid landing URL, an RSA below Google's minimums,
// text over the hard character limits, ...).
//
// PURE FUNCTIONS ONLY — no process.env, no DB, no fetch. Safe to unit-reason
// about and to import anywhere. It REPLACES NOTHING: A4 and A5 still do their
// jobs; this is belt-and-suspenders at the final code gate.
// ============================================================================

import {
  RSA_LIMITS,
  type PlannedAdGroup,
  type PlannedKeyword,
  type StructureOutput,
  type RSAOutput,
  type AdGroupAds,
  type RSAHeadline,
  type RSADescription,
  type BrandSeed,
} from "@/lib/engine/types";

// ----------------------------------------------------------------------------
// Final URL — Google rejects an ad whose final URL is not a valid absolute
// http(s) URL. We coerce to https, accept a bare domain, and validate. Returns
// null when the input cannot be salvaged into a valid https URL.
// ----------------------------------------------------------------------------

export function normalizeFinalUrl(
  raw: string | undefined | null
): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Strip wrapping quotes the LLM sometimes leaves in.
  s = s.replace(/^['"]+|['"]+$/g, "").trim();
  if (!s) return null;

  if (/^https?:\/\//i.test(s)) {
    s = s.replace(/^http:\/\//i, "https://"); // force https
  } else {
    s = `https://${s.replace(/^\/+/, "")}`; // bare domain / protocol-relative
  }

  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    // A real landing page needs a dotted host (rejects "https://localhost",
    // "https://foo", and other non-routable hosts that Google would refuse).
    if (!u.hostname || !u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Keywords — drop empties and collapse exact duplicates (same text + match
// type). A duplicate keyword in one ad-group batch makes Google reject the
// WHOLE batch, which would otherwise sink an entire ad group.
// ----------------------------------------------------------------------------

const keywordKey = (k: PlannedKeyword): string =>
  `${k.text.trim().toLowerCase()}::${k.matchType}`;

export function dedupeKeywords(
  list: PlannedKeyword[] | undefined | null
): PlannedKeyword[] {
  const seen = new Set<string>();
  const out: PlannedKeyword[] = [];
  for (const k of list ?? []) {
    const text = (k?.text ?? "").trim();
    if (!text || !k?.matchType) continue;
    const normalized: PlannedKeyword = { text, matchType: k.matchType };
    const key = keywordKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

// ----------------------------------------------------------------------------
// RSA — clamp every field to Google's hard character limits, trim, drop empties
// and de-duplicate identical headlines/descriptions, and cap counts. Truncation
// can only make an otherwise-rejected ad valid, so it is always safe.
// ----------------------------------------------------------------------------

function clampText(t: string | undefined | null, max: number): string {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max).trim();
}

export function sanitizeRsa(ad: AdGroupAds | undefined | null): AdGroupAds | null {
  if (!ad) return null;

  const seenH = new Set<string>();
  const headlines: RSAHeadline[] = [];
  for (const h of ad.headlines ?? []) {
    const text = clampText(h?.text, RSA_LIMITS.headlineMaxChars);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seenH.has(key)) continue;
    seenH.add(key);
    headlines.push({
      text,
      ...(h.pinnedField ? { pinnedField: h.pinnedField } : {}),
    });
    if (headlines.length >= RSA_LIMITS.maxHeadlines) break;
  }

  const seenD = new Set<string>();
  const descriptions: RSADescription[] = [];
  for (const d of ad.descriptions ?? []) {
    const text = clampText(d?.text, RSA_LIMITS.descriptionMaxChars);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seenD.has(key)) continue;
    seenD.add(key);
    descriptions.push({
      text,
      ...(d.pinnedField ? { pinnedField: d.pinnedField } : {}),
    });
    if (descriptions.length >= RSA_LIMITS.maxDescriptions) break;
  }

  const path1 = ad.path1 ? clampText(ad.path1, RSA_LIMITS.path1MaxChars) : "";
  const path2 = ad.path2 ? clampText(ad.path2, RSA_LIMITS.path2MaxChars) : "";

  return {
    adGroupName: ad.adGroupName,
    headlines,
    descriptions,
    ...(path1 ? { path1 } : {}),
    ...(path2 ? { path2 } : {}),
    finalUrl: ad.finalUrl,
  };
}

export function rsaMeetsMinimums(ad: AdGroupAds | null): boolean {
  return (
    !!ad &&
    ad.headlines.length >= RSA_LIMITS.minHeadlines &&
    ad.descriptions.length >= RSA_LIMITS.minDescriptions
  );
}

// ----------------------------------------------------------------------------
// Whole-plan sanitizer. Produces the cleaned ad groups that ARE safe to push,
// plus a list of the ones dropped (with a plain-Spanish reason) so the caller
// can surface exactly what was skipped — never a silent truncation.
// ----------------------------------------------------------------------------

export interface SanitizedAdGroupPlan {
  /** Ad group with deduped keywords/negatives and a valid https landing URL. */
  group: PlannedAdGroup;
  /** Sanitized RSA whose finalUrl is a valid https URL. */
  ad: AdGroupAds;
}

export interface SanitizedPlan {
  campaignName: string;
  adGroups: SanitizedAdGroupPlan[];
  sharedNegatives: PlannedKeyword[];
  /** Ad groups dropped before any Google write, with the reason. */
  skipped: { name: string; reason: string }[];
}

export function buildSanitizedPlan(
  structure: StructureOutput,
  rsa: RSAOutput,
  brand: BrandSeed
): SanitizedPlan {
  const fallbackUrl =
    normalizeFinalUrl(brand.landingPageUrl) ??
    normalizeFinalUrl(brand.brandWebsite);

  const adsByGroup = new Map<string, AdGroupAds>();
  for (const a of rsa.ads ?? []) adsByGroup.set(a.adGroupName, a);

  const adGroups: SanitizedAdGroupPlan[] = [];
  const skipped: { name: string; reason: string }[] = [];

  // A keyword (text + match type) may live in only ONE ad group. The same
  // keyword in two groups makes them compete internally for the same query
  // (ambiguous serving, wasted spend). dedupeKeywords only collapses WITHIN a
  // group, so we also dedupe ACROSS groups here — first group to claim it wins.
  const seenKeywordKeys = new Set<string>();

  for (const g of structure.adGroups ?? []) {
    const name = g?.name ?? "(sin nombre)";

    const groupKeywords = dedupeKeywords(g?.keywords);
    if (groupKeywords.length === 0) {
      skipped.push({ name, reason: "sin palabras clave válidas" });
      continue;
    }
    const keywords = groupKeywords.filter((k) => {
      const key = keywordKey(k);
      if (seenKeywordKeys.has(key)) return false;
      seenKeywordKeys.add(key);
      return true;
    });
    if (keywords.length === 0) {
      skipped.push({
        name,
        reason: "sus palabras clave ya estaban en otro grupo",
      });
      continue;
    }

    const ad0 = sanitizeRsa(adsByGroup.get(g.name));
    if (!rsaMeetsMinimums(ad0)) {
      skipped.push({
        name,
        reason: "anuncio incompleto (mínimo 3 títulos y 2 descripciones)",
      });
      continue;
    }

    const url =
      normalizeFinalUrl(ad0!.finalUrl) ??
      normalizeFinalUrl(g.landingPageUrl) ??
      fallbackUrl;
    if (!url) {
      skipped.push({ name, reason: "sin enlace de destino válido" });
      continue;
    }

    const ad: AdGroupAds = { ...ad0!, finalUrl: url };
    const group: PlannedAdGroup = {
      ...g,
      keywords,
      negativeKeywords: dedupeKeywords(g.negativeKeywords),
      landingPageUrl: normalizeFinalUrl(g.landingPageUrl) ?? url,
    };
    adGroups.push({ group, ad });
  }

  return {
    campaignName: structure.campaignName,
    adGroups,
    sharedNegatives: dedupeKeywords(structure.sharedNegatives),
    skipped,
  };
}
