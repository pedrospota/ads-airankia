import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { decryptSecret } from "@/lib/ads-connections";
import { postEngineSetToken } from "@/lib/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EngineSourceBody {
  connection_id?: unknown;
}

// POST /api/connections/engine-source — mark one Google Ads connection as the
// engine's scan source (F4 bridge). Body: { connection_id }.
//
// Flow:
//   1. Auth-gate (Supabase user, 401 otherwise).
//   2. Load the connection through the USER-SCOPED client — RLS proves the
//      caller belongs to the connection's workspace (0 rows ⇒ 404).
//   3. Decrypt the refresh token and hand it to the engine (server-to-server
//      POST to /admin/set-token — read-only scanning on the engine side).
//   4. On success, flip is_engine_source: true for this row, false for its
//      workspace siblings (only one source per workspace).
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: EngineSourceBody;
  try {
    body = (await request.json()) as EngineSourceBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const connectionId =
    typeof body.connection_id === "string" && body.connection_id
      ? body.connection_id
      : null;
  if (!connectionId) {
    return NextResponse.json(
      { error: "connection_id es obligatorio" },
      { status: 400 }
    );
  }

  const {
    data: { session },
  } = await authClient.auth.getSession();
  const db = createSupabaseReadClient(session?.access_token);

  // RLS-scoped read: if the row isn't in one of the caller's workspaces the
  // select matches nothing and we answer 404 (no existence leak).
  const { data: connection, error: loadError } = await db
    .from("ads_google_connections")
    .select("id, workspace_id, google_email, refresh_token_enc")
    .eq("id", connectionId)
    .maybeSingle();

  if (loadError) {
    console.error("[connections/engine-source] load failed", loadError);
    return NextResponse.json(
      { error: "No se pudo cargar la conexión." },
      { status: 500 }
    );
  }
  if (!connection || !connection.refresh_token_enc) {
    return NextResponse.json({ error: "Conexión no encontrada." }, { status: 404 });
  }

  // Decrypt + hand off to the engine. The token only lives in memory here.
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(connection.refresh_token_enc);
  } catch (e) {
    console.error("[connections/engine-source] decrypt failed", e);
    return NextResponse.json(
      { error: "No se pudo descifrar el token de esta conexión. Vuelve a conectarla." },
      { status: 500 }
    );
  }

  try {
    await postEngineSetToken(connection.google_email, refreshToken);
  } catch (e) {
    console.error("[connections/engine-source] engine set-token failed", e);
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "El motor no aceptó la conexión. Vuelve a intentarlo.",
      },
      { status: 502 }
    );
  }

  // The engine accepted the token — persist the flag. Clear the workspace
  // siblings first so exactly one connection is the source.
  const { error: clearError } = await db
    .from("ads_google_connections")
    .update({ is_engine_source: false })
    .eq("workspace_id", connection.workspace_id)
    .neq("id", connection.id);
  if (clearError) {
    console.error("[connections/engine-source] clear siblings failed", clearError);
    return NextResponse.json(
      { error: "El motor quedó configurado, pero no se pudo actualizar el estado. Recarga la página." },
      { status: 500 }
    );
  }

  const { data: updated, error: setError } = await db
    .from("ads_google_connections")
    .update({ is_engine_source: true })
    .eq("id", connection.id)
    .select("id, is_engine_source");
  if (setError || !updated || updated.length === 0) {
    console.error("[connections/engine-source] set flag failed", setError);
    return NextResponse.json(
      { error: "El motor quedó configurado, pero no se pudo actualizar el estado. Recarga la página." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
