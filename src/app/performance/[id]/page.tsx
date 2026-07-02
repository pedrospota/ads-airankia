// ============================================================================
// /performance/[id] — the FULL native account view of the optimizer, mirroring
// the Python engine's seven-tab account page (Resumen · Acciones · Segmentos ·
// Calidad · Auditoría · Estrategia · Análisis · Reglas).
//
// Server component: auth gate + one fetchAccountFull() call (the engine's raw
// payloads), then everything renders client-side in <AccountTabs/>. All fields
// can be null — the client renders defensively with Spanish empty states.
// ============================================================================

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchAccountFull, fmtWhen, type AccountFull } from "@/lib/sentinel";
import { PageHeader, ErrorCard, UI } from "@/components/ui-kit";
import { AccountTabs } from "./account-tabs";

// Per-request data (cache: "no-store") + runtime env vars — never prerender.
export const dynamic = "force-dynamic";

export default async function PerformanceAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let data: AccountFull | null = null;
  let error: string | null = null;

  try {
    data = await fetchAccountFull(id);
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar la cuenta.";
  }

  const name = data?.name || data?.account_id || id;

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[{ label: "Performance", href: "/performance" }, { label: name }]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title={name}
          subtitle={
            <>
              Optimizador de Google Ads — modo propuesta, nada se ejecuta
              {data?.analyzed_at ? <> · analizado {fmtWhen(data.analyzed_at)}</> : null}
            </>
          }
        />

        {error || !data ? (
          <ErrorCard
            message={
              <>
                No pudimos cargar los datos de esta cuenta.{" "}
                {error ?? "Inténtalo de nuevo en unos minutos."}
              </>
            }
          />
        ) : (
          <AccountTabs data={data} accountId={id} userEmail={user.email ?? ""} />
        )}
      </main>
    </div>
  );
}
