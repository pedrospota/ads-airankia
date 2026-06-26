import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { CampaignChooser } from "./campaign-chooser";

// Entry pre-screen: a single, plain-language question — "¿Qué quieres hacer?" —
// that routes the user to the right campaign creator (Búsqueda vs. Banners)
// without them needing to know the difference up front. Both creators stay
// exactly where they were; this only adds a friendly fork in front of them.
export default async function ChooseCampaignTypePage({
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
    .select("id, name")
    .eq("id", id)
    .single();

  if (!brand) redirect("/brands");

  return <CampaignChooser brandId={brand.id} brandName={brand.name} />;
}
