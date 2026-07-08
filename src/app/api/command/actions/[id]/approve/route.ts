import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getAction, transitionAction } from "@/lib/command/actions-repo";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { adapterFor } from "@/lib/command/networks";
import type { CcActionRow } from "@/lib/command/actions-repo";
import type { CcEntityKind, CcNetwork, EntitySnapshot } from "@/lib/command/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  const action = await getAction(id, access.workspaceIds);
  if (!action) return NextResponse.json({ error: "no encontrada" }, { status: 404 });
  if (action.status !== "proposed" && action.status !== "failed") {
    return NextResponse.json({ error: `No se puede aprobar desde estado ${action.status}` }, { status: 409 });
  }
  let expected: Partial<EntitySnapshot> | null = null;
  try {
    const deps = buildExecutorDeps(access.accessToken);
    const auth = await deps.auth.resolve(action as CcActionRow);
    const adapter = adapterFor(action.network as CcNetwork);
    if (adapter.capabilities(auth).read) {
      const snap = await adapter.snapshot(auth, action.accountRef, action.entityKind as CcEntityKind, action.entityRef);
      expected = { status: snap.status, dailyBudgetMicros: snap.dailyBudgetMicros };
      // Free bonus, zero extra API calls (spec §a): the snapshot already carries
      // 30d performance context (Google GAQL / Meta insights). Persist it into
      // the same `expected` baseline for display on the Acciones row. VERIFIED
      // inert to the DRIFT gate, which reads only expected.status/dailyBudgetMicros
      // — see the "DRIFT ignores approve-time metrics context" gates test.
      if (snap.conversions30d !== undefined) expected.conversions30d = snap.conversions30d;
      if (snap.spend30dMicros !== undefined) expected.spend30dMicros = snap.spend30dMicros;
    }
  } catch { /* baseline opcional: DRIFT pasará sin expected */ }
  try {
    await transitionAction(action as CcActionRow, "approved", {
      approvedBy: access.email, approvedAt: new Date(), expected, error: null,
    });
    return NextResponse.json({ ok: true, expected });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 409 });
  }
}
