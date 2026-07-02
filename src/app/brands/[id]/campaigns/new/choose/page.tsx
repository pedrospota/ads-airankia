import { redirect } from "next/navigation";

// The old "choose a campaign type" pre-screen was replaced by the campaigns
// hub, which shows the same two options (Search vs Display) above the
// dashboard. Old links (e.g. from the citations screen) land here, so keep a
// thin redirect to the hub instead of a 404.
export default async function ChooseCampaignTypeRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/brands/${id}/campaigns`);
}
