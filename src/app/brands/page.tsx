import { redirect } from "next/navigation";
import { getBrands } from "@/lib/queries";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { HeaderWrapper } from "./header-wrapper";
import { BrandsGrid } from "./brands-grid";

export default async function BrandsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token;

  const airankia = (await import("@/lib/supabase-server")).createSupabaseReadClient(accessToken);
  const { data: memberships } = await airankia
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id);

  const workspaceIds = memberships?.map((m) => m.workspace_id) ?? [];

  let brands: Awaited<ReturnType<typeof getBrands>> = [];
  let error: string | null = null;

  if (workspaceIds.length === 0) {
    error = "No workspace found for your account. Please set up a workspace in AI Rankia first.";
  } else {
    try {
      brands = await getBrands(workspaceIds, accessToken);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load brands";
    }
  }

  return (
    <div className="min-h-screen">
      <HeaderWrapper />

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Your Brands</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Select a brand to see its AI citation sources and start retargeting.
          </p>
        </div>

        {error && (
          <div style={{ padding: 16, borderRadius: 8, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', color: '#F87171' }}>
            {error}
          </div>
        )}

        <BrandsGrid brands={brands} />

        {brands.length === 0 && !error && (
          <div className="text-center py-16" style={{ opacity: 0.4 }}>
            <p className="text-lg">No brands found for this workspace.</p>
            <p className="text-sm mt-2">
              Add brands in AI Rankia to start citation retargeting.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
