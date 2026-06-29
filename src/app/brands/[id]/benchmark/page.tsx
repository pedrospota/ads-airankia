import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { hasSearchApiKey } from "@/lib/benchmark/config";
import { BenchmarkSuite } from "./benchmark-suite";

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
    .select("id, name, website, competitors")
    .eq("id", brandId)
    .single();
  if (!brand) redirect("/brands");

  const competitors = Array.isArray(brand.competitors)
    ? brand.competitors
        .map((c: unknown) => (typeof c === "string" ? c.trim() : ""))
        .filter(Boolean)
    : [];

  // Whether live competitor-ad spying + keyword-advertiser discovery is even
  // possible (a SearchApi key is configured). The key itself is never sent to
  // the browser — only this boolean — so the UI can show/hide the paid toggle.
  const adSpyAvailable = await hasSearchApiKey();

  return (
    <BenchmarkSuite
      brandId={brand.id}
      brandName={brand.name ?? ""}
      brandWebsite={brand.website ?? null}
      knownCompetitors={competitors}
      adSpyAvailable={adSpyAvailable}
    />
  );
}
