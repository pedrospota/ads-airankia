// v3.0 — team management (spec §d): list / invite / remove workspace members.
// ADMIN-ONLY: this is the single route allowed to touch the service-role
// client. The invite writes a plain workspace_members row with the LEGACY
// role 'member' (satisfies the table's CHECK role IN ('owner','member'));
// that value carries ZERO Command-permission meaning — Command access is
// decided entirely by access.ts (membership ∩ COMMAND_WORKSPACE_IDS), and
// platform-admin is decided entirely by isAdminEmail. Nothing this route can
// write escalates anyone to admin.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied, requireAdmin } from "@/lib/command/access";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import { isAdminEmail } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_SERVICE_KEY = NextResponse.json(
  { error: "Falta configurar SUPABASE_SERVICE_ROLE_KEY en el servidor." },
  { status: 501 }
);

async function requireAdminAndClient() {
  const access = await getCommandAccess();
  if (!access) return { error: commandDenied() } as const;
  const denied = requireAdmin(access);
  if (denied) return { error: denied } as const;
  const admin = createSupabaseAdminClient();
  if (!admin) return { error: NO_SERVICE_KEY } as const;
  return { access, admin } as const;
}

export async function GET(request: NextRequest) {
  const ctx = await requireAdminAndClient();
  if ("error" in ctx) return ctx.error;
  const workspaceId = request.nextUrl.searchParams.get("workspaceId") ?? ctx.access.workspaceIds[0];
  if (!workspaceId || !ctx.access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }
  // NOTE: invited_by is NOT selected here — no evidence anywhere in the repo
  // (grep across src/) that workspace_members has this column, so it is
  // dropped rather than guessed (an unknown-column select fails at runtime).
  const { data: rows, error } = await ctx.admin
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // N+1 email resolution — fine at beta scale (single digits). A failed
  // lookup degrades to a partial row, never a 500 (spec §g risk 7).
  const members = await Promise.all(
    (rows ?? []).map(async (r) => {
      let email: string | null = null;
      try {
        const { data } = await ctx.admin.auth.admin.getUserById(String(r.user_id));
        email = data.user?.email ?? null;
      } catch { /* stale auth user — keep the row, drop the email */ }
      return { userId: String(r.user_id), email, role: String(r.role), invitedBy: null };
    })
  );
  return NextResponse.json({ workspaceId, members });
}

export async function POST(request: NextRequest) {
  const ctx = await requireAdminAndClient();
  if ("error" in ctx) return ctx.error;
  let body: { email?: unknown; workspaceId?: unknown };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (!email || !email.includes("@") || !workspaceId) {
    return NextResponse.json({ error: "Faltan campos: email, workspaceId" }, { status: 400 });
  }
  if (!ctx.access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }

  // 1) Invite (sends Supabase's built-in email) — or find the existing user.
  let userId: string | null = null;
  let invited = false;
  const origin = request.nextUrl.origin;
  const { data: inviteData, error: inviteError } = await ctx.admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/auth/callback`,
  });
  if (!inviteError && inviteData.user) {
    userId = inviteData.user.id;
    invited = true;
  } else {
    // Already registered (or invite disabled) → locate by email. listUsers is
    // acceptable at beta scale; page through defensively anyway.
    for (let page = 1; page <= 10 && !userId; page++) {
      const { data, error } = await ctx.admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      userId = data.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
      if (data.users.length < 200) break;
    }
    if (!userId) {
      return NextResponse.json(
        { error: `No se pudo invitar a ${email}: ${inviteError?.message ?? "usuario no encontrado"}` },
        { status: 500 }
      );
    }
  }

  // 2) Membership row — SELECT-then-INSERT (a unique(workspace_id,user_id)
  // constraint is NOT confirmed on this table, so upsert/onConflict is
  // unsafe to assume; spec §d). invited_by is NOT written — no evidence
  // anywhere in the repo that this column exists (see GET note above).
  const { data: existing } = await ctx.admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!existing) {
    const { error: insertError } = await ctx.admin.from("workspace_members").insert({
      workspace_id: workspaceId,
      user_id: userId,
      role: "member", // legacy main-app value; carries no Command meaning (see header)
    });
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
  }
  return NextResponse.json({ member: { userId, email, role: "member" }, invited });
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireAdminAndClient();
  if ("error" in ctx) return ctx.error;
  let body: { workspaceId?: unknown; userId?: unknown };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!workspaceId || !userId) {
    return NextResponse.json({ error: "Faltan campos: workspaceId, userId" }, { status: 400 });
  }
  if (!ctx.access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }
  // UX guard (not a security boundary — admins aren't membership-gated):
  // removing an admin's row would be a confusing no-op, so refuse it.
  try {
    const { data } = await ctx.admin.auth.admin.getUserById(userId);
    if (data.user?.email && isAdminEmail(data.user.email)) {
      return NextResponse.json(
        { error: "Los administradores de plataforma no se gestionan aquí (ADMIN_EMAILS)." },
        { status: 400 }
      );
    }
  } catch { /* stale user — allow the row removal */ }
  const { error } = await ctx.admin
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ removed: true });
}
