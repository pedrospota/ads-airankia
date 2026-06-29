# Google Ads Benchmark Suite — Windmill port

A copy of Pedro's n8n workflow **"google ads benchmark suite transaprency mcp"**, ported to Windmill as code. Same data sources, same agent prompt — but versionable, callable as a clean HTTP endpoint, and consumable by the `ads-airankia` app.

## What it does

`keyword` → **who's really advertising on it** (Oxylabs) → **their active ad creatives** from the Google Ads Transparency Center (SerpApi) → **AI benchmark** (the original "benchmark agent" prompt).

This fixes the v1 mismatch: the app shipped on SearchApi.io + SERP discovery (→ "Ad-spy error", 0 advertisers). This port uses the **real** stack from the n8n JSON.

## Files

```
f/benchmark/
  oxylabs_keyword_ads.ts      # keyword -> advertisers (Oxylabs google_ads, REAL ads)
  serpapi_transparency.ts     # domain  -> ad creatives + full image URLs (SerpApi)
  analyze_benchmark.ts        # AI synthesis (ported benchmark-agent system prompt)
  benchmark_suite.flow.yaml   # the flow that chains the three (parallel per advertiser)
```

## Required Windmill resources (create as SECRETS)

| Path | Shape | From |
|---|---|---|
| `f/benchmark/oxylabs` | `{ "username": "...", "password": "..." }` | n8n cred "oxylabs marketing" |
| `f/benchmark/serpapi` | `{ "api_key": "..." }` | n8n cred "serp api marketing" — **rotate the exposed one first** |
| `f/benchmark/openrouter` | `{ "api_key": "sk-or-..." }` | same OpenRouter key the app uses |

> The SerpApi key and the Google Ads dev-token were sitting in plaintext inside n8n nodes. Rotate them and store only here as Windmill secrets.

## Get it into Windmill (pick one)

**A. wmill CLI (recommended — this folder is already in CLI layout)**
```bash
cd windmill
wmill workspace add <name> <workspace_id> https://<your-windmill>/
wmill sync push          # pushes scripts + flow (inlines the .ts into the flow)
```

**B. UI** — create the 3 resources above, then create one Bun script per `.ts` file (paste the code), then build a flow with the 3 steps (step 2 is a parallel for-loop over `results.discover.advertisers`).

**C. REST API** — `POST https://<your-windmill>/api/w/<workspace>/flows/create` with the flow body (I can do this for you if you give me the URL + a token).

## How the app calls it

Once deployed, the `ads-airankia` Competitor Benchmark screen calls:

```
POST https://<your-windmill>/api/w/<workspace>/jobs/run_wait_result/f/benchmark/benchmark_suite
Authorization: Bearer <WINDMILL_TOKEN>
Content-Type: application/json

{ "keyword": "ai seo tools", "geo_location": "United States", "region": "2840", "mode": "normal", "brand_language": "en" }
```

→ returns `{ discover, transparency, analyze }` as structured JSON. We render the advertisers, oldest-5 ads (with real image URLs), and the AI teardown, each tagged with its source.

## Modes (from the original agent)

- **normal** — keyword → Oxylabs → advertisers → SerpApi per advertiser → analyze.
- **company** — skip discovery; pass known domains straight to SerpApi (transparency accepts **domains only**).
- **extended** — normal + Firecrawl scrape of each ad's final URL (CTAs/offer/pricing → ROI). *TODO below.*

## TODO (next steps to reach full parity with the n8n suite)

- [ ] `firecrawl_scrape.ts` — parallel landing-page scrape for **extended** mode (CTAs, offer, pricing → revenue/ROI). n8n uses the Firecrawl MCP at `automations.ideacharge.com/mcp/firecrawlscrapper`.
- [ ] `gads_keyword_planner.ts` — real volume/CPC via `generateKeywordHistoricalMetrics` (Google Ads API v19).
- [ ] `gads_forecast.ts` — **real** spend/clicks/ROI via `generateKeywordForecastMetrics` (replaces the app's *modeled* ~$XXXk spend estimate). Needs OAuth refresh-token → access-token + dev-token (rotate first), account currency MXN→USD conversion as in the n8n "forecastagent2".
- [ ] OCR step for image/display ad creatives.
- [ ] Wire the `ads-airankia` benchmark engine to call this flow instead of SearchApi.io.
