// Access gate for every /api/command/* route and /command page:
// session → COMMAND_CENTER_BETA flag → role (admin allowlist OR allow-listed
// workspace membership) → workspace ids (RLS). v3.0: the security boundary
// for operator seats lives ENTIRELY in this file — routes keep their
// two-line `if (!access) return commandDenied()` gate and trust
// access.workspaceIds for both reads and writes.
import { cache } from "react";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { isAdminEmail } from "@/lib/admin";

export type CommandRole = "admin" | "operator";

export interface CommandAccess {
  email: string;
  userId: string;
  accessToken: string | undefined;
  role: CommandRole;
  workspaceIds: string[];
}

export function betaEnabled(): boolean {
  return process.env.COMMAND_CENTER_BETA === "true";
}

/**
 * PURE role/scope resolution — the v3.0 security matrix, unit-tested in
 * isolation (access.test.ts). Fail-closed by construction:
 * - admins keep all memberships (allow-list does not apply to them);
 * - operators exist ONLY inside the COMMAND_WORKSPACE_IDS allow-list. Unset
 *   or empty allow-list = zero operator seats (today's admin-only posture).
 *   This is NOT optional hardening: Meta accounts come from global env
 *   (metaAccountRefs()), not per-workspace connections, so ANY operator sees
 *   the SAME Meta accounts as every other workspace. Without the allow-list,
 *   "invite one teammate to one workspace" and "invite one teammate to every
 *   ad account the platform has" would be the same operation.
 * - a non-admin with zero allow-listed memberships gets null, never an
 *   empty-scope operator object.
 */
export function resolveCommandScope(input: {
  isAdmin: boolean;
  membershipWorkspaceIds: string[];
  allowlistRaw: string | undefined;
}): { role: CommandRole; workspaceIds: string[] } | null {
  if (input.isAdmin) return { role: "admin", workspaceIds: input.membershipWorkspaceIds };
  const raw = input.allowlistRaw;
  if (!raw) return null;
  const allow = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  const workspaceIds = input.membershipWorkspaceIds.filter((id) => allow.has(id));
  if (workspaceIds.length === 0) return null;
  return { role: "operator", workspaceIds };
}

// cache(): command layout, AppShell, and the equipo page all need this per
// request — React's per-request memo keeps that at ONE auth+membership round
// trip instead of 2-3. (In route handlers cache() is a harmless pass-through.)
export const getCommandAccess = cache(async (): Promise<CommandAccess | null> => {
  if (!betaEnabled()) return null;
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user?.email) return null;
  const { data: { session } } = await authClient.auth.getSession();
  const db = createSupabaseReadClient(session?.access_token);
  const { data: memberships } = await db.from("workspace_members").select("workspace_id").eq("user_id", user.id);
  const scope = resolveCommandScope({
    isAdmin: isAdminEmail(user.email),
    membershipWorkspaceIds: (memberships ?? []).map((m) => String(m.workspace_id)).filter(Boolean),
    allowlistRaw: process.env.COMMAND_WORKSPACE_IDS,
  });
  if (!scope) return null;
  return { email: user.email, userId: user.id, accessToken: session?.access_token, ...scope };
});

export function commandDenied(): NextResponse {
  return NextResponse.json(
    { error: betaEnabled() ? "no autorizado para el Centro de Mando" : "not found" },
    { status: betaEnabled() ? 403 : 404 }
  );
}

/** Admin-only rung for the few routes above operator: settings POST, equipo. */
export function requireAdmin(access: CommandAccess): NextResponse | null {
  return access.role === "admin" ? null : commandDenied();
}
