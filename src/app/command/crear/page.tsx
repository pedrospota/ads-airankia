import { redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, ErrorCard, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import BuilderClient from "./builder-client";
import type { CrearAccountOption } from "./builder-types";

// Auth + DB reads (connections) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CrearPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");

  let error: string | null = null;
  const accounts: CrearAccountOption[] = [];
  try {
    const db = createSupabaseReadClient(access.accessToken);
    const { data: connections } = await db
      .from("ads_google_connections")
      .select(
        "id, google_email, ads_connection_accounts(customer_id, descriptive_name, currency, is_manager, enabled)"
      )
      .in("workspace_id", access.workspaceIds);
    for (const c of connections ?? []) {
      for (const a of (c.ads_connection_accounts as Array<Record<string, unknown>>) ?? []) {
        if (a.enabled === true && a.is_manager !== true) {
          accounts.push({
            accountRef: String(a.customer_id),
            name: (a.descriptive_name as string) ?? String(a.customer_id),
            connectionId: String(c.id),
            currency: (a.currency as string | undefined) ?? null,
          });
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Error cargando cuentas";
  }

  return (
    <div>
      <Header
        breadcrumbs={[{ label: "Centro de Mando", href: "/command" }, { label: "Constructor" }]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title={
            <>
              Nueva campaña — <em style={{ fontStyle: "italic", color: UI.accent }}>guiada</em>
            </>
          }
          subtitle="Una pregunta a la vez, en tu idioma. La estructura se arma sola a la izquierda; tu anuncio se previsualiza a la derecha. Nada toca la cuenta hasta que revises y publiques en la siguiente pantalla."
        />
        {error ? <ErrorCard message={error} style={{ marginBottom: 16 }} /> : null}
        <BuilderClient accounts={accounts} />
      </main>
    </div>
  );
}
