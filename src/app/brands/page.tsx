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

  // Get all workspaces for this user
  const { data: memberships } = await supabase
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
      brands = await getBrands(workspaceIds);
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
          <p className="text-zinc-500 dark:text-zinc-400 mt-2">
            Select a brand to see its AI citation sources and start retargeting.
          </p>
        </div>

        {error && (
          <div className="p-4 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {brands.map((brand) => (
            <Link
              key={brand.id}
              href={`/brands/${brand.id}/citations`}
              className="group p-6 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:border-emerald-500/50 transition-colors shadow-sm hover:shadow-md dark:shadow-none"
            >
              <div className="flex items-start gap-4">
                {brand.logo_url ? (
                  <img
                    src={brand.logo_url}
                    alt={brand.name}
                    className="w-12 h-12 rounded-lg object-cover bg-zinc-100 dark:bg-zinc-800"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500 font-bold text-lg">
                    {brand.name.charAt(0)}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors truncate">
                    {brand.name}
                  </h3>
                  {brand.industry && (
                    <p className="text-sm text-zinc-500 mt-1 truncate">
                      {brand.industry}
                    </p>
                  )}
                  {brand.website && (
                    <p className="text-xs text-zinc-400 dark:text-zinc-600 mt-1 truncate">
                      {brand.website}
                    </p>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>

        {brands.length === 0 && !error && (
          <div className="text-center py-16 text-zinc-500">
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
