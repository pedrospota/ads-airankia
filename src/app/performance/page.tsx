import Link from "next/link";
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
  Badge,
  EmptyState,
  ErrorCard,
  UI,
} from "@/components/ui-kit";
import {
  fetchPortfolio,
  fmtMoney,
  fmtNum,
  fmtWhen,
  type PortfolioAccount,
} from "@/lib/sentinel";

// The sentinel API is queried per-request (cache: "no-store") and needs env
// vars at runtime, so never prerender this page at build time.
export const dynamic = "force-dynamic";

/** Salud: ≥80 ok, ≥50 warn, resto danger; sin dato → muted. */
function healthTone(health: number | null | undefined): "ok" | "warn" | "danger" | "muted" {
  if (health == null || !Number.isFinite(health)) return "muted";
  if (health >= 80) return "ok";
  if (health >= 50) return "warn";
  return "danger";
}

export default async function PerformancePage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let accounts: PortfolioAccount[] = [];
  let error: string | null = null;

  try {
    const portfolio = await fetchPortfolio();
    accounts = portfolio.accounts ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar el portfolio.";
  }

  const totalAhorro = accounts.reduce((s, a) => s + (a.ahorro ?? 0), 0);
  const totalOportunidad = accounts.reduce((s, a) => s + (a.oportunidad ?? 0), 0);

  return (
    <div className="min-h-screen">
      <Header breadcrumbs={[{ label: "Performance" }]} />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Cockpit"
          subtitle="Portfolio del optimizador de Google Ads — propuestas medidas, solo-lectura"
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar los datos del optimizador. ${error}`} />
        ) : (
          <>
            <div
              className="grid grid-cols-1 md:grid-cols-3"
              style={{ gap: 16, marginBottom: 32 }}
            >
              <StatCard label="Ahorro detectado" value={fmtMoney(totalAhorro)} />
              <StatCard label="Oportunidad" value={fmtMoney(totalOportunidad)} />
              <StatCard label="Cuentas analizadas" value={fmtNum(accounts.length)} />
            </div>

            {accounts.length === 0 ? (
              <EmptyState
                title="Todavía no hay cuentas analizadas."
                hint="Los resultados aparecerán aquí después del próximo análisis."
              />
            ) : (
              <Card style={{ padding: 0 }}>
                <DataTable>
                  <THead
                    cols={[
                      { label: "Cuenta" },
                      { label: "Inversión 30d", align: "right" },
                      { label: "Ahorro", align: "right" },
                      { label: "Oportunidad", align: "right" },
                      { label: "Propuestas", align: "right" },
                      { label: "Salud", align: "right" },
                      { label: "Top" },
                      { label: "Analizada", align: "right" },
                    ]}
                  />
                  <tbody>
                    {accounts.map((a) => (
                      <Row key={a.account_id}>
                        <Cell>
                          <Link
                            href={`/performance/${encodeURIComponent(a.account_id)}`}
                            className="hover:underline"
                            style={{
                              color: UI.text,
                              fontWeight: 500,
                              textDecoration: "none",
                            }}
                          >
                            {a.name || a.account_id}
                          </Link>
                        </Cell>
                        <Cell align="right" mono>{fmtMoney(a.spend_30d)}</Cell>
                        <Cell align="right" mono style={{ color: UI.accent }}>
                          {fmtMoney(a.ahorro)}
                        </Cell>
                        <Cell align="right" mono>{fmtMoney(a.oportunidad)}</Cell>
                        <Cell align="right" mono>{fmtNum(a.n_props)}</Cell>
                        <Cell align="right">
                          <Badge tone={healthTone(a.health)}>
                            {a.health != null && Number.isFinite(a.health)
                              ? Math.round(a.health)
                              : "—"}
                          </Badge>
                        </Cell>
                        <Cell style={{ maxWidth: 260 }}>
                          <span
                            className="block truncate"
                            style={{ color: UI.muted }}
                            title={a.top ?? undefined}
                          >
                            {a.top || "—"}
                          </span>
                        </Cell>
                        <Cell
                          align="right"
                          style={{ color: UI.faint, whiteSpace: "nowrap" }}
                        >
                          {fmtWhen(a.analyzed_at)}
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
