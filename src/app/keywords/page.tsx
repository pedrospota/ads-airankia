import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { PageHeader, UI } from "@/components/ui-kit";
import { KeywordsClient } from "./keywords-client";

// Runtime env (planner credential) + auth per request — never prerender.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function KeywordsPage() {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div>
      <Header breadcrumbs={[{ label: "Keywords" }]} />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="PPC Keyword Tool"
          subtitle="Investiga volúmenes, competencia y CPCs — y llévalos directo a una campaña"
        />
        <KeywordsClient />
      </main>
    </div>
  );
}
