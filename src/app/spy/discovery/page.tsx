import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { discoveryConfigured } from "@/lib/spy/discovery";
import { DiscoveryClient } from "./discovery-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DiscoveryPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  return <DiscoveryClient configured={discoveryConfigured()} />;
}
