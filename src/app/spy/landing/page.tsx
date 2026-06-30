import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { hasOpenRouterKey } from "@/lib/llm/settings";
import { LandingClient } from "./landing-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LandingXrayPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  // Best-effort: the AI pass needs an OpenRouter key. Scraping still works
  // without it, but we warn up front so the run isn't a surprise. Never throws.
  let aiConfigured = false;
  try {
    aiConfigured = await hasOpenRouterKey();
  } catch {
    aiConfigured = false;
  }

  return <LandingClient aiConfigured={aiConfigured} />;
}
