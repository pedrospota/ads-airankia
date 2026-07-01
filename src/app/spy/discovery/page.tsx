import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { oxylabsConfigured } from "@/lib/benchmark/oxylabs";
import { DiscoveryClient } from "./discovery-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DiscoveryPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  // Paid discovery scrapes live Google Ads via Oxylabs — that's the primitive
  // that must be configured (DataForSEO is only an optional keyword-seed source).
  return <DiscoveryClient configured={oxylabsConfigured()} />;
}
