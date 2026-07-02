import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import {
  PageHeader,
  StatCard,
  Card,
  SectionLabel,
  DataTable,
  THead,
  Row,
  Cell,
  Badge,
  EmptyState,
  ErrorCard,
  UI,
} from "@/components/ui-kit";
import { fetchDatalake, fmtNum, type DatalakeRow } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

/** "a1b2c3d4-e5f6-…" — los episode_id son largos; mostramos el inicio. */
function truncateId(id: string | null | undefined, max = 12): string {
  if (!id) return "—";
  return id.length > max ? `${id.slice(0, max)}…` : id;
}

export default async function DatalakePage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let total: number | null = null;
  let rows: DatalakeRow[] = [];
  let error: string | null = null;

  try {
    const data = await fetchDatalake(50);
    total = data.total ?? 0;
    rows = data.rows ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar el datalake.";
  }

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Datalake" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Datalake de decisiones"
          subtitle="Cada decisión de optimización queda registrada como un episodio — el datalake que alimenta la IA"
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar el datalake. ${error}`} />
        ) : (
          <>
            {/* Total */}
            <div
              className="grid grid-cols-1 md:grid-cols-3"
              style={{ gap: 16, marginBottom: 32 }}
            >
              <StatCard
                label="Episodios de decisión"
                value={fmtNum(total)}
                sub="registros acumulados en el datalake"
              />
            </div>

            {rows.length === 0 ? (
              <EmptyState
                title="Todavía no hay episodios registrados."
                hint="Conforme el optimizador tome decisiones, cada episodio aparecerá aquí."
              />
            ) : (
              <>
                <SectionLabel>Últimos episodios</SectionLabel>
                <Card style={{ padding: 0 }}>
                  <DataTable>
                    <THead
                      cols={[
                        { label: "Cuenta / cliente" },
                        { label: "Campaña" },
                        { label: "Nivel" },
                        { label: "Tipo de acción" },
                        { label: "Episodio" },
                      ]}
                    />
                    <tbody>
                      {rows.map((r, i) => (
                        <Row key={r.episode_id ?? i}>
                          <Cell>
                            {r.account_id ? (
                              <Link
                                href={`/performance/${encodeURIComponent(r.account_id)}`}
                                className="hover:underline"
                                style={{
                                  color: UI.text,
                                  fontWeight: 500,
                                  textDecoration: "none",
                                }}
                              >
                                {r.client_name ?? r.account_id}
                              </Link>
                            ) : (
                              <span style={{ fontWeight: 500 }}>
                                {r.client_name ?? "—"}
                              </span>
                            )}
                          </Cell>
                          <Cell style={{ maxWidth: 280 }}>
                            <span
                              className="block truncate"
                              title={r.campaign_name ?? undefined}
                            >
                              {r.campaign_name ?? "—"}
                            </span>
                          </Cell>
                          <Cell style={{ color: UI.muted }}>
                            {r.entity_level ?? "—"}
                          </Cell>
                          <Cell>
                            {r.action_type ? (
                              <Badge tone="muted">{r.action_type}</Badge>
                            ) : (
                              <span style={{ color: UI.faint }}>—</span>
                            )}
                          </Cell>
                          <Cell
                            mono
                            style={{
                              color: UI.faint,
                              fontSize: 12,
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span title={r.episode_id ?? undefined}>
                              {truncateId(r.episode_id)}
                            </span>
                          </Cell>
                        </Row>
                      ))}
                    </tbody>
                  </DataTable>
                </Card>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
