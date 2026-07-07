// Pull gads-sentinel optimizations for one engine account and stage them as
// cc_actions (source='engine'), deduped by rec_key.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { fetchAccountFull } from "@/lib/sentinel";
import { mapEngineOptimizations } from "@/lib/command/engine-import";
import { createActionDeduped } from "@/lib/command/actions-repo";
import { createSupabaseReadClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body { engine_account_id?: unknown; workspace_id?: unknown; connection_id?: unknown; account_ref?: unknown }

export async function POST(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  let body: Body;
  try { body = (await request.json()) as Body; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const engineAccountId = typeof body.engine_account_id === "string" ? body.engine_account_id : null;
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : access.workspaceIds[0];
  const connectionId = typeof body.connection_id === "string" ? body.connection_id : null;
  const accountRef = typeof body.account_ref === "string" ? body.account_ref : null;
  if (!engineAccountId || !workspaceId || !connectionId || !accountRef) {
    return NextResponse.json({ error: "Faltan campos: engine_account_id, connection_id, account_ref" }, { status: 400 });
  }
  if (!access.workspaceIds.includes(workspaceId)) return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  {
    const db = createSupabaseReadClient(access.accessToken);
    const { data: conn } = await db.from("ads_google_connections").select("workspace_id").eq("id", connectionId).maybeSingle();
    if (!conn || String(conn.workspace_id) !== workspaceId) {
      return NextResponse.json({ error: "connection_id no pertenece a este workspace" }, { status: 400 });
    }
  }
  try {
    const full = await fetchAccountFull(engineAccountId);
    const opts = (full.ai_plan?.optimizations ?? []) as never[];
    const { actions, skipped } = mapEngineOptimizations(opts, {
      workspaceId, connectionId, accountRef, createdBy: access.email,
    });
    let imported = 0;
    let duplicated = 0;
    for (const a of actions) {
      const row = await createActionDeduped(a as never);
      if (row) imported += 1; else duplicated += 1;
    }
    return NextResponse.json({ imported, duplicated, skipped, total: opts.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 502 });
  }
}
