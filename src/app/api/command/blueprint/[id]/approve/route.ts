import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { approveBlueprint, compileBlueprintToActions, getBlueprint } from "@/lib/command/blueprint/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;

  const blueprint = await getBlueprint(id, access.workspaceIds);
  if (!blueprint) return NextResponse.json({ error: "no encontrado" }, { status: 404 });
  // Approve gate: never re-approve a blueprint that has already moved past 'draft' —
  // once it's approved/executing/executed/failed its actions may already be approved or
  // live, so a second approve here would be a no-op at best and a footgun at worst.
  if (blueprint.status !== "draft") {
    return NextResponse.json({ error: `No se puede aprobar desde estado ${blueprint.status}` }, { status: 409 });
  }

  try {
    await compileBlueprintToActions(id, access.workspaceIds);
    const approved = await approveBlueprint(id, access.email, access.workspaceIds);
    if (!approved) return NextResponse.json({ error: "no encontrado" }, { status: 404 });
    return NextResponse.json({ ok: true, blueprint: approved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
