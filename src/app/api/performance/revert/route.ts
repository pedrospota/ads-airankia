// ============================================================================
// POST /api/performance/revert — undo a recorded approval (the "deshacer" of
// the propose-only flow; nothing was ever executed in Google Ads).
//
// Body: { accountId, rec_key }. Auth-gated with the Supabase session; the
// engine call is server-to-server (SENTINEL_API_KEY never reaches the browser).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { postRevert } from "@/lib/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { accountId?: unknown; rec_key?: unknown };
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

  try {
    const out = await postRevert(accountId, recKey);
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No se pudo deshacer la aprobación." },
      { status: 502 }
    );
  }
}
