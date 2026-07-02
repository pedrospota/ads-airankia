// ============================================================================
// POST /api/performance/approve — record a human approval of an optimizer
// proposal (PROPOSE-ONLY: nothing executes in Google Ads).
//
// Body: { accountId, rec_key, title?, detail? }. Auth-gated with the Supabase
// session; the engine call happens server-to-server via src/lib/sentinel.ts,
// so SENTINEL_API_KEY never reaches the browser. approved_by is always the
// logged-in user's email (never taken from the body).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { postApprove } from "@/lib/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    accountId?: unknown;
    rec_key?: unknown;
    title?: unknown;
    detail?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const accountId = String(body.accountId ?? "").trim();
  const recKey = String(body.rec_key ?? "").trim();
  if (!accountId || !recKey) {
    return NextResponse.json(
      { error: "accountId y rec_key son obligatorios" },
      { status: 400 }
    );
  }

  const detail =
    body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
      ? (body.detail as Record<string, unknown>)
      : undefined;

  try {
    const out = await postApprove(accountId, {
      rec_key: recKey,
      title: typeof body.title === "string" ? body.title.slice(0, 200) : undefined,
      detail,
      approved_by: user.email ?? "plataforma",
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No se pudo registrar la aprobación." },
      { status: 502 }
    );
  }
}
