// ============================================================================
// Admin gate. Admins are identified by their Supabase session email.
// Built-in admins are ALWAYS allowed (so the owner can never get locked out of
// /admin even if the env var is unset or set to something else); ADMIN_EMAILS
// (comma-separated) in the server env ADDS more emails on top.
// ============================================================================

import { createSupabaseServerClient } from "@/lib/supabase-auth";

// Owner accounts that are always admins, regardless of env config.
const BUILT_IN_ADMINS = ["pedro@spota.mx", "hello@airankia.com"];

export const ADMIN_EMAILS: string[] = [
  ...BUILT_IN_ADMINS,
  ...(process.env.ADMIN_EMAILS ?? "").split(","),
]
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
