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
import { fetchSalud, fmtNum, fmtWhen } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

type Salud = Awaited<ReturnType<typeof fetchSalud>>;

type Tone = "ok" | "warn" | "danger" | "muted";

/** Frescura del último análisis: <=90 min ok, <=180 aviso, más = alerta. */
function freshness(mins: number | null | undefined): { tone: Tone; label: string } {
  if (mins == null || !Number.isFinite(mins)) {
    return { tone: "muted", label: "Sin corridas registradas" };
  }
  if (mins <= 90) return { tone: "ok", label: "Al día" };
  if (mins <= 180) return { tone: "warn", label: "Con retraso" };
  return { tone: "danger", label: "Detenido" };
}

/** Estados de collector del engine: running | ok | noaccess | error. */
function statusTone(status: string | null | undefined): Tone {
  const s = (status ?? "").toLowerCase();
  if (s === "ok" || s === "success") return "ok";
  if (s === "error" || s === "failed") return "danger";
  return "warn"; // running, noaccess, desconocido
}

export default async function SaludPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let salud: Salud | null = null;
  let error: string | null = null;

  try {
    salud = await fetchSalud();
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar el estado del sistema.";
  }

  const mins = salud?.minutes_since_last_run ?? null;
  const fresh = freshness(mins);
  const tokenOk = salud?.token_connected === true;
  const collectors = salud?.collectors ?? [];

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Salud" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Salud del sistema"
          subtitle="Estado del optimizador: conexión, frescura de datos y colectores"
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar el estado del sistema. ${error}`} />
        ) : (
          <>
            {/* Estado general */}
            <div
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4"
              style={{ gap: 16, marginBottom: 32 }}
            >
              <StatCard
                label="Último análisis"
                value={
                  mins != null && Number.isFinite(mins) ? `hace ${fmtNum(mins)} min` : "—"
                }
                sub={fresh.label}
                tone={fresh.tone}
              />
              <StatCard
                label="Google Ads"
                value={tokenOk ? "Conectado" : "Desconectado"}
                sub={tokenOk ? "Token de acceso activo" : "Reconecta la cuenta de Google Ads"}
                tone={tokenOk ? "ok" : "danger"}
              />
              <StatCard
                label="Recomendaciones"
                value={fmtNum(salud?.n_recommendations)}
                sub="cuentas con análisis vigente"
              />
              <StatCard
                label="Hallazgos abiertos"
                value={fmtNum(salud?.n_open_findings)}
                sub="alertas de seguridad sin resolver"
              />
            </div>

            {/* Colectores */}
            {collectors.length === 0 ? (
              <EmptyState
                title="Todavía no hay corridas de colectores."
                hint="Cuando el optimizador ejecute su primer escaneo verás aquí el detalle."
              />
            ) : (
              <Card style={{ padding: 0 }}>
                <DataTable>
                  <THead
                    cols={[
                      { label: "Colector" },
                      { label: "Estado" },
                      { label: "Última corrida", align: "right" },
                      { label: "Cuentas", align: "right" },
                      { label: "Items", align: "right" },
                      { label: "Error" },
                    ]}
                  />
                  <tbody>
                    {collectors.map((c, i) => (
                      <Row key={c.collector ?? i}>
                        <Cell style={{ fontWeight: 500 }}>{c.collector ?? "—"}</Cell>
                        <Cell>
                          <Badge tone={statusTone(c.status)}>{c.status ?? "—"}</Badge>
                        </Cell>
                        <Cell
                          align="right"
                          style={{ color: UI.muted, whiteSpace: "nowrap" }}
                        >
                          {fmtWhen(c.started_at)}
                        </Cell>
                        <Cell align="right" mono>{fmtNum(c.accounts_scanned)}</Cell>
                        <Cell align="right" mono>{fmtNum(c.items)}</Cell>
                        <Cell style={{ maxWidth: 320 }}>
                          {c.error ? (
                            <span
                              className="block truncate"
                              style={{ fontSize: 12, color: UI.danger }}
                              title={c.error}
                            >
                              {c.error}
                            </span>
                          ) : (
                            <span style={{ color: UI.faint }}>—</span>
                          )}
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
