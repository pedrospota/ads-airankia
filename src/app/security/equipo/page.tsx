import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchOptimizers, fmtNum } from "@/lib/sentinel";
import {
  PageHeader,
  Card,
  StatCard,
  DataTable,
  THead,
  Row,
  Cell,
  Badge,
  EmptyState,
  ErrorCard,
  UI,
} from "@/components/ui-kit";

// Per-request data (cache: "no-store") + runtime env vars — never prerender.
export const dynamic = "force-dynamic";

// The engine only accepts these windows (anything else falls back to 14).
const DAY_OPTIONS = [7, 14, 30] as const;

interface OptimizerRow {
  person?: string;
  account_id?: string;
  account_name?: string;
  n_changes?: number;
  types?: Record<string, number>;
}

function DaysSwitcher({ days }: { days: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {DAY_OPTIONS.map((d) => {
        const active = d === days;
        return (
          <Link
            key={d}
            href={`/security/equipo?days=${d}`}
            aria-current={active ? "page" : undefined}
            style={{
              padding: "5px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 500,
              whiteSpace: "nowrap",
              textDecoration: "none",
              color: active ? UI.text : UI.muted,
              background: active ? UI.surface2 : "transparent",
              border: `1px solid ${active ? UI.border : "transparent"}`,
            }}
          >
            {d} días
          </Link>
        );
      })}
    </div>
  );
}

/** "campaign×3, ad_group_criterion×12" as quiet pills, biggest first. */
function TypeChips({ types }: { types: Record<string, number> | null | undefined }) {
  const entries = Object.entries(types ?? {}).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (entries.length === 0) return <span style={{ color: UI.faint }}>—</span>;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {entries.map(([type, count]) => (
        <Badge key={type} tone="muted">
          {type}×{fmtNum(count)}
        </Badge>
      ))}
    </span>
  );
}

export default async function SecurityTeamPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const rawDays = Number(Array.isArray(sp.days) ? sp.days[0] : sp.days);
  const days = (DAY_OPTIONS as readonly number[]).includes(rawDays) ? rawDays : 14;

  let rows: OptimizerRow[] = [];
  let error: string | null = null;

  try {
    const data = await fetchOptimizers(days);
    rows = data.rows ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar la actividad del equipo.";
  }

  const sorted = [...rows].sort((a, b) => (b.n_changes ?? 0) - (a.n_changes ?? 0));
  const nPersonas = new Set(sorted.map((r) => r.person || "(desconocido)")).size;
  const nCuentas = new Set(sorted.map((r) => r.account_id || r.account_name || "?")).size;
  const nCambios = sorted.reduce((s, r) => s + (r.n_changes ?? 0), 0);

  return (
    <div>
      <Header
        breadcrumbs={[{ label: "Seguridad", href: "/security" }, { label: "Equipo" }]}
      />

      <main style={{ marginTop: 24 }}>
        <PageHeader
          title="Equipo"
          subtitle={`Cambios atribuidos por persona en Google Ads — últimos ${days} días.`}
          actions={<DaysSwitcher days={days} />}
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar la actividad del equipo. ${error}`} />
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 16,
                marginBottom: 32,
              }}
            >
              <StatCard label="Personas activas" value={fmtNum(nPersonas)} />
              <StatCard label="Cuentas tocadas" value={fmtNum(nCuentas)} />
              <StatCard label="Cambios totales" value={fmtNum(nCambios)} />
            </div>

            {sorted.length === 0 ? (
              <Card style={{ padding: 0 }}>
                <EmptyState
                  title={`Sin cambios atribuidos en los últimos ${days} días`}
                  hint="La actividad del equipo aparecerá aquí cuando el colector detecte cambios en Google Ads."
                />
              </Card>
            ) : (
              <Card style={{ padding: 0 }}>
                <DataTable>
                  <THead
                    cols={[
                      { label: "Persona" },
                      { label: "Cuenta" },
                      { label: "Cambios", align: "right", width: 110 },
                      { label: "Desglose" },
                    ]}
                  />
                  <tbody>
                    {sorted.map((r, i) => (
                      <Row key={`${r.person ?? "?"}-${r.account_id ?? i}`}>
                        <Cell style={{ fontWeight: 500, whiteSpace: "nowrap" }}>
                          {r.person || "(desconocido)"}
                        </Cell>
                        <Cell style={{ color: UI.muted }}>
                          {r.account_name || r.account_id || "—"}
                        </Cell>
                        <Cell align="right" mono>
                          {fmtNum(r.n_changes)}
                        </Cell>
                        <Cell>
                          <TypeChips types={r.types} />
                        </Cell>
                      </Row>
                    ))}
                  </tbody>
                </DataTable>
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  );
}
