import * as wmill from "windmill-client"

/**
 * Competitor active ad creatives from the Google Ads Transparency Center (SerpApi).
 *
 * Port of the n8n nodes "google ads transparency report*":
 *   GET https://serpapi.com/search
 *     engine=google_ads_transparency_center
 *     text=<domain or company>     (Pedro's rule: transparency only accepts DOMAINS)
 *     region=<geo, e.g. 2840 for US>   (omit = anywhere)
 *     platform=SEARCH|MAPS|YOUTUBE|GOOGLEPLAY  (optional)
 *     creative_format=text|image|video         (optional)
 *
 * Returns the FULL ad image URL (tpc.googlesyndication.com/...), not the CR id,
 * per Pedro's explicit requirement, plus days-active so we can rank oldest ads.
 */

type SerpCreds = { api_key: string }

export async function main(
  domain: string,
  region = "",
  platform = "",
  creative_format = "",
  serpapi?: SerpCreds,
) {
  const creds = serpapi ?? (await wmill.getResource<SerpCreds>("f/benchmark/serpapi"))

  const qs = new URLSearchParams({
    engine: "google_ads_transparency_center",
    text: domain,
    api_key: creds.api_key,
  })
  if (region) qs.set("region", region)
  if (platform) qs.set("platform", platform)
  if (creative_format) qs.set("creative_format", creative_format)

  const res = await fetch(`https://serpapi.com/search?${qs.toString()}`)
  if (!res.ok) throw new Error(`SerpApi ${res.status}: ${await res.text()}`)
  const data = await res.json()

  const creatives: any[] = data.ad_creatives ?? data.ads ?? []
  const ads = creatives.map((c) => ({
    advertiser: c.advertiser ?? c.advertiser_name ?? null,
    advertiser_id: c.advertiser_id ?? null,
    legal_name: c.advertiser_legal_name ?? c.legal_name ?? null,
    target_domain: c.target_domain ?? domain,
    format: c.format ?? null,
    first_shown: c.first_shown ?? c.first_shown_date ?? null,
    last_shown: c.last_shown ?? c.last_shown_date ?? null,
    days_active: c.total_days_shown ?? c.days ?? null,
    // full image / preview, never the bare CR id
    image_url: c.image ?? c.thumbnail ?? c.preview ?? null,
    details_link: c.details_link ?? c.link ?? null,
  }))

  ads.sort((a, b) => (Number(b.days_active) || 0) - (Number(a.days_active) || 0))

  return {
    domain,
    region: region || "anywhere",
    total_ads: ads.length,
    oldest_top5: ads.slice(0, 5),
    ads,
  }
}
