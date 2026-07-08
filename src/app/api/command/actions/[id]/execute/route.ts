// THE SINGLE EXECUTE CHOKEPOINT for the Centro de Mando. No other route may
// trigger network mutations. Two-step: the action must already be approved.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { executeAction } from "@/lib/command/executor";
import { getAction, transitionAction } from "@/lib/command/actions-repo";
import { CC_APPROVAL_TTL_HOURS } from "@/lib/command/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CADUCADA_MSG = "Aprobación caducada (>72h): vuelve a aprobar";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  try {
    // Execute-time expiry backstop (design spec §c — closes the lazy-sweep
    // timing hole): the sweep only expires stale 'approved' rows when a page
    // is visited, so a row can sit approved well past the TTL if nobody has
    // loaded /command since. This route is the sole executeAction caller, so
    // checking here guarantees no execute ever fires on a caducada approval
    // regardless of sweep timing. executeAction/gates/state stay untouched.
    const row = await getAction(id, access.workspaceIds);
    if (row && row.status === "approved" && row.approvedAt) {
      const ageMs = Date.now() - row.approvedAt.getTime();
      if (ageMs > CC_APPROVAL_TTL_HOURS * 60 * 60 * 1000) {
        await transitionAction(row, "expired", { error: CADUCADA_MSG });
        return NextResponse.json({ error: CADUCADA_MSG }, { status: 409 });
      }
    }
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
