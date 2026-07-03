import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchBrandDomains } from "@/lib/sentinel";
import { PageHeader, Card, SectionLabel, ErrorCard, UI } from "@/components/ui-kit";
import { DomainsManager, type DomainRow } from "./domains-manager";

// Per-request data (cache: "no-store") + runtime env vars — never prerender.
export const dynamic = "force-dynamic";

export default async function BrandDomainsPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let rows: DomainRow[] = [];
  let error: string | null = null;

  try {
    const data = await fetchBrandDomains();
    rows = data.rows ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar la lista de dominios.";
  }

  return (
    <div>
      <Header
        breadcrumbs={[{ label: "Seguridad", href: "/security" }, { label: "Dominios" }]}
      />

      <main style={{ marginTop: 24 }}>
        <PageHeader
          title="Dominios de marca"
          subtitle="La allowlist anti-hijack: los dominios que el monitor considera legítimos como destino de tus anuncios."
        />

        {/* Explicador del anti-hijack */}
        <Card style={{ marginBottom: 24 }}>
          <SectionLabel style={{ marginBottom: 8 }}>Cómo funciona</SectionLabel>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: UI.muted, margin: 0 }}>
            El monitor revisa la URL final de los anuncios de tus cuentas. Si un
            anuncio apunta a un dominio que <span style={{ color: UI.text }}>no</span>{" "}
            está en esta lista, se genera una alerta de posible{" "}
            <span style={{ color: UI.text }}>hijack</span> — un cambio de destino no
            autorizado (afiliados, malware, o un editor equivocado). Agrega aquí todos
            los dominios legítimos de tus marcas, incluidos los de tracking y landings
            alternas, para que las alertas señalen solo lo que de verdad importa.
          </p>
        </Card>

        {error ? (
          <ErrorCard message={`No pudimos cargar la lista de dominios. ${error}`} />
        ) : (
          <DomainsManager initialRows={rows} />
        )}
      </main>
    </div>
  );
}
