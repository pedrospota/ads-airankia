// ============================================================================
// Admin settings API — read/write the LLM provider + model config + OpenRouter
// key. Admin-gated. The OpenRouter key is WRITE-ONLY: it is never returned to
// the client; GET only reports whether one is set.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin";
import {
  getLlmConfig,
  setLlmConfig,
  setOpenRouterKey,
  hasOpenRouterKey,
  openRouterKeyFromEnv,
  type LlmProvider,
} from "@/lib/llm/settings";
import type { AgentId } from "@/lib/engine/types";
import { PIPELINE } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_AGENTS = new Set<AgentId>(PIPELINE);

// GET — current config (no secrets) + whether a key is set.
export async function GET() {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const config = await getLlmConfig();
  return NextResponse.json({
    provider: config.provider,
    defaultModel: config.defaultModel,
    perAgent: config.perAgent,
    openrouterKeySet: await hasOpenRouterKey(),
    openrouterKeyFromEnv: openRouterKeyFromEnv(),
  });
}

interface SettingsBody {
  provider?: LlmProvider;
  defaultModel?: string | null;
  perAgent?: Record<string, string | null>;
  openrouterApiKey?: string;
}

// POST — update config and/or the OpenRouter key. The key is never echoed back.
export async function POST(request: NextRequest) {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: SettingsBody;
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as SettingsBody) : {};
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // --- Secret first (write-only) -------------------------------------------
  if (typeof body.openrouterApiKey === "string" && body.openrouterApiKey.trim()) {
    await setOpenRouterKey(body.openrouterApiKey);
  }

  // --- Config --------------------------------------------------------------
  const patch: Parameters<typeof setLlmConfig>[0] = {};

  if (body.provider === "anthropic" || body.provider === "openrouter") {
    patch.provider = body.provider;
  }

  if (body.defaultModel !== undefined) {
    patch.defaultModel =
      typeof body.defaultModel === "string" && body.defaultModel.trim()
        ? body.defaultModel.trim()
        : null;
  }

  if (body.perAgent !== undefined && body.perAgent && typeof body.perAgent === "object") {
    const clean: Partial<Record<AgentId, string>> = {};
    for (const [k, v] of Object.entries(body.perAgent)) {
      if (!VALID_AGENTS.has(k as AgentId)) continue;
      if (typeof v === "string" && v.trim()) clean[k as AgentId] = v.trim();
      // null / empty string => clear the override (omit it)
    }
    patch.perAgent = clean;
  }

  let config = await getLlmConfig();
  if (Object.keys(patch).length > 0) {
    config = await setLlmConfig(patch);
  }

  return NextResponse.json({
    ok: true,
    provider: config.provider,
    defaultModel: config.defaultModel,
    perAgent: config.perAgent,
    openrouterKeySet: await hasOpenRouterKey(),
    openrouterKeyFromEnv: openRouterKeyFromEnv(),
  });
}
