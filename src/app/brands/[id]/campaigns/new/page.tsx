import { redirect } from "next/navigation";

// The display creator used to live at campaigns/new. It now lives at
// campaigns/new/display (sibling of new/search), so old links and bookmarks
// keep working via this thin redirect.
export default async function NewCampaignRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/brands/${id}/campaigns/new/display`);
}
