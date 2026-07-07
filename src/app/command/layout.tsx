import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { isAdminEmail } from "@/lib/admin";

// Centro de Mando (beta): stealth gate. Unless COMMAND_CENTER_BETA is on AND
// the signed-in user is an admin, the whole /command subtree 404s — same
// posture as AppShell's own (separate) check that hides the sidebar nav
// group. This is the one that actually blocks the route.
export const dynamic = "force-dynamic";

export default async function CommandLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (process.env.COMMAND_CENTER_BETA !== "true") notFound();
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user?.email || !isAdminEmail(user.email)) notFound();
  return <AppShell>{children}</AppShell>;
}
