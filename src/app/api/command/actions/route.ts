import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { createAction, listActions } from "@/lib/command/actions-repo";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { CC_ACTION_TYPES, type CcActionType, type CcNetwork } from "@/lib/command/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const status = request.nextUrl.searchParams.get("status") ?? undefined;
  const network = request.nextUrl.searchParams.get("network") ?? undefined;
  try {
    const actions = await listActions(access.workspaceIds, {
      status: status as never, network: network as CcNetwork | undefined,
    });
    return NextResponse.json({ actions });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}

interface CreateBody {
  workspace_id?: unknown; network?: unknown; connection_id?: unknown; account_ref?: unknown;
  entity_kind?: unknown; entity_ref?: unknown; entity_name?: unknown;
  action_type?: unknown; payload?: unknown; rationale?: unknown;
}

export async function POST(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  let body: CreateBody;
  try { body = (await request.json()) as CreateBody; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : access.workspaceIds[0];
  if (!workspaceId || !access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }
  const network = body.network === "meta_ads" ? "meta_ads" : body.network === "google_ads" ? "google_ads" : null;
  const actionType = CC_ACTION_TYPES.includes(body.action_type as CcActionType) ? (body.action_type as CcActionType) : null;
  const entityKind = ["campaign", "ad_group", "adset"].includes(String(body.entity_kind)) ? String(body.entity_kind) : null;
  const accountRef = typeof body.account_ref === "string" && body.account_ref ? body.account_ref : null;
  const entityRef = typeof body.entity_ref === "string" && body.entity_ref ? body.entity_ref : null;
  if (!network || !actionType || !entityKind || !accountRef || !entityRef) {
    return NextResponse.json({ error: "Faltan campos: network, action_type, entity_kind, account_ref, entity_ref" }, { status: 400 });
  }
  if (network === "google_ads" && typeof body.connection_id !== "string") {
    return NextResponse.json({ error: "connection_id es obligatorio para Google Ads" }, { status: 400 });
  }
  if (network === "google_ads" && typeof body.connection_id === "string") {
    const db = createSupabaseReadClient(access.accessToken);
    const { data: conn } = await db.from("ads_google_connections").select("workspace_id").eq("id", body.connection_id).maybeSingle();
    if (!conn || String(conn.workspace_id) !== workspaceId) {
      return NextResponse.json({ error: "connection_id no pertenece a este workspace" }, { status: 400 });
    }
  }
  try {
    const action = await createAction({
      workspaceId, createdBy: access.email, network,
      connectionId: network === "google_ads" ? String(body.connection_id) : null,
      accountRef, entityKind, entityRef,
      entityName: typeof body.entity_name === "string" ? body.entity_name : null,
      actionType, payload: (body.payload ?? {}) as never,
      source: "manual", rationale: typeof body.rationale === "string" ? body.rationale : null,
    });
    return NextResponse.json({ action });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
