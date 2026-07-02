import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/connections/accounts — connections of the user's workspaces with
// their discovered accounts. RLS (workspace membership) scopes the rows; the
// refresh token is NEVER selected.
export async function GET() {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const {
    data: { session },
  } = await authClient.auth.getSession();
  const db = createSupabaseReadClient(session?.access_token);

  const { data, error } = await db
    .from("ads_google_connections")
    .select(
      "id, workspace_id, provider, google_email, status, is_engine_source, created_at, ads_connection_accounts(id, customer_id, descriptive_name, currency, time_zone, is_manager, enabled, brand_id)"
    )
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[connections/accounts] select failed", error);
    return NextResponse.json(
      { error: "No se pudieron cargar las conexiones." },
      { status: 500 }
    );
  }

  return NextResponse.json({ connections: data ?? [] });
}
