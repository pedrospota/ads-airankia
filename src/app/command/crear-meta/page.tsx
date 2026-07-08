import { redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, Card, EmptyState, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { metaAccountRefs } from "@/lib/command/networks/meta";
import MetaFormClient from "./meta-form-client";

// Auth gate only (metaAccountRefs() reads env, no DB) — never prerender, mirrors crear/page.tsx.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CrearMetaPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");

  const accounts = metaAccountRefs();

  return (
    <div>
      <Header
        breadcrumbs={[{ label: "Centro de Mando", href: "/command" }, { label: "Crear (Meta)" }]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title={
            <>
              Nueva campaña — <em style={{ fontStyle: "italic", color: UI.accent }}>Meta</em>
            </>
          }
          subtitle="Un formulario, una campaña completa: campaña, conjunto de anuncios y anuncio(s). Nace en pausa — nada toca la cuenta hasta que revises y publiques en la siguiente pantalla."
        />

        {accounts.length === 0 ? (
          <Card>
            <EmptyState
              title="Meta Ads — pendiente de credenciales"
              hint="Configura META_AD_ACCOUNT_IDS en el servidor para habilitar cuentas de Meta aquí (además de META_SYSTEM_USER_TOKEN, META_APP_SECRET y META_PAGE_ID, requeridos para poder crear campañas)."
            />
          </Card>
        ) : (
          <MetaFormClient accounts={accounts} />
        )}
      </main>
    </div>
  );
}
