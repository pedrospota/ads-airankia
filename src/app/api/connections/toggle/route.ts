import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ToggleBody {
  account_id?: unknown;
  enabled?: unknown;
  brand_id?: unknown;
}

// POST /api/connections/toggle — enable/disable a discovered account and/or
// map it to a brand. Body: { account_id, enabled?, brand_id? }. Only the
// provided fields are updated. RLS (workspace membership through the
// connection) enforces ownership: an update on someone else's row matches 0
// rows and returns 404.
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: ToggleBody;
  try {
    body = (await request.json()) as ToggleBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const accountId = typeof body.account_id === "string" ? body.account_id : null;
  if (!accountId) {
    return NextResponse.json({ error: "account_id es obligatorio" }, { status: 400 });
  }

  const update: { enabled?: boolean; brand_id?: string | null } = {};
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;
  if (typeof body.brand_id === "string" && body.brand_id) update.brand_id = body.brand_id;
  else if (body.brand_id === null || body.brand_id === "") update.brand_id = null;

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "Nada que actualizar (envía enabled y/o brand_id)." },
      { status: 400 }
    );
  }

  const {
    data: { session },
  } = await authClient.auth.getSession();
  const db = createSupabaseReadClient(session?.access_token);

  const { data, error } = await db
    .from("ads_connection_accounts")
    .update(update)
    .eq("id", accountId)
    .select("id, enabled, brand_id");

  if (error) {
    console.error("[connections/toggle] update failed", error);
    return NextResponse.json(
      { error: "No se pudo actualizar la cuenta." },
      { status: 500 }
    );
  }
  if (!data || data.length === 0) {
    // RLS filtered the row out (not yours) or the id doesn't exist.
    return NextResponse.json({ error: "Cuenta no encontrada." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, account: data[0] });
}
