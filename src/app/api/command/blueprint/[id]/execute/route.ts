import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getBlueprint, setBlueprintStatus } from "@/lib/command/blueprint/repo";
import { executeBlueprint } from "@/lib/command/blueprint/plan-runner";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { listActionsByBlueprint, updateActionResolved } from "@/lib/command/actions-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;

  const blueprint = await getBlueprint(id, access.workspaceIds);
  if (!blueprint) return NextResponse.json({ error: "no encontrado" }, { status: 404 });
  if (blueprint.status !== "approved") {
    return NextResponse.json({ error: `No se puede ejecutar desde estado ${blueprint.status}` }, { status: 409 });
  }

  try {
    await setBlueprintStatus(id, "executing", access.workspaceIds);

    const deps = buildExecutorDeps(access.accessToken);
    const outcome = await executeBlueprint(id, access.email, access.workspaceIds, deps, {
      listActionsByBlueprint,
      updateActionResolved,
    });

    if (outcome.ok) {
      await setBlueprintStatus(id, "executed", access.workspaceIds);
      return NextResponse.json(outcome);
    }

    // executeAction (the single-action chokepoint) only leaves `error` undefined when a
    // blocking gate stopped it (it sets `blocked` on that ExecOutcome instead); every other
    // failure path stamps a message. The plan runner's PlanOutcome doesn't pass the
    // GateResult[] array itself through, but a blocked action is left in 'approved' status
    // with its gateResults persisted on the row by executeAction's own transitionAction
    // call — recover the blocked detail from there, best-effort, for the 409 response.
    const isBlocked = outcome.error === undefined;
    let blocked: unknown;
    if (isBlocked && typeof outcome.failedSeq === "number") {
      const actions = await listActionsByBlueprint(id);
      const stalled = actions.find((a) => a.seq === outcome.failedSeq);
      if (stalled?.gateResults) blocked = stalled.gateResults;
    }

    const errorMessage = outcome.error ?? `Bloqueado en seq ${outcome.failedSeq ?? "?"}`;
    await setBlueprintStatus(id, "failed", access.workspaceIds, errorMessage);

    if (isBlocked) {
      return NextResponse.json({ ok: false, failedSeq: outcome.failedSeq, blocked }, { status: 409 });
    }
    return NextResponse.json({ ok: false, failedSeq: outcome.failedSeq, error: outcome.error }, { status: 502 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "error";
    await setBlueprintStatus(id, "failed", access.workspaceIds, message).catch(() => undefined);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
