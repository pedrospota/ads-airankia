import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchSimulacion, fmtMoney, fmtNum, type SimBet } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

const ACCENT = "#10b981";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

function KpiCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={CARD_STYLE}>
      <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
        {label}
      </p>
      <p className="text-2xl font-bold mt-2" style={accent ? { color: ACCENT } : undefined}>
        {value}
      </p>
    </div>
  );
}

/** Chip para el tipo de apuesta: ahorro (ámbar) vs crecimiento (azul). */
function KindChip({ kind }: { kind: string | null | undefined }) {
  const k = (kind ?? "").toLowerCase();
  const isAhorro = k === "ahorro";
  const color = isAhorro ? "#f59e0b" : "#3b82f6";
  const bg = isAhorro ? "rgba(245,158,11,0.12)" : "rgba(59,130,246,0.12)";
  return (
    <span
      className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ color, background: bg, border: `1px solid ${bg}` }}
    >
      {k || "—"}
    </span>
  );
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

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Simulación</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Paper trading: cada recomendación se simula sin aplicarse — esto habría
            pasado si le hacías caso.
          </p>
        </div>

        {error ? (
          <div
            style={{
              padding: 16,
              borderRadius: 8,
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.2)",
              color: "#F87171",
            }}
          >
            No pudimos cargar la simulación. {error}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <KpiCard label="Apuestas abiertas" value={fmtNum(nAbiertas)} />
              <KpiCard label="Resueltas" value={fmtNum(nResueltas)} />
              <KpiCard label="Ahorro perdido total" value={fmtMoney(totalMissed)} accent />
            </div>

            {sorted.length === 0 ? (
              <div className="text-center py-16" style={{ opacity: 0.4 }}>
                <p className="text-lg">Todavía no hay apuestas simuladas.</p>
                <p className="text-sm mt-2">
                  Cada recomendación nueva abre una apuesta que se mide sola con el tiempo.
                </p>
              </div>
            ) : (
              <div style={{ ...CARD_STYLE, padding: 0, overflowX: "auto" }}>
                <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr
                      className="text-xs uppercase tracking-wide"
                      style={{ opacity: 0.5, borderBottom: "1px solid rgba(128,128,128,0.2)" }}
                    >
                      <th className="text-left font-medium px-4 py-3">Cuenta</th>
                      <th className="text-left font-medium px-4 py-3">Familia</th>
                      <th className="text-left font-medium px-4 py-3">Target</th>
                      <th className="text-left font-medium px-4 py-3">Tipo</th>
                      <th className="text-right font-medium px-4 py-3">$ en juego</th>
                      <th className="text-right font-medium px-4 py-3">Ahorro perdido</th>
                      <th className="text-right font-medium px-4 py-3">Días abierta</th>
                      <th className="text-left font-medium px-4 py-3">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((b, i) => {
                      const days = daysOpen(b);
                      const open = isOpen(b);
                      return (
                        <tr
                          key={b.rec_id ?? i}
                          style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}
                        >
                          <td className="px-4 py-3 font-medium whitespace-nowrap">
                            {b.account_name || b.account_id || "—"}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap" style={{ opacity: 0.7 }}>
                            {b.action_family ?? "—"}
                          </td>
                          <td className="px-4 py-3" style={{ maxWidth: 240 }}>
                            <span
                              className="block truncate"
                              style={{ opacity: 0.7 }}
                              title={b.target ?? undefined}
                            >
                              {b.target ?? "—"}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <KindChip kind={b.kind} />
                          </td>
                          <td className="text-right px-4 py-3">
                            {fmtMoney(b.dollars_at_stake)}
                          </td>
                          <td
                            className="text-right px-4 py-3 font-semibold"
                            style={{
                              color:
                                (b.missed_usd ?? 0) > 0 ? "#f59e0b" : "rgba(128,128,128,0.6)",
                            }}
                          >
                            {fmtMoney(b.missed_usd)}
                          </td>
                          <td className="text-right px-4 py-3" style={{ opacity: 0.7 }}>
                            {days != null ? fmtNum(days) : "—"}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className="text-xs font-medium"
                              style={{ color: open ? ACCENT : "rgba(128,128,128,0.6)" }}
                            >
                              {b.status ?? "—"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
