import { getCitationsForBrand, isGdnAvailable } from "@/lib/queries";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { CitationsClient } from "./citations-client";

export default async function CitationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: brandId } = await params;

  const supabase = createSupabaseReadClient();
  const { data: brand } = await supabase
    .from("brand_project")
    .select("id, name, industry, website, logo_url")
    .eq("id", brandId)
    .single();

  if (!brand) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-zinc-500">Brand not found</p>
      </div>
    );
  }

  let citations: Awaited<ReturnType<typeof getCitationsForBrand>> = [];
  let error: string | null = null;

  try {
    citations = await getCitationsForBrand(brandId);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load citations";
  }

  const citationsWithGdn = citations.map((c) => ({
    ...c,
    gdn_available: isGdnAvailable(c.domain),
  }));

  return (
    <CitationsClient
      brand={brand}
      citations={citationsWithGdn}
      error={error}
    />
  );
}
