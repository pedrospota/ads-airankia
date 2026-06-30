import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { dataForSeoConfigured } from "@/lib/spy/dataforseo";
import { KeywordSpendClient } from "./keyword-spend-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function KeywordSpendPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  return <KeywordSpendClient configured={dataForSeoConfigured()} />;
}
