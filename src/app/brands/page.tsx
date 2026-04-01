import Link from "next/link";
import { redirect } from "next/navigation";
import { getBrands } from "@/lib/queries";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { HeaderWrapper } from "./header-wrapper";

export default async function BrandsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Get the user's access token for RLS-protected queries
  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token;

  // Get all workspaces for this user (workspace_members has RLS)
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
          <p style={{ color: 'rgba(255,255,255,0.4)', marginTop: 8 }}>
            Select a brand to see its AI citation sources and start retargeting.
          </p>
        </div>

        {error && (
          <div style={{ padding: 16, borderRadius: 8, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', color: '#F87171' }}>
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {brands.map((brand) => (
            <Link
              key={brand.id}
              href={`/brands/${brand.id}/citations`}
              className="group p-6 rounded-xl transition-colors"
              style={{ background: '#1C1C23', border: '1px solid #38383F' }}
            >
              <div className="flex items-start gap-4">
                {brand.logo_url ? (
                  <img
                    src={brand.logo_url}
                    alt={brand.name}
                    className="w-12 h-12 rounded-lg object-cover"
                    style={{ background: '#0A0A0E' }}
                  />
                ) : (
                  <div className="w-12 h-12 rounded-lg flex items-center justify-center font-bold text-lg"
                    style={{ background: '#0A0A0E', color: 'rgba(255,255,255,0.3)' }}>
                    {brand.name.charAt(0)}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold truncate" style={{ color: '#fff' }}>
                    {brand.name}
                  </h3>
                  {brand.industry && (
                    <p className="text-sm mt-1 truncate" style={{ color: 'rgba(255,255,255,0.4)' }}>
                      {brand.industry}
                    </p>
                  )}
                  {brand.website && (
                    <p className="text-xs mt-1 truncate" style={{ color: 'rgba(255,255,255,0.25)' }}>
                      {brand.website}
                    </p>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>

        {brands.length === 0 && !error && (
          <div className="text-center py-16" style={{ color: 'rgba(255,255,255,0.4)' }}>
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
