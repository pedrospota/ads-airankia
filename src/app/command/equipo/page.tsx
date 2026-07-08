import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import EquipoClient from "./equipo-client";

// Auth + workspace lookups — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function EquipoPage() {
  const access = await getCommandAccess();
  // Admin-only page: operators 404 (stealth, same posture as the layout gate).
  if (!access || access.role !== "admin") notFound();

  return (
    <div>
      <Header
        breadcrumbs={[
          { label: "Centro de Mando", href: "/command" },
          { label: "Equipo" },
        ]}
      />
      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Equipo del Centro de Mando"
          subtitle="Invita operadores por workspace. Un operador propone, aprueba y ejecuta dentro de sus workspaces — nunca ve /admin ni los ajustes. Los administradores de plataforma se gestionan por variables de entorno (ADMIN_EMAILS), no aquí."
        />
        <EquipoClient workspaceIds={access.workspaceIds} />
      </main>
    </div>
  );
}
