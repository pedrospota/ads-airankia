import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { createBlueprint, listBlueprints } from "@/lib/command/blueprint/repo";
import { metaAccountRefs } from "@/lib/command/networks/meta";
import { createSupabaseReadClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  try {
    const blueprints = await listBlueprints(access.workspaceIds);
    return NextResponse.json({ blueprints });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}

interface CreateBody {
  workspace_id?: unknown;
  network?: unknown;
  account_ref?: unknown;
  connection_id?: unknown;
  doc?: unknown;
}

export async function POST(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  let body: CreateBody;
  try { body = (await request.json()) as CreateBody; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  // Tenant boundary: the repo trusts a caller-supplied workspaceId (same as v1
  // createAction), so THIS route is the boundary — derive workspaceId from the caller's
  // own memberships (access.workspaceIds), never blindly from the body. A body-named
  // workspace outside that set is rejected (403), never silently substituted.
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : access.workspaceIds[0];
  if (!workspaceId || !access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }

  const network = body.network === "google_ads" ? "google_ads" : body.network === "meta_ads" ? "meta_ads" : null;
  const accountRef = typeof body.account_ref === "string" && body.account_ref ? body.account_ref : null;
  if (!network || !accountRef || typeof body.doc !== "object" || body.doc === null) {
    return NextResponse.json({ error: "Faltan campos: network, account_ref, doc" }, { status: 400 });
  }
  // Edit sessions are created ONLY by POST /api/command/edit (server-owned baseline). A doc
  // smuggling a docType through this route would win the docType-first dispatch in repo/preview
  // and route a cross-network row into the wrong compiler — reject it outright (fail-closed).
  if ("docType" in (body.doc as Record<string, unknown>)) {
    return NextResponse.json({ error: "doc inválido: los documentos de edición no se crean por esta ruta" }, { status: 400 });
  }

  if (network === "google_ads" && typeof body.connection_id !== "string") {
    return NextResponse.json({ error: "connection_id es obligatorio para Google Ads" }, { status: 400 });
  }
  let connectionId: string | null = null;
  if (network === "google_ads" && typeof body.connection_id === "string") {
    const db = createSupabaseReadClient(access.accessToken);
    const { data: conn } = await db.from("ads_google_connections").select("workspace_id").eq("id", body.connection_id).maybeSingle();
    if (!conn || String(conn.workspace_id) !== workspaceId) {
      return NextResponse.json({ error: "connection_id no pertenece a este workspace" }, { status: 400 });
    }
    connectionId = body.connection_id;
  }

  // Meta: no per-blueprint OAuth connection (system-user token, workspace-wide — see
  // networks/meta.ts) — connection_id is never required here, connectionId stays null. The
  // account itself is validated against the env allowlist instead, since there is no Supabase
  // ownership row to check against. The token is deliberately NOT required at create time:
  // drafting/previewing a meta blueprint is safe even without credentials — the gate preview
  // shows CAPABILITY as blocked, and the real token is only needed at execute time.
  if (network === "meta_ads" && !metaAccountRefs().includes(accountRef)) {
    return NextResponse.json({ error: "Cuenta de Meta no permitida (META_AD_ACCOUNT_IDS)." }, { status: 400 });
  }

  try {
    const blueprint = await createBlueprint({
      workspaceId,
      createdBy: access.email,
      network,
      accountRef,
      connectionId,
      doc: body.doc,
    });
    return NextResponse.json({ blueprint });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
