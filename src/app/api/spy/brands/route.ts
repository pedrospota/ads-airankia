import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { brandCompetitorList } from "@/lib/benchmark/page-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/spy/brands
// The brand list that powers the Ad Spy brand picker. MIRRORS the auth + data
// loading used by the brands page + the benchmark page: user → workspaces →
// brand_project rows scoped to those workspaces. Competitors are derived the
// same way the benchmark does (structured competitor_profiles preferred over the
// legacy free-text competitors array). Only id/name/website/competitors leak —
// nothing else.
export async function GET() {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to load your brands." }, { status: 401 });
  }

  const {
    data: { session },
  } = await authClient.auth.getSession();
  const supabase = createSupabaseReadClient(session?.access_token);

  try {
    const { data: memberships } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id);

    const workspaceIds = (memberships ?? []).map((m) => m.workspace_id);
    if (workspaceIds.length === 0) return NextResponse.json({ brands: [] });

    const { data: rows } = await supabase
      .from("brand_project")
      .select("id, name, website, competitors, competitor_profiles")
      .in("workspace_id", workspaceIds)
      .order("name");

    const brands = (rows ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      website: b.website ?? null,
      competitors: brandCompetitorList(b.competitor_profiles, b.competitors),
    }));

    return NextResponse.json({ brands });
  } catch (e) {
    // Soft-fail so the picker just shows no brands instead of breaking the page.
    return NextResponse.json({
      brands: [],
      error: e instanceof Error ? e.message : "Could not load brands.",
    });
  }
}
