// ============================================================================
// LLM settings — provider/model config + the OpenRouter API key.
//
// Stored in the ads DB `app_settings` table (key/value). This module is the
// ONLY place that reads/writes those rows.
//
// SECURITY:
//  - The OpenRouter key is resolved env-first (process.env.OPENROUTER_API_KEY),
//    falling back to the DB row. It is NEVER returned to the browser — the admin
//    API only ever exposes a boolean "is it set?".
//  - This file is server-only (imported by agents + admin API, never by client
//    components).
// ============================================================================

import { adsDb } from "@/lib/ads-db";
import { appSettings } from "@/lib/schema";
import { eq } from "drizzle-orm";
import type { AgentId } from "@/lib/engine/types";

export type LlmProvider = "anthropic" | "openrouter";

export interface LlmConfig {
  /** Which provider the agents call. */
  provider: LlmProvider;
  /** OpenRouter model id used when provider === 'openrouter' and no override. */
  defaultModel: string | null;
  /** Optional per-agent OpenRouter model overrides (only used on openrouter). */
  perAgent: Partial<Record<AgentId, string>>;
}

const DEFAULT_CONFIG: LlmConfig = {
  provider: "anthropic",
  defaultModel: null,
  perAgent: {},
};

const KEY_CONFIG = "llm_config";
const KEY_OPENROUTER = "openrouter_api_key";

// Small in-process cache so every agent call doesn't hit the DB. Invalidated on
// write. Safe on a long-lived Node server.
let cache: { config: LlmConfig; at: number } | null = null;
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

/** Bootstrap provider from env (LLM_PROVIDER). Used only when the DB has no row. */
function envProvider(): LlmProvider | null {
  const p = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (p === "openrouter") return "openrouter";
  if (p === "anthropic") return "anthropic";
  return null;
}

/** Bootstrap default model from env (LLM_DEFAULT_MODEL). Used only when no DB row. */
function envDefaultModel(): string | null {
  const m = process.env.LLM_DEFAULT_MODEL?.trim();
  return m ? m : null;
}

function normalizeConfig(stored: Partial<LlmConfig> | null): LlmConfig {
  if (!stored) return { ...DEFAULT_CONFIG };
  return {
    provider: stored.provider === "openrouter" ? "openrouter" : "anthropic",
    defaultModel:
      typeof stored.defaultModel === "string" && stored.defaultModel.trim()
        ? stored.defaultModel.trim()
        : null,
    perAgent:
      stored.perAgent && typeof stored.perAgent === "object"
        ? (stored.perAgent as Partial<Record<AgentId, string>>)
        : {},
  };
}

export async function getLlmConfig(): Promise<LlmConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.config;
  let stored: Partial<LlmConfig> | null = null;
  try {
    stored = await readValue<Partial<LlmConfig>>(KEY_CONFIG);
  } catch {
    // Table may not exist yet (pre-migration) — fall back to defaults so the
    // app keeps working on Anthropic.
    stored = null;
  }
  // DB row wins. If there is none, bootstrap from env so OpenRouter can be
  // turned on via Coolify env vars without touching /admin. Once an admin saves
  // settings (creating the DB row), that takes precedence over env.
  const config = stored
    ? normalizeConfig(stored)
    : {
        provider: envProvider() ?? DEFAULT_CONFIG.provider,
        defaultModel: envDefaultModel() ?? DEFAULT_CONFIG.defaultModel,
        perAgent: {},
      };
  cache = { config, at: Date.now() };
  return config;
}

export async function setLlmConfig(
  partial: Partial<LlmConfig>
): Promise<LlmConfig> {
  const current = await getLlmConfig();
  const next: LlmConfig = {
    provider: partial.provider ?? current.provider,
    defaultModel:
      partial.defaultModel !== undefined
        ? partial.defaultModel
        : current.defaultModel,
    perAgent:
      partial.perAgent !== undefined ? partial.perAgent : current.perAgent,
  };
  await writeValue(KEY_CONFIG, next);
  cache = { config: next, at: Date.now() };
  return next;
}

/**
 * Strip wrapping quotes + whitespace + control chars a pasted / env-injected key
 * may carry. Coolify stored the key WITH literal single quotes ('sk-or-...'),
 * which made the Authorization header `Bearer 'sk-or-...'` → OpenRouter 401 and
 * the whole AI layer failed silently. Cleaning it here fixes every LLM call.
 */
function cleanKey(raw: string | null | undefined): string | undefined {
  let s = (raw ?? "").trim().replace(/[^\x20-\x7E]/g, "");
  if (
    s.length >= 2 &&
    ((s[0] === "'" && s[s.length - 1] === "'") || (s[0] === '"' && s[s.length - 1] === '"'))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s || undefined;
}

/** Resolve the OpenRouter key: env first, then the DB row. Never sent to client. */
export async function getOpenRouterKey(): Promise<string | undefined> {
  const envKey = cleanKey(process.env.OPENROUTER_API_KEY);
  if (envKey) return envKey;
  try {
    return cleanKey(await readValue<string>(KEY_OPENROUTER));
  } catch {
    return undefined;
  }
}

export async function setOpenRouterKey(key: string): Promise<void> {
  await writeValue(KEY_OPENROUTER, key.trim());
}

/** True if a key is available (env or DB). Safe to expose to admins. */
export async function hasOpenRouterKey(): Promise<boolean> {
  return Boolean(await getOpenRouterKey());
}

/** True if the key is pinned in the environment (DB writes won't override it). */
export function openRouterKeyFromEnv(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}
