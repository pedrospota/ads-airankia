import { BenchmarkLab } from "./benchmark-lab";
import { isWindmillConfigured } from "@/lib/benchmark/windmill";
import { buildSampleReport } from "@/lib/benchmark/lab-sample";
import { findCountry, DEFAULT_COUNTRY } from "@/lib/benchmark/countries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Standalone Competitor Benchmark Lab: configure country / language / keywords
// and render the report. The page renders for everyone with a DEMO sample so it
// always looks alive; live runs are gated behind auth in /api/benchmark/lab.
export default function BenchmarkLabPage() {
  const configured = isWindmillConfigured();
  const c = findCountry(DEFAULT_COUNTRY);
  const initialReport = buildSampleReport({
    keywords: ["ai seo tools"],
    countryCode: c.code,
    countryName: c.name,
    geo: c.geo,
    region: c.region,
    language: c.lang,
    mode: "keyword",
    numKeywords: 1,
    numCompetitors: 6,
  });

  return <BenchmarkLab windmillConfigured={configured} initialReport={initialReport} />;
}
