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
import { fetchSimulacion, fmtMoney, fmtNum, type SimBet } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

/** Badge para el tipo de apuesta: ahorro (warn) vs crecimiento (muted). */
function KindBadge({ kind }: { kind: string | null | undefined }) {
  const k = (kind ?? "").toLowerCase();
  const isAhorro = k === "ahorro";
  return <Badge tone={isAhorro ? "warn" : "muted"}>{k || "—"}</Badge>;
}

/** Días transcurridos desde opened_at hasta resolved_at (o ahora si sigue abierta). */
function daysOpen(bet: SimBet): number | null {
  if (!bet.opened_at) return null;
  const start = new Date(bet.opened_at).getTime();
  if (Number.isNaN(start)) return null;
  const endIso = bet.resolved_at;
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function isOpen(bet: SimBet): boolean {
  return (bet.status ?? "").toLowerCase() === "abierta";
}

export default async function SimulacionPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let bets: SimBet[] = [];
  let error: string | null = null;

  try {
    const data = await fetchSimulacion();
    bets = data.bets ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar la simulación.";
  }

  const sorted = [...bets].sort((a, b) => (b.missed_usd ?? 0) - (a.missed_usd ?? 0));
  const nAbiertas = bets.filter(isOpen).length;
  const nResueltas = bets.length - nAbiertas;
  const totalMissed = bets.reduce((s, b) => s + (b.missed_usd ?? 0), 0);

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Simulación" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Simulación"
          subtitle="Paper trading: cada recomendación se simula sin aplicarse — esto habría pasado si le hacías caso."
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar la simulación. ${error}`} />
        ) : (
          <>
            <div
              className="grid grid-cols-1 md:grid-cols-3"
              style={{ gap: 16, marginBottom: 32 }}
            >
              <StatCard label="Apuestas abiertas" value={fmtNum(nAbiertas)} />
              <StatCard label="Resueltas" value={fmtNum(nResueltas)} />
              <StatCard label="Ahorro perdido total" value={fmtMoney(totalMissed)} />
            </div>

            {sorted.length === 0 ? (
              <EmptyState
                title="Todavía no hay apuestas simuladas."
                hint="Cada recomendación nueva abre una apuesta que se mide sola con el tiempo."
              />
            ) : (
              <Card style={{ padding: 0 }}>
                <DataTable>
                  <THead
                    cols={[
                      { label: "Cuenta" },
                      { label: "Familia" },
                      { label: "Target" },
                      { label: "Tipo" },
                      { label: "$ en juego", align: "right" },
                      { label: "Ahorro perdido", align: "right" },
                      { label: "Días abierta", align: "right" },
                      { label: "Estado" },
                    ]}
                  />
                  <tbody>
                    {sorted.map((b, i) => {
                      const days = daysOpen(b);
                      const open = isOpen(b);
                      return (
                        <Row key={b.rec_id ?? i}>
                          <Cell style={{ fontWeight: 500, whiteSpace: "nowrap" }}>
                            {b.account_name || b.account_id || "—"}
                          </Cell>
                          <Cell style={{ color: UI.muted, whiteSpace: "nowrap" }}>
                            {b.action_family ?? "—"}
                          </Cell>
                          <Cell style={{ maxWidth: 240 }}>
                            <span
                              className="block truncate"
                              style={{ color: UI.muted }}
                              title={b.target ?? undefined}
                            >
                              {b.target ?? "—"}
                            </span>
                          </Cell>
                          <Cell>
                            <KindBadge kind={b.kind} />
                          </Cell>
                          <Cell align="right" mono>
                            {fmtMoney(b.dollars_at_stake)}
                          </Cell>
                          <Cell
                            align="right"
                            mono
                            style={{
                              fontWeight: 600,
                              color: (b.missed_usd ?? 0) > 0 ? UI.warn : UI.muted,
                            }}
                          >
                            {fmtMoney(b.missed_usd)}
                          </Cell>
                          <Cell align="right" mono style={{ color: UI.muted }}>
                            {days != null ? fmtNum(days) : "—"}
                          </Cell>
                          <Cell>
                            <Badge tone={open ? "ok" : "muted"}>{b.status ?? "—"}</Badge>
                          </Cell>
                        </Row>
                      );
                    })}
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
