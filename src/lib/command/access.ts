// Access gate for every /api/command/* route and /command page:
// session → COMMAND_CENTER_BETA flag → admin allowlist → workspace ids (RLS).
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { isAdminEmail } from "@/lib/admin";

export interface CommandAccess {
  email: string;
  userId: string;
  accessToken: string | undefined;
  workspaceIds: string[];
}

export function betaEnabled(): boolean {
  return process.env.COMMAND_CENTER_BETA === "true";
}

export async function getCommandAccess(): Promise<CommandAccess | null> {
  if (!betaEnabled()) return null;
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user?.email || !isAdminEmail(user.email)) return null;
  const { data: { session } } = await authClient.auth.getSession();
  const db = createSupabaseReadClient(session?.access_token);
  const { data: memberships } = await db.from("workspace_members").select("workspace_id").eq("user_id", user.id);
  const workspaceIds = (memberships ?? []).map((m) => String(m.workspace_id)).filter(Boolean);
  return { email: user.email, userId: user.id, accessToken: session?.access_token, workspaceIds };
}

export function commandDenied(): NextResponse {
  return NextResponse.json(
    { error: betaEnabled() ? "no autorizado para el Centro de Mando" : "not found" },
    { status: betaEnabled() ? 403 : 404 }
  );
}
