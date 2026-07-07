// THE SINGLE EXECUTE CHOKEPOINT for the Centro de Mando. No other route may
// trigger network mutations. Two-step: the action must already be approved.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { executeAction } from "@/lib/command/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  try {
    const deps = buildExecutorDeps(access.accessToken);
    const outcome = await executeAction(id, access.email, access.workspaceIds, deps);
    if (!outcome.ok && outcome.blocked) {
      return NextResponse.json({ ok: false, blocked: outcome.blocked }, { status: 409 });
    }
    if (!outcome.ok) {
      return NextResponse.json({ ok: false, error: outcome.error }, { status: 502 });
    }
    return NextResponse.json(outcome);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
