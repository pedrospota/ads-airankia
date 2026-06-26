// ============================================================================
// Admin gate. Admins are identified by their Supabase session email.
// Default allow-list: hello@airankia.com. Override / extend via ADMIN_EMAILS
// (comma-separated) in the server env.
// ============================================================================

import { createSupabaseServerClient } from "@/lib/supabase-auth";

export const ADMIN_EMAILS: string[] = (
  process.env.ADMIN_EMAILS ?? "hello@airankia.com"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

/** Returns the signed-in admin user, or null (not signed in OR not an admin). */
export async function getAdminUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return isAdminEmail(user.email) ? user : null;
}
