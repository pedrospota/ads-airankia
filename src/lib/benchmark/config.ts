// ============================================================================
// Benchmark config + the SearchApi key gate.
//
// The benchmark suite's FREE blocks (Keyword Planner crossing, landing teardown)
// always run. The PAID ad-spy block (SearchApi google_ads_transparency_center)
// is OFF by default and only ever runs when BOTH are true:
//   1. an admin flipped `liveEnabled` on (DB row, or env BENCHMARK_LIVE_ENABLED),
//   2. a SearchApi key is present (env SEARCHAPI_API_KEY, or the DB row).
//
// SECURITY: the SearchApi key is WRITE-ONLY. It is never returned to the
// browser — the admin API only reports a boolean "is it set?". This module is
// server-only; it is the single place that reads/writes these app_settings rows.
// ============================================================================

import { adsDb } from "@/lib/ads-db";
import { appSettings } from "@/lib/schema";
import { eq } from "drizzle-orm";

export interface BenchmarkConfig {
  /** Master switch for the paid ad-spy block. Default OFF. */
  liveEnabled: boolean;
  /** Hard cap on competitor domains analyzed per run (cost guard). */
  maxCompetitors: number;
  /** Hard cap on ad creatives pulled per domain when live (cost guard). */
  maxAdsPerDomain: number;
}

const DEFAULT_CONFIG: BenchmarkConfig = {
  liveEnabled: false,
  maxCompetitors: 6,
  maxAdsPerDomain: 12,
};

const KEY_CONFIG = "benchmark_config";
const KEY_SEARCHAPI = "searchapi_api_key";

let cache: { config: BenchmarkConfig; at: number } | null = null;
const TTL_MS = 15_000;

async function readValue<T>(key: string): Promise<T | null> {
  const [row] = await adsDb
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return row ? (row.value as T) : null;
}

async function writeValue(key: string, value: unknown): Promise<void> {
  await adsDb
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

function envLiveEnabled(): boolean | null {
  const v = process.env.BENCHMARK_LIVE_ENABLED?.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on") return true;
  if (v === "false" || v === "0" || v === "off") return false;
  return null;
}

function normalize(stored: Partial<BenchmarkConfig> | null): BenchmarkConfig {
  const envLive = envLiveEnabled();
  return {
    liveEnabled:
      typeof stored?.liveEnabled === "boolean"
        ? stored.liveEnabled
        : envLive ?? DEFAULT_CONFIG.liveEnabled,
    maxCompetitors:
      typeof stored?.maxCompetitors === "number" && stored.maxCompetitors > 0
        ? Math.min(20, Math.round(stored.maxCompetitors))
        : DEFAULT_CONFIG.maxCompetitors,
    maxAdsPerDomain:
      typeof stored?.maxAdsPerDomain === "number" && stored.maxAdsPerDomain > 0
        ? Math.min(50, Math.round(stored.maxAdsPerDomain))
        : DEFAULT_CONFIG.maxAdsPerDomain,
  };
}

export async function getBenchmarkConfig(): Promise<BenchmarkConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.config;
  let stored: Partial<BenchmarkConfig> | null = null;
  try {
    stored = await readValue<Partial<BenchmarkConfig>>(KEY_CONFIG);
  } catch {
    stored = null; // table may not exist yet — fall back to safe defaults
  }
  const config = normalize(stored);
  cache = { config, at: Date.now() };
  return config;
}

export async function setBenchmarkConfig(
  partial: Partial<BenchmarkConfig>
): Promise<BenchmarkConfig> {
  const current = await getBenchmarkConfig();
  const next: BenchmarkConfig = {
    liveEnabled:
      typeof partial.liveEnabled === "boolean"
        ? partial.liveEnabled
        : current.liveEnabled,
    maxCompetitors:
      typeof partial.maxCompetitors === "number" && partial.maxCompetitors > 0
        ? Math.min(20, Math.round(partial.maxCompetitors))
        : current.maxCompetitors,
    maxAdsPerDomain:
      typeof partial.maxAdsPerDomain === "number" && partial.maxAdsPerDomain > 0
        ? Math.min(50, Math.round(partial.maxAdsPerDomain))
        : current.maxAdsPerDomain,
  };
  await writeValue(KEY_CONFIG, next);
  cache = { config: next, at: Date.now() };
  return next;
}

/** Resolve the SearchApi key: env first, then the DB row. Never sent to client. */
export async function getSearchApiKey(): Promise<string | undefined> {
  const envKey = process.env.SEARCHAPI_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  try {
    const stored = await readValue<string>(KEY_SEARCHAPI);
    return stored && stored.trim() ? stored.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function setSearchApiKey(key: string): Promise<void> {
  await writeValue(KEY_SEARCHAPI, key.trim());
}

export async function hasSearchApiKey(): Promise<boolean> {
  return Boolean(await getSearchApiKey());
}

export function searchApiKeyFromEnv(): boolean {
  return Boolean(process.env.SEARCHAPI_API_KEY?.trim());
}

/**
 * The single authority on whether the paid ad-spy may run THIS request.
 * Both the gate AND a usable key are required — defaults to false. Never call a
 * paid endpoint without checking this first.
 */
export async function adSpyAllowed(): Promise<boolean> {
  const config = await getBenchmarkConfig();
  if (!config.liveEnabled) return false;
  return hasSearchApiKey();
}

/**
 * Whether the paid ad-spy / live-discovery may run for ONE specific run.
 *
 * The end user can explicitly opt in per run (the pre-scan "live competitor ads"
 * toggle). That opt-in IS the spending approval, so it bypasses the global admin
 * `liveEnabled` master switch — but a usable SearchApi key is STILL required, so
 * a run can never spend when no key is configured. Without an opt-in it falls
 * back to the global gate. Either way: no key → false → zero spend.
 */
export async function adSpyAllowedForRun(optIn: boolean): Promise<boolean> {
  if (optIn) return hasSearchApiKey();
  return adSpyAllowed();
}
