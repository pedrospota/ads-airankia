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

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">{name}</h1>
          <p className="mt-2 text-sm" style={{ opacity: 0.4 }}>
            Optimizador de Google Ads — modo propuesta, nada se ejecuta
            {data?.analyzed_at ? <> · analizado {fmtWhen(data.analyzed_at)}</> : null}
          </p>
        </div>

        {error || !data ? (
          <div
            style={{
              padding: 16,
              borderRadius: 8,
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.2)",
              color: "#F87171",
            }}
          >
            No pudimos cargar los datos de esta cuenta.{" "}
            {error ?? "Inténtalo de nuevo en unos minutos."}
          </div>
        ) : (
          <AccountTabs data={data} accountId={id} userEmail={user.email ?? ""} />
        )}
      </main>
    </div>
  );
}
