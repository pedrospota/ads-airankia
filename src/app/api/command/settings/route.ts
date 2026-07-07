import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getCcSettings, saveCcSettings } from "@/lib/command/settings";
import { CC_SETTINGS_ACTION_TYPES, type CcActionType, type CcCreateActionType } from "@/lib/command/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const workspaceId = request.nextUrl.searchParams.get("workspace") ?? access.workspaceIds[0];
  if (!workspaceId || !access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }
  return NextResponse.json({ workspaceId, settings: await getCcSettings(workspaceId) });
}

export async function POST(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : access.workspaceIds[0];
  if (!workspaceId || !access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }
  const patch: Record<string, unknown> = {};
  if (typeof body.executions_paused === "boolean") patch.executionsPaused = body.executions_paused;
  if (typeof body.max_budget_delta_pct === "number") patch.maxBudgetDeltaPct = Math.max(1, Math.min(100, body.max_budget_delta_pct));
  if (typeof body.max_actions_per_account_day === "number") patch.maxActionsPerAccountDay = Math.max(1, Math.min(200, body.max_actions_per_account_day));
  if (Array.isArray(body.allowed_action_types)) {
    patch.allowedActionTypes = body.allowed_action_types.filter(
      (t): t is CcActionType | CcCreateActionType => CC_SETTINGS_ACTION_TYPES.includes(t as CcActionType | CcCreateActionType)
    );
  }
  try {
    const settings = await saveCcSettings(workspaceId, patch, access.email);
    return NextResponse.json({ workspaceId, settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
