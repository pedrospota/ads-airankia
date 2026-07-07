import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { createBlueprint, listBlueprints } from "@/lib/command/blueprint/repo";

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

  const network = body.network === "google_ads" ? "google_ads" : null;
  const accountRef = typeof body.account_ref === "string" && body.account_ref ? body.account_ref : null;
  if (!network || !accountRef || typeof body.doc !== "object" || body.doc === null) {
    return NextResponse.json({ error: "Faltan campos: network, account_ref, doc" }, { status: 400 });
  }
  const connectionId = typeof body.connection_id === "string" ? body.connection_id : null;

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
