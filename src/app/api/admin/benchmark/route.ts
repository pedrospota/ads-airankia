// ============================================================================
// Admin benchmark API — read/write the benchmark config + the PAID ad-spy gate
// + the SearchApi key. Admin-gated. The SearchApi key is WRITE-ONLY: it is
// never returned to the client; GET only reports whether one is set.
//
// SAFETY: turning `liveEnabled` on does NOT spend anything by itself — the ad-spy
// only runs when liveEnabled AND a key are both present (adSpyAllowed()). This
// endpoint is the only way to flip the gate from the UI.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin";
import {
  getBenchmarkConfig,
  setBenchmarkConfig,
  setSearchApiKey,
  hasSearchApiKey,
  searchApiKeyFromEnv,
} from "@/lib/benchmark/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function snapshot() {
  const config = await getBenchmarkConfig();
  return {
    liveEnabled: config.liveEnabled,
    maxCompetitors: config.maxCompetitors,
    maxAdsPerDomain: config.maxAdsPerDomain,
    searchApiKeySet: await hasSearchApiKey(),
    searchApiKeyFromEnv: searchApiKeyFromEnv(),
  };
}

// GET — current benchmark config + whether a SearchApi key is set (no secrets).
export async function GET() {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(await snapshot());
}

interface Body {
  liveEnabled?: boolean;
  maxCompetitors?: number;
  maxAdsPerDomain?: number;
  searchApiKey?: string;
}

// POST — update the gate / caps and/or the SearchApi key (never echoed back).
export async function POST(request: NextRequest) {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: Body;
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as Body) : {};
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // --- Secret first (write-only) -------------------------------------------
  if (typeof body.searchApiKey === "string" && body.searchApiKey.trim()) {
    await setSearchApiKey(body.searchApiKey);
  }

  // --- Config --------------------------------------------------------------
  const patch: Parameters<typeof setBenchmarkConfig>[0] = {};
  if (typeof body.liveEnabled === "boolean") patch.liveEnabled = body.liveEnabled;
  if (typeof body.maxCompetitors === "number") patch.maxCompetitors = body.maxCompetitors;
  if (typeof body.maxAdsPerDomain === "number") patch.maxAdsPerDomain = body.maxAdsPerDomain;
  if (Object.keys(patch).length > 0) await setBenchmarkConfig(patch);

  return NextResponse.json({ ok: true, ...(await snapshot()) });
}
