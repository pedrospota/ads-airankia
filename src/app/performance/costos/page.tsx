import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import {
  PageHeader,
  StatCard,
  Card,
  DataTable,
  THead,
  Row,
  Cell,
  EmptyState,
  ErrorCard,
  UI,
} from "@/components/ui-kit";
import { fetchCosts, fmtMoney, fmtNum } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

interface CostRow {
  day?: string;
  kind?: string;
  model?: string;
  calls?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number;
}

interface KindAgg {
  kind: string;
  calls: number;
  tokens: number;
  cost: number;
}

export default async function CostosPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let rows: CostRow[] = [];
  let error: string | null = null;

  try {
    const data = await fetchCosts(30);
    rows = data.rows ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudieron cargar los costos.";
  }

  const totalCost = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const totalCalls = rows.reduce((s, r) => s + (r.calls ?? 0), 0);

  // Agrupado por tipo de uso (kind), ordenado por costo desc.
  const byKind = new Map<string, KindAgg>();
  for (const r of rows) {
    const kind = r.kind || "otro";
    const agg = byKind.get(kind) ?? { kind, calls: 0, tokens: 0, cost: 0 };
    agg.calls += r.calls ?? 0;
    agg.tokens += (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0);
    agg.cost += r.cost_usd ?? 0;
    byKind.set(kind, agg);
  }
  const kinds = [...byKind.values()].sort((a, b) => b.cost - a.cost);

  // Totales por día, más recientes primero.
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = r.day || "—";
    byDay.set(day, (byDay.get(day) ?? 0) + (r.cost_usd ?? 0));
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Costos" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Costos"
          subtitle="Cuánto cuesta operar el optimizador — consumo de IA de los últimos 30 días"
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar los costos. ${error}`} />
        ) : (
          <>
            <div
              className="grid grid-cols-1 md:grid-cols-3"
              style={{ gap: 16, marginBottom: 32 }}
            >
              <StatCard label="Costo total (30 días)" value={fmtMoney(totalCost, 2)} />
              <StatCard label="Llamadas" value={fmtNum(totalCalls)} />
              <StatCard label="Tipos de uso" value={fmtNum(kinds.length)} />
            </div>

            {rows.length === 0 ? (
              <EmptyState
                title="Sin consumo registrado en los últimos 30 días."
                hint="Los costos aparecerán aquí conforme el optimizador use modelos de IA."
              />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3" style={{ gap: 24 }}>
                <div className="lg:col-span-2">
                  <Card style={{ padding: 0 }}>
                    <DataTable>
                      <THead
                        cols={[
                          { label: "Tipo de uso" },
                          { label: "Llamadas", align: "right" },
                          { label: "Tokens", align: "right" },
                          { label: "Costo USD", align: "right" },
                        ]}
                      />
                      <tbody>
                        {kinds.map((k) => (
                          <Row key={k.kind}>
                            <Cell style={{ fontWeight: 500 }}>{k.kind}</Cell>
                            <Cell align="right" mono>{fmtNum(k.calls)}</Cell>
                            <Cell align="right" mono style={{ color: UI.muted }}>
                              {fmtNum(k.tokens)}
                            </Cell>
                            <Cell align="right" mono style={{ fontWeight: 600 }}>
                              {fmtMoney(k.cost, 2)}
                            </Cell>
                          </Row>
                        ))}
                      </tbody>
                    </DataTable>
                  </Card>
                </div>

                <Card style={{ padding: 0, alignSelf: "start" }}>
                  <div
                    style={{
                      padding: "12px 16px",
                      borderBottom: `1px solid ${UI.border}`,
                      fontSize: 11,
                      fontWeight: 500,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: UI.muted,
                    }}
                  >
                    Por día
                  </div>
                  <ul
                    style={{
                      margin: 0,
                      padding: 0,
                      listStyle: "none",
                      fontSize: 13.5,
                      maxHeight: 420,
                      overflowY: "auto",
                    }}
                  >
                    {days.map(([day, cost]) => (
                      <li
                        key={day}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 12,
                          padding: "10px 16px",
                          borderBottom: `1px solid ${UI.border}`,
                        }}
                      >
                        <span
                          style={{
                            color: UI.muted,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {day}
                        </span>
                        <span
                          style={{
                            fontWeight: 500,
                            fontFamily: UI.fontMono,
                            fontSize: 13,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {fmtMoney(cost, 2)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
