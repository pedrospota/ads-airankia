import { redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, ErrorCard, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { adapterFor } from "@/lib/command/networks";
import { metaAccountRefs } from "@/lib/command/networks/meta";
import CuentasClient, { type UnifiedAccount } from "./cuentas-client";

// Auth + DB reads (connections) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CuentasPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");

  let error: string | null = null;
  const accounts: UnifiedAccount[] = [];
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
            network: "google_ads",
            accountRef: String(a.customer_id),
            name: (a.descriptive_name as string) ?? String(a.customer_id),
            connectionId: String(c.id),
          });
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Error cargando cuentas";
  }
  const metaCaps = adapterFor("meta_ads").capabilities({});
  for (const ref of metaAccountRefs()) {
    accounts.push({ network: "meta_ads", accountRef: ref, name: ref, connectionId: null });
  }

  return (
    <div>
      <Header
        breadcrumbs={[{ label: "Centro de Mando", href: "/command" }, { label: "Cuentas" }]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Cuentas"
          subtitle="Cuentas operables por red. Selecciona una para explorar campañas y proponer acciones."
        />
        {error ? <ErrorCard message={error} /> : null}
        <CuentasClient accounts={accounts} metaWritable={metaCaps.write} metaReason={metaCaps.reason ?? null} />
      </main>
    </div>
  );
}
