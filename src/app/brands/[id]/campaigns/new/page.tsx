import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { getCitationsForBrand } from "@/lib/queries";
import { CampaignCreator } from "./campaign-creator";

export default async function NewCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: brandId } = await params;

  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  const { data: { session } } = await authClient.auth.getSession();
  const accessToken = session?.access_token;

  const supabase = createSupabaseReadClient(accessToken);
  const { data: brand } = await supabase
    .from("brand_project")
    .select("id, name, industry, website, logo_url, workspace_id")
    .eq("id", brandId)
    .single();

  if (!brand) redirect("/brands");

  let citations: Awaited<ReturnType<typeof getCitationsForBrand>> = [];
  try {
    citations = await getCitationsForBrand(brandId, accessToken);
  } catch {}

  return <CampaignCreator brand={brand} citations={citations} />;
}
