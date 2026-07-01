import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { hasSearchApiKey } from "@/lib/benchmark/config";
import { brandCompetitorList } from "@/lib/benchmark/page-fetch";
import { BenchmarkTabs } from "./benchmark-tabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function BenchmarkPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: brandId } = await params;

  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  const {
    data: { session },
  } = await authClient.auth.getSession();
  const supabase = createSupabaseReadClient(session?.access_token);
  const { data: brand } = await supabase
    .from("brand_project")
    .select("id, name, website, competitors, competitor_profiles")
    .eq("id", brandId)
    .single();
  if (!brand) redirect("/brands");

  // Prefer the structured, domain-bearing competitor_profiles (kept current by the
  // main app) over the legacy free-text competitors array.
  const competitors = brandCompetitorList(
    brand.competitor_profiles,
    brand.competitors
  );

  // Whether live competitor-ad spying + keyword-advertiser discovery is even
  // possible (a SearchApi key is configured). The key itself is never sent to
  // the browser — only this boolean — so the UI can show/hide the paid toggle.
  const adSpyAvailable = await hasSearchApiKey();

  return (
    <BenchmarkTabs
      brandId={brand.id}
      brandName={brand.name ?? ""}
      brandWebsite={brand.website ?? null}
      knownCompetitors={competitors}
      adSpyAvailable={adSpyAvailable}
    />
  );
}
