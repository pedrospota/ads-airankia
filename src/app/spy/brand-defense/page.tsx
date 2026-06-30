import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { oxylabsConfigured } from "@/lib/spy/brand-defense";
import { BrandDefenseClient } from "./brand-defense-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function BrandDefensePage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  return <BrandDefenseClient configured={oxylabsConfigured()} />;
}
