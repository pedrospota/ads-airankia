import { redirect } from "next/navigation";
import { Header } from "@/components/header";
import {
  PageHeader,
  Card,
  StatCard,
  ErrorCard,
  SectionLabel,
  EmptyState,
  PrimaryButton,
  UI,
} from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { countByStatus, listNovedades, type NovedadesResult } from "@/lib/command/actions-repo";
import { getCcSettings } from "@/lib/command/settings";
import { adapterFor } from "@/lib/command/networks";
import { metaAccountRefs } from "@/lib/command/networks/meta";
import ResumenClient from "./resumen-client";

// Auth + workspace lookups + runtime env (COMMAND_CENTER_BETA) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// es-MX label + deep link for each Novedades category (design spec §c
// "Surface"). Four of the five link straight into the existing Acciones
// status filter (?filter=<status>, read by acciones-client.tsx on mount —
// see resumen "Con deriva"/"Bloqueadas" comments there for why filter=
// executed/approved rather than a bespoke virtual filter: cc_actions has no
// dedicated "drift"/"blocked" status column, so the deep link lands on the
// real status and the row's inline error text / gate panel does the rest).
// "Planes fallidos" is the odd one out — cc_blueprints rows never appear in
// Acciones, so it links straight to the failing blueprint's review screen
// when there's exactly one, or to the bitácora otherwise.
const NOVEDAD_ROWS: Array<{ key: keyof NovedadesResult["counts"]; label: string; filter?: string }> = [
  { key: "planesFallidos", label: "Planes fallidos" },
  { key: "accionesFallidas", label: "Acciones fallidas", filter: "failed" },
  { key: "conDeriva", label: "Con deriva", filter: "executed" },
  { key: "bloqueadas", label: "Bloqueadas por compuertas", filter: "approved" },
  { key: "caducadas", label: "Caducadas", filter: "expired" },
];

function NovedadesCard({ novedades }: { novedades: NovedadesResult }) {
  if (novedades.total === 0) {
    return (
      <Card style={{ marginBottom: 24 }}>
        <SectionLabel>Novedades</SectionLabel>
        <EmptyState title="Sin novedades. Todo verificado y al día." style={{ padding: "32px 0 8px" }} />
      </Card>
    );
  }
  return (
    <Card style={{ marginBottom: 24 }}>
      <SectionLabel>Novedades</SectionLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
          marginTop: 12,
        }}
      >
        {NOVEDAD_ROWS.map(({ key, label, filter }) => {
          const value = novedades.counts[key];
          const href = filter
            ? `/command/acciones?filter=${filter}`
            : novedades.counts.planesFallidos === 1 && novedades.items.planesFallidos[0]
              ? `/command/crear/${novedades.items.planesFallidos[0].id}/revisar`
              : "/command/bitacora";
          return (
            <a
              key={key}
              href={href}
              style={{
                display: "block",
                textDecoration: "none",
                background: UI.surface2,
                border: `1px solid ${value > 0 ? UI.danger : UI.border}`,
                borderRadius: UI.radiusSm,
                padding: "12px 14px",
              }}
            >
              <div
                style={{
                  fontSize: 11, fontWeight: 500, textTransform: "uppercase",
                  letterSpacing: "0.08em", color: UI.muted,
                }}
              >
                {label}
              </div>
              <div
                style={{
                  fontSize: 22, fontWeight: 600, marginTop: 4, fontVariantNumeric: "tabular-nums",
                  color: value > 0 ? UI.danger : UI.text,
                }}
              >
                {value}
              </div>
            </a>
          );
        })}
      </div>
    </Card>
  );
}

export default async function CommandPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");

  let error: string | null = null;
  let counts: Record<string, number> = {};
  let settings: Awaited<ReturnType<typeof getCcSettings>> | null = null;
  let novedades: NovedadesResult | null = null;
  const workspaceId = access.workspaceIds[0] ?? null;
  try {
    counts = await countByStatus(access.workspaceIds);
    if (workspaceId) settings = await getCcSettings(workspaceId);
    novedades = await listNovedades(access.workspaceIds);
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

        {novedades ? <NovedadesCard novedades={novedades} /> : null}

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

        <Card style={{ marginTop: 24 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div>
              <SectionLabel>Nueva campaña Meta — beta</SectionLabel>
              <p style={{ color: UI.muted, margin: 0, fontSize: 13.5, maxWidth: 520 }}>
                Un formulario, una campaña de Meta Ads (campaña → conjunto de anuncios → anuncio). Nace en pausa;
                revisas y publicas en la siguiente pantalla.
              </p>
            </div>
            <PrimaryButton href="/command/crear-meta">Crear campaña Meta</PrimaryButton>
          </div>
        </Card>

        {workspaceId && settings ? (
          <ResumenClient
            workspaceId={workspaceId}
            initialSettings={settings}
            isAdmin={access.role === "admin"}
          />
        ) : null}
      </main>
    </div>
  );
}
