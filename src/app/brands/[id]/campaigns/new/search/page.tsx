import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { SearchCampaignCreator } from "./search-campaign-creator";

export default async function NewSearchCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  const {
    data: { session },
  } = await authClient.auth.getSession();
  const accessToken = session?.access_token;

  const supabase = createSupabaseReadClient(accessToken);
  const { data: brand } = await supabase
    .from("brand_project")
    .select("id, name, industry, website, logo_url, workspace_id")
    .eq("id", id)
    .single();

  if (!brand) redirect("/brands");

  return (
    <SearchCampaignCreator
      brandId={brand.id}
      brandName={brand.name}
      brandWebsite={brand.website}
    />
  );
}
