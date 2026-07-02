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
import { fetchRecommendations, fmtMoney, fmtNum, fmtWhen } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

type Rec = Record<string, unknown>;

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Confianza: número 0–1 → %, número >1 redondeado, string tal cual. */
function fmtConf(v: unknown): string {
  const n = num(v);
  if (n != null) return n <= 1 ? `${Math.round(n * 100)}%` : fmtNum(n);
  return str(v) ?? "—";
}

/** Efecto neto: positivo verde (delta positivo), negativo rojo, resto muted. */
function effectColor(pct: number | null): string {
  if (pct == null) return UI.muted;
  if (pct > 0) return UI.accent;
  if (pct < 0) return UI.danger;
  return UI.muted;
}

interface AccountRecs {
  account_id?: string;
  name?: string;
  computed_at?: string | null;
  recs?: Rec[];
}

export default async function RecomendacionesPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let accounts: AccountRecs[] = [];
  let error: string | null = null;

  try {
    const data = await fetchRecommendations();
    accounts = (data.accounts ?? []).filter((a) => (a.recs ?? []).length > 0);
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudieron cargar las recomendaciones.";
  }

  const totalRecs = accounts.reduce((s, a) => s + (a.recs?.length ?? 0), 0);
  const totalDollars = accounts.reduce(
    (s, a) => s + (a.recs ?? []).reduce((t, r) => t + (num(r.dollars_at_stake) ?? 0), 0),
    0
  );

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Recomendaciones" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Recomendaciones"
          subtitle="Todas las propuestas del optimizador, agrupadas por cuenta — solo-lectura"
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar las recomendaciones. ${error}`} />
        ) : (
          <>
            <div
              className="grid grid-cols-1 md:grid-cols-3"
              style={{ gap: 16, marginBottom: 32 }}
            >
              <StatCard label="$ en juego" value={fmtMoney(totalDollars)} />
              <StatCard label="Recomendaciones" value={fmtNum(totalRecs)} />
              <StatCard label="Cuentas con propuestas" value={fmtNum(accounts.length)} />
            </div>

            {accounts.length === 0 ? (
              <EmptyState
                title="Todavía no hay recomendaciones."
                hint="Aparecerán aquí después del próximo análisis del portfolio."
              />
            ) : (
              <div style={{ display: "grid", gap: 24 }}>
                {accounts.map((a, i) => (
                  <section key={a.account_id ?? i}>
                    <Card style={{ padding: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          justifyContent: "space-between",
                          gap: 16,
                          padding: "14px 20px",
                          borderBottom: `1px solid ${UI.border}`,
                        }}
                      >
                        <h2
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: UI.text,
                            margin: 0,
                          }}
                        >
                          {a.name || a.account_id || "Cuenta"}
                        </h2>
                        <span
                          style={{
                            fontSize: 12,
                            color: UI.faint,
                            whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          calculado {fmtWhen(a.computed_at)}
                        </span>
                      </div>
                      <DataTable>
                        <THead
                          cols={[
                            { label: "Acción" },
                            { label: "Target" },
                            { label: "$ en juego", align: "right" },
                            { label: "Confianza", align: "right" },
                            { label: "Efecto neto", align: "right" },
                          ]}
                        />
                        <tbody>
                          {(a.recs ?? []).map((r, j) => {
                            const family = str(r.action_family);
                            const type = str(r.action_type);
                            const effect = num(r.effect_pct_net);
                            return (
                              <Row key={j}>
                                <Cell style={{ whiteSpace: "nowrap" }}>
                                  <span style={{ fontWeight: 500 }}>{family ?? "—"}</span>
                                  {type && (
                                    <span style={{ color: UI.muted }}> · {type}</span>
                                  )}
                                </Cell>
                                <Cell style={{ maxWidth: 280 }}>
                                  <span
                                    className="block truncate"
                                    style={{ color: UI.muted }}
                                    title={str(r.target) ?? undefined}
                                  >
                                    {str(r.target) ?? "—"}
                                  </span>
                                </Cell>
                                <Cell align="right" mono>
                                  {fmtMoney(num(r.dollars_at_stake))}
                                </Cell>
                                <Cell align="right" style={{ color: UI.muted }}>
                                  {fmtConf(r.confidence)}
                                </Cell>
                                <Cell
                                  align="right"
                                  mono
                                  style={{ fontWeight: 500, color: effectColor(effect) }}
                                >
                                  {effect != null
                                    ? `${effect > 0 ? "+" : ""}${effect.toFixed(1)}%`
                                    : "—"}
                                </Cell>
                              </Row>
                            );
                          })}
                        </tbody>
                      </DataTable>
                    </Card>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
