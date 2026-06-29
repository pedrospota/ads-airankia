import * as wmill from "windmill-client"

/**
 * AI benchmark synthesis — port of the n8n "benchmark agent" system prompt.
 * Takes discovered advertisers + their Transparency-Center creatives and
 * produces the structured competitive teardown Pedro specified.
 *
 * LLM via OpenRouter (same provider the app/admin already use).
 */

type LLMCreds = { api_key: string }

const SYSTEM = `Act like a professional marketer doing a benchmark and uncovering competitors' Google Ads strategies.

You receive:
- a keyword,
- the advertisers detected running ads on that keyword (from Oxylabs google_ads),
- each advertiser's Transparency-Center ad creatives (from SerpApi).

Produce a structured benchmark in the brand's language:
- total ads, country analyzed, average ad age
- TOP 5 OLDEST ads: return the FULL image URL (e.g. https://tpc.googlesyndication.com/archive/simgad/...), NOT the CR id, each with days active
- the landing / final URLs each ad points to
- calls to action
- possible keywords used in their campaigns
- legal entity names running the ads
- headlines & descriptions: in how many ads each appears, with PERCENTAGES and totals
- a keyword-recommendation ranking: at least 10 keywords mined from the most-used headline/description terms, to use in my Google Ads campaigns
- whether they run brand-competitor ads

Be concrete and use only the real data provided. Do not invent ad IDs or URLs.`

export async function main(
  keyword: string,
  mode: "normal" | "company" | "extended" = "normal",
  advertisers: string[] = [],
  transparency: unknown[] = [],
  brand_language = "en",
  openrouter?: LLMCreds,
  model = "anthropic/claude-opus-4.1",
) {
  const creds = openrouter ?? (await wmill.getResource<LLMCreds>("f/benchmark/openrouter"))

  const payload = JSON.stringify({ keyword, mode, advertisers, transparency }, null, 2)
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.api_key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: `${SYSTEM}\n\nBrand language for the output: ${brand_language}.` },
        { role: "user", content: `Benchmark data:\n${payload}` },
      ],
    }),
  })
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
  const data = await res.json()

  return {
    keyword,
    mode,
    brand_language,
    advertiser_count: advertisers.length,
    model,
    analysis: data?.choices?.[0]?.message?.content ?? "",
  }
}
