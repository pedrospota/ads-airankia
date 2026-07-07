import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getAction, transitionAction } from "@/lib/command/actions-repo";
import type { CcActionRow } from "@/lib/command/actions-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  const action = await getAction(id, access.workspaceIds);
  if (!action) return NextResponse.json({ error: "no encontrada" }, { status: 404 });
  try {
    await transitionAction(action as CcActionRow, "rejected", {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 409 });
  }
}
