// ============================================================================
// Brand Defense (Oxylabs) — who is bidding on YOUR brand's terms.
//
// Powers the "🛡️ Brand Defense" tool: run a real-time Google Ads SERP for each
// of the brand's own branded keywords (the brand name + obvious variants) and
// surface the advertisers that are NOT the brand itself — the "conquesters"
// poaching brand-intent traffic — together with their ad copy.
//
// REUSES the live discovery primitive `oxylabsKeywordAds()` (never reimplements
// it). Geo comes from findCountry(countryCode).geo. The brand's own domain is
// excluded from the results so only genuine threats remain. Never throws.
//
// Produces a typed slice of the CompetitiveBrief: BrandThreatSlice[] (see
// @/lib/spy/brief) plus a richer UI shape (headline + displayed url + position).
// ============================================================================

import { oxylabsKeywordAds, oxylabsConfigured } from "@/lib/benchmark/oxylabs";
import { toDomain } from "@/lib/benchmark/page-fetch";
import type { BenchmarkCostContext } from "@/lib/benchmark/types";
import type { BrandThreatSlice } from "@/lib/spy/brief";

export { oxylabsConfigured };

/** One advertiser bidding on a branded keyword that is NOT the brand. */
export interface Conquester {
  domain: string;
  headline: string | null;
  description: string | null;
  displayedUrl: string | null;
  url: string | null;
  position: number | null;
}

/** Richer per-keyword UI shape (maps down to BrandThreatSlice). */
export interface BrandThreat {
  brandKeyword: string;
  conquesters: Conquester[];
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** True when `candidate` is the brand's own domain (or a sub/parent of it). */
function isBrandOwned(candidate: string, brand: string | null): boolean {
  if (!brand) return false;
  if (candidate === brand) return true;
  if (candidate.endsWith(`.${brand}`) || brand.endsWith(`.${candidate}`)) return true;
  // Brand supplied as a TLD-less label (e.g. "airankia" from a brand NAME, no
  // domain) — match any candidate whose registrable label is that brand so the
  // brand's own ad (airankia.com) isn't mis-flagged as a conquester.
  if (!brand.includes(".") && candidate.split(".")[0] === brand) return true;
  return false;
}

/**
 * Run Brand Defense across up to 3 branded keywords.
 * Returns one BrandThreat per keyword (the conquesters bidding on it, brand
 * excluded). Each oxylabs call is metered to the ledger via the shared client.
 */
export async function runBrandDefense(opts: {
  brandDomain: string;
  keywords: string[];
  geo: string;
  cost: BenchmarkCostContext;
}): Promise<{ brandDomain: string; threats: BrandThreat[] }> {
  const brand = toDomain(opts.brandDomain) ?? (opts.brandDomain.trim().toLowerCase() || null);
  const keywords = dedupe(opts.keywords).slice(0, 3);

  const results = await Promise.all(
    keywords.map((kw) => oxylabsKeywordAds(kw, opts.geo, opts.cost))
  );

  const threats: BrandThreat[] = results.map((r, i) => {
    const seen = new Set<string>();
    const conquesters: Conquester[] = [];
    for (const ad of r.ads) {
      const domain = ad.domain;
      if (!domain) continue;
      if (isBrandOwned(domain, brand)) continue; // the brand defending itself is not a threat
      if (seen.has(domain)) continue; // one row per advertiser per keyword
      seen.add(domain);
      conquesters.push({
        domain,
        headline: ad.title,
        description: ad.description,
        displayedUrl: ad.displayedUrl,
        url: ad.url,
        position: ad.positionOverall ?? ad.position,
      });
    }
    return { brandKeyword: keywords[i], conquesters };
  });

  return { brandDomain: brand ?? opts.brandDomain.trim(), threats };
}

/** Narrow the rich UI shape down to the shared CompetitiveBrief slice. */
export function toBrandThreatSlices(threats: BrandThreat[]): BrandThreatSlice[] {
  return threats.map((t) => ({
    brandKeyword: t.brandKeyword,
    conquesters: t.conquesters.map((c) => ({
      domain: c.domain,
      headline: c.headline,
      description: c.description,
    })),
  }));
}
