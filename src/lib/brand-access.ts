// ============================================================================
// Brand membership gate. The ads DB is NOT the tenant boundary — airankia's
// Supabase RLS is. So instead of trusting a brandId from the querystring/body,
// we fetch the brand THROUGH the caller's own access token: RLS
// (workspace_members) returns the row only when the caller belongs to the
// brand's workspace. Null ⇒ no such brand OR no access (indistinguishable on
// purpose — don't leak existence).
// Same pattern as /api/search/runs (the engine routes already do this).
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseReadClient } from "@/lib/supabase-server";

export interface AccessibleBrand {
  id: string;
  workspace_id: string;
}

export async function getAccessibleBrand(
  authClient: SupabaseClient,
  brandId: string | null | undefined
): Promise<AccessibleBrand | null> {
  if (!brandId) return null;
  const {
    data: { session },
  } = await authClient.auth.getSession();
  if (!session?.access_token) return null;
  const readClient = createSupabaseReadClient(session.access_token);
  const { data: brand } = await readClient
    .from("brand_project")
    .select("id, workspace_id")
    .eq("id", brandId)
    .single();
  return (brand as AccessibleBrand | null) ?? null;
}
