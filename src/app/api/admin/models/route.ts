// ============================================================================
// Admin models API — the LIVE OpenRouter model catalogue, so the dropdown shows
// the newest models (GLM, Kimi, DeepSeek, Qwen, GPT, Gemini, Claude, ...)
// without us hardcoding or hallucinating model slugs.
//
// Admin-gated. Results are cached in-process for a few minutes (the catalogue
// changes slowly and the list is large).
// ============================================================================

import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin";
import { fetchOpenRouterModels, type ORModel } from "@/lib/llm/openrouter";
import { getOpenRouterKey } from "@/lib/llm/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { models: ORModel[]; at: number } | null = null;

export async function GET() {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ models: cache.models, cached: true });
  }

  try {
    // The public catalogue works without a key; pass one if we have it.
    const key = await getOpenRouterKey();
    const models = await fetchOpenRouterModels(key);
    // Sort newest first (then by name) so the freshest models surface on top.
    models.sort((a, b) => {
      const ca = a.created ?? 0;
      const cb = b.created ?? 0;
      if (cb !== ca) return cb - ca;
      return a.name.localeCompare(b.name);
    });
    cache = { models, at: Date.now() };
    return NextResponse.json({ models, cached: false });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "Couldn't fetch the OpenRouter model list",
      },
      { status: 502 }
    );
  }
}
