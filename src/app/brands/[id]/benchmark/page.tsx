import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
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

  return (
    <BenchmarkSuite
      brandId={brand.id}
      brandName={brand.name ?? ""}
      brandWebsite={brand.website ?? null}
      knownCompetitors={competitors}
    />
  );
}
