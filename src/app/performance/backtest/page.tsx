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
import { fetchBacktest, fmtMoney, fmtNum } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

// El engine devuelve el rollup de compute_backtest():
// { n_recs, n_accounts, dollars, proj_point, proj_low, proj_high, ahorro,
//   growth, episodes, backed,
//   by_family: [{family, n, dollars, proj, episodes, conf, eff_med|null}], top: [...] }
interface FamilyRow {
  family: string;
  n: number | null;
  dollars: number | null;
  proj: number | null;
  episodes: number | null;
  conf: number | null;
  eff_med: number | null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseFamilies(v: unknown): FamilyRow[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    .map((f) => ({
      family: typeof f.family === "string" && f.family ? f.family : "otros",
      n: num(f.n),
      dollars: num(f.dollars),
      proj: num(f.proj),
      episodes: num(f.episodes),
      conf: num(f.conf),
      eff_med: num(f.eff_med),
    }));
}

export default async function BacktestPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let data: Record<string, unknown> | null = null;
  let error: string | null = null;

  try {
    data = await fetchBacktest();
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar el backtest.";
  }

  const dollars = num(data?.dollars);
  const nRecs = num(data?.n_recs);
  const nAccounts = num(data?.n_accounts);
  const projPoint = num(data?.proj_point);
  const projLow = num(data?.proj_low);
  const projHigh = num(data?.proj_high);
  const ahorro = num(data?.ahorro);
  const growth = num(data?.growth);
  const episodes = num(data?.episodes);
  const backed = num(data?.backed);
  const families = parseFamilies(data?.by_family);

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Backtest" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Backtest"
          subtitle="Si hubieras seguido las recomendaciones: efecto medido vs proyección, por familia"
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar el backtest. ${error}`} />
        ) : (
          <>
            <div
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4"
              style={{ gap: 16, marginBottom: 32 }}
            >
              <StatCard label="$ en juego" value={fmtMoney(dollars)} />
              <StatCard
                label="Proyección"
                value={fmtMoney(projPoint)}
                sub={
                  projLow != null || projHigh != null
                    ? `rango ${fmtMoney(projLow)} – ${fmtMoney(projHigh)}`
                    : undefined
                }
              />
              <StatCard
                label="Ahorro / Crecimiento"
                value={`${fmtMoney(ahorro)} / ${fmtMoney(growth)}`}
              />
              <StatCard
                label="Recomendaciones"
                value={fmtNum(nRecs)}
                sub={`${fmtNum(nAccounts)} cuentas · ${fmtNum(backed)} con evidencia · ${fmtNum(episodes)} episodios`}
              />
            </div>

            {families.length === 0 ? (
              <EmptyState
                title="Todavía no hay datos de backtest."
                hint="Cuando existan recomendaciones con histórico, verás aquí el efecto medido por familia de acción."
              />
            ) : (
              <Card style={{ padding: 0 }}>
                <DataTable>
                  <THead
                    cols={[
                      { label: "Familia" },
                      { label: "Recs", align: "right" },
                      { label: "$ en juego", align: "right" },
                      { label: "Proyección $", align: "right" },
                      { label: "Efecto medido", align: "right" },
                      { label: "Episodios", align: "right" },
                      { label: "Confianza", align: "right" },
                    ]}
                  />
                  <tbody>
                    {families.map((f) => (
                      <Row key={f.family}>
                        <Cell style={{ fontWeight: 500 }}>{f.family}</Cell>
                        <Cell align="right" mono>{fmtNum(f.n)}</Cell>
                        <Cell align="right" mono>{fmtMoney(f.dollars)}</Cell>
                        <Cell align="right" mono>{fmtMoney(f.proj)}</Cell>
                        <Cell align="right" mono>
                          {f.eff_med != null ? (
                            <span
                              style={{
                                fontWeight: 500,
                                color: f.eff_med >= 0 ? UI.accent : UI.danger,
                              }}
                            >
                              {f.eff_med > 0 ? "+" : ""}
                              {f.eff_med.toFixed(1)}%
                            </span>
                          ) : (
                            <span style={{ color: UI.faint }}>sin histórico</span>
                          )}
                        </Cell>
                        <Cell align="right" mono style={{ color: UI.muted }}>
                          {fmtNum(f.episodes)}
                        </Cell>
                        <Cell align="right" mono style={{ color: UI.muted }}>
                          {f.conf != null ? `${Math.round(f.conf * 100)}%` : "—"}
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
