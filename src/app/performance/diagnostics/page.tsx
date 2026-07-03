import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import {
  fetchDiagnostics,
  fmtMoney,
  fmtNum,
  fmtWhen,
  type DiagnosticRow,
} from "@/lib/sentinel";
import {
  PageHeader,
  Card,
  StatCard,
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

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

export default async function DiagnosticsPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let rows: DiagnosticRow[] = [];
  let error: string | null = null;

  try {
    const data = await fetchDiagnostics();
    rows = data.rows ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar el diagnóstico.";
  }

  // Mayor gasto primero — donde más duele es donde primero se mira.
  const sorted = [...rows].sort(
    (a, b) => (b.search_cost_30d ?? 0) - (a.search_cost_30d ?? 0)
  );
  const totalCost = sorted.reduce((s, r) => s + (r.search_cost_30d ?? 0), 0);
  const totalSat = sorted.reduce((s, r) => s + (r.n_saturation ?? 0), 0);

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Diagnóstico" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Diagnóstico por cuenta"
          subtitle="Inventario del análisis del motor: frescura, gasto en search y señales de saturación por cuenta."
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar el diagnóstico. ${error}`} />
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
              <StatCard label="Cuentas analizadas" value={fmtNum(sorted.length)} />
              <StatCard
                label="Gasto search 30d"
                value={fmtMoney(totalCost)}
                sub="suma de las cuentas con diagnóstico"
              />
              <StatCard
                label="Señales de saturación"
                value={fmtNum(totalSat)}
                sub={totalSat > 0 ? "campañas limitadas por presupuesto o rank" : "sin señales detectadas"}
                tone={totalSat > 0 ? "warn" : "muted"}
              />
            </div>

            {sorted.length === 0 ? (
              <Card style={{ padding: 0 }}>
                <EmptyState
                  title="Todavía no hay diagnósticos calculados."
                  hint="Cuando el motor complete su primer escaneo, cada cuenta aparecerá aquí con su análisis."
                />
              </Card>
            ) : (
              <>
                <SectionLabel>Cuentas — mayor gasto primero</SectionLabel>
                <Card style={{ padding: 0 }}>
                  <DataTable>
                    <THead
                      cols={[
                        { label: "Cuenta" },
                        { label: "Calculado", width: 140 },
                        { label: "Gasto search 30d", align: "right", width: 160 },
                        { label: "Señales de saturación", align: "right", width: 190 },
                      ]}
                    />
                    <tbody>
                      {sorted.map((r, i) => {
                        const sat = r.n_saturation ?? 0;
                        return (
                          <Row key={r.account_id ?? i}>
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
                                  {r.name || r.account_id}
                                </Link>
                              ) : (
                                <span style={{ fontWeight: 500 }}>{r.name ?? "—"}</span>
                              )}
                            </Cell>
                            <Cell style={{ color: UI.muted, whiteSpace: "nowrap" }}>
                              {fmtWhen(r.computed_at)}
                            </Cell>
                            <Cell align="right" mono>
                              {fmtMoney(r.search_cost_30d)}
                            </Cell>
                            <Cell align="right">
                              {sat > 0 ? (
                                <Badge tone="warn">
                                  {fmtNum(sat)} {sat === 1 ? "señal" : "señales"}
                                </Badge>
                              ) : (
                                <span style={{ color: UI.faint }}>0</span>
                              )}
                            </Cell>
                          </Row>
                        );
                      })}
                    </tbody>
                  </DataTable>
                </Card>
              </>
            )}

            {/* Explicador */}
            <Card style={{ marginTop: 24 }}>
              <SectionLabel style={{ marginBottom: 8 }}>Cómo leerlo</SectionLabel>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, color: UI.muted, margin: 0 }}>
                Cada fila es el diagnóstico que el motor calculó para una cuenta:{" "}
                <span style={{ color: UI.text }}>calculado</span> indica la frescura del
                análisis, <span style={{ color: UI.text }}>gasto search 30d</span> es el
                costo en campañas de búsqueda del último mes y{" "}
                <span style={{ color: UI.text }}>señales de saturación</span> cuenta las
                campañas limitadas por presupuesto o por rank (impression share perdido).
                Una señal de saturación no es un problema en sí — es dinero que la cuenta
                podría capturar subiendo presupuesto o mejorando calidad. Entra a la cuenta
                para ver el detalle: negativas propuestas, patrones de desperdicio y
                oportunidades de keywords.
              </p>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
