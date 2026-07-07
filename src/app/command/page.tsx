import { redirect } from "next/navigation";
import { Header } from "@/components/header";
import {
  PageHeader,
  Card,
  StatCard,
  ErrorCard,
  SectionLabel,
  UI,
} from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { countByStatus } from "@/lib/command/actions-repo";
import { getCcSettings } from "@/lib/command/settings";
import { adapterFor } from "@/lib/command/networks";
import { metaAccountRefs } from "@/lib/command/networks/meta";
import ResumenClient from "./resumen-client";

// Auth + workspace lookups + runtime env (COMMAND_CENTER_BETA) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CommandPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");

  let error: string | null = null;
  let counts: Record<string, number> = {};
  let settings: Awaited<ReturnType<typeof getCcSettings>> | null = null;
  const workspaceId = access.workspaceIds[0] ?? null;
  try {
    counts = await countByStatus(access.workspaceIds);
    if (workspaceId) settings = await getCcSettings(workspaceId);
  } catch (e) {
    error = e instanceof Error ? e.message : "Error cargando el Centro de Mando";
  }
  const metaCaps = adapterFor("meta_ads").capabilities({});

  return (
    <div>
      <Header breadcrumbs={[{ label: "Centro de Mando" }]} />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Centro de Mando"
          subtitle="Beta · ejecución aprobada con compuertas deterministas, bitácora y rollback. Nada se ejecuta sin aprobación humana."
        />

        {error ? <ErrorCard message={error} /> : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
            marginBottom: 24,
          }}
        >
          <StatCard label="Propuestas" value={String(counts.proposed ?? 0)} sub="pendientes de revisión" />
          <StatCard label="Aprobadas" value={String(counts.approved ?? 0)} sub="listas para ejecutar" tone="warn" />
          <StatCard label="Ejecutadas" value={String(counts.executed ?? 0)} sub="con receta de rollback" tone="ok" />
          <StatCard
            label="Fallidas / revertidas"
            value={String((counts.failed ?? 0) + (counts.rolled_back ?? 0))}
            sub="ver bitácora"
            tone={counts.failed ? "danger" : "muted"}
          />
        </div>

        <Card>
          <SectionLabel>Redes</SectionLabel>
          <p style={{ color: UI.muted, margin: "8px 0 0" }}>
            Google Ads: opera sobre cuentas conectadas en Conexiones. · Meta Ads:{" "}
            {metaCaps.write
              ? `listo (${metaAccountRefs().length} cuentas permitidas)`
              : metaCaps.reason ?? "pendiente de credenciales"}
            .
          </p>
        </Card>

        {workspaceId && settings ? (
          <ResumenClient workspaceId={workspaceId} initialSettings={settings} />
        ) : null}
      </main>
    </div>
  );
}
