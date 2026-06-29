/**
 * Final flow step: combine the three stages into ONE object so that
 * `run_wait_result` returns everything (discovery + transparency + analysis),
 * not just the last module's output.
 *
 * The ads-airankia proxy (src/lib/benchmark/windmill.ts) consumes this exact
 * shape and normalises it into a LabReport.
 */
export async function main(
  keyword: string,
  advertisers: string[] = [],
  discover_ads: unknown[] = [],
  transparency: unknown[] = [],
  analyze: unknown = null,
) {
  return { keyword, advertisers, discover_ads, transparency, analyze }
}
