import * as wmill from "windmill-client"

/**
 * Keyword -> who is running Google Search ads on it (REAL data via Oxylabs).
 *
 * Port of the n8n node "google ads by keyword":
 *   POST https://realtime.oxylabs.io/v1/queries
 *   body { source:"google_ads", query:<keyword>, geo_location:<country>, parse:true }
 *   auth: HTTP Basic (Oxylabs username/password)
 *
 * This is the piece Pedro asked for: "put a keyword and detect who's doing ads
 * on that keyword, like REAL data."
 */

type OxylabsCreds = { username: string; password: string }

export type DiscoveredAd = {
  position: number | null
  title: string | null
  description: string | null
  displayed_url: string | null
  url: string | null
  domain: string | null
}

function toDomain(u?: string | null): string | null {
  if (!u) return null
  try {
    const h = new URL(u.startsWith("http") ? u : `https://${u}`).hostname
    return h.replace(/^www\./, "").toLowerCase()
  } catch {
    return null
  }
}

export async function main(
  keyword: string,
  geo_location = "United States",
  // Pass creds inline for testing, otherwise read the Windmill resource.
  oxylabs?: OxylabsCreds,
) {
  const creds = oxylabs ?? (await wmill.getResource<OxylabsCreds>("f/benchmark/oxylabs"))
  const auth = "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64")

  const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ source: "google_ads", query: keyword, geo_location, parse: true }),
  })
  if (!res.ok) throw new Error(`Oxylabs ${res.status}: ${await res.text()}`)
  const data = await res.json()

  // Oxylabs parsed google_ads: ads live under results[0].content.results.
  // Buckets vary (paid / ads / top_ads / bottom_ads) so we collect defensively.
  const content = data?.results?.[0]?.content ?? {}
  const buckets = content?.results ?? content
  const rawAds: any[] = []
  for (const key of ["paid", "ads", "top_ads", "bottom_ads", "shopping"]) {
    const arr = buckets?.[key]
    if (Array.isArray(arr)) rawAds.push(...arr)
  }

  const ads: DiscoveredAd[] = rawAds.map((a) => {
    const url = a.url ?? a.link ?? a.url_shown ?? null
    return {
      position: a.pos ?? a.position ?? null,
      title: a.title ?? a.headline ?? null,
      description: a.desc ?? a.description ?? null,
      displayed_url: a.url_shown ?? a.displayed_url ?? null,
      url,
      domain: toDomain(a.url_shown ?? url),
    }
  })

  const advertisers = [...new Set(ads.map((x) => x.domain).filter(Boolean))] as string[]
  return { keyword, geo_location, advertisers, ads, raw_count: rawAds.length }
}
