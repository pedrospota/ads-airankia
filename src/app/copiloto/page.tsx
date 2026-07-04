import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { CopilotoClient } from "./copiloto-client";

// Auth is cookie-based per-request, so never prerender this page.
export const dynamic = "force-dynamic";

export default async function CopilotoPage() {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen">
      <Header breadcrumbs={[{ label: "Copiloto" }]} />
      <CopilotoClient />
    </div>
  );
}
