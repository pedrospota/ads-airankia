import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getBlueprint, setBlueprintStatus } from "@/lib/command/blueprint/repo";
import { rollbackBlueprint } from "@/lib/command/blueprint/plan-runner";
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
  if (blueprint.status !== "executed" && blueprint.status !== "failed") {
    return NextResponse.json({ error: `No se puede revertir desde estado ${blueprint.status}` }, { status: 409 });
  }

  try {
    await setBlueprintStatus(id, "executing", access.workspaceIds);

    const deps = buildExecutorDeps(access.accessToken);
    const outcome = await rollbackBlueprint(id, access.email, access.workspaceIds, deps, {
      listActionsByBlueprint,
      updateActionResolved,
    });

    if (outcome.ok) {
      await setBlueprintStatus(id, "executed", access.workspaceIds);
      return NextResponse.json(outcome);
    }

    const errorMessage = outcome.error ?? `Fallo al revertir en seq ${outcome.failedSeq ?? "?"}`;
    await setBlueprintStatus(id, "failed", access.workspaceIds, errorMessage);
    return NextResponse.json({ ok: false, failedSeq: outcome.failedSeq, error: outcome.error }, { status: 502 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "error";
    await setBlueprintStatus(id, "failed", access.workspaceIds, message).catch(() => undefined);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
