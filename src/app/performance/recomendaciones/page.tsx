import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchRecommendations, fmtMoney, fmtNum, fmtWhen } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

const ACCENT = "#10b981";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

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

function effectColor(pct: number | null): string {
  if (pct == null) return "rgba(128,128,128,0.6)";
  if (pct > 0) return ACCENT;
  if (pct < 0) return "#ef4444";
  return "rgba(128,128,128,0.8)";
}

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

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Recomendaciones</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Todas las propuestas del optimizador, agrupadas por cuenta — solo-lectura
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
            No pudimos cargar las recomendaciones. {error}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <KpiCard label="$ en juego" value={fmtMoney(totalDollars)} accent />
              <KpiCard label="Recomendaciones" value={fmtNum(totalRecs)} />
              <KpiCard label="Cuentas con propuestas" value={fmtNum(accounts.length)} />
            </div>

            {accounts.length === 0 ? (
              <div className="text-center py-16" style={{ opacity: 0.4 }}>
                <p className="text-lg">Todavía no hay recomendaciones.</p>
                <p className="text-sm mt-2">
                  Aparecerán aquí después del próximo análisis del portfolio.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {accounts.map((a, i) => (
                  <section key={a.account_id ?? i} style={{ ...CARD_STYLE, padding: 0 }}>
                    <div
                      className="flex items-baseline justify-between px-4 py-3"
                      style={{ borderBottom: "1px solid rgba(128,128,128,0.2)" }}
                    >
                      <h2 className="font-semibold">{a.name || a.account_id || "Cuenta"}</h2>
                      <span className="text-xs whitespace-nowrap" style={{ opacity: 0.5 }}>
                        calculado {fmtWhen(a.computed_at)}
                      </span>
                    </div>
                    <div style={{ overflowX: "auto" }}>
                      <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
                        <thead>
                          <tr
                            className="text-xs uppercase tracking-wide"
                            style={{ opacity: 0.5, borderBottom: "1px solid rgba(128,128,128,0.12)" }}
                          >
                            <th className="text-left font-medium px-4 py-2">Acción</th>
                            <th className="text-left font-medium px-4 py-2">Target</th>
                            <th className="text-right font-medium px-4 py-2">$ en juego</th>
                            <th className="text-right font-medium px-4 py-2">Confianza</th>
                            <th className="text-right font-medium px-4 py-2">Efecto neto</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(a.recs ?? []).map((r, j) => {
                            const family = str(r.action_family);
                            const type = str(r.action_type);
                            const effect = num(r.effect_pct_net);
                            return (
                              <tr key={j} style={{ borderBottom: "1px solid rgba(128,128,128,0.08)" }}>
                                <td className="px-4 py-2 whitespace-nowrap">
                                  <span className="font-medium">{family ?? "—"}</span>
                                  {type && (
                                    <span style={{ opacity: 0.5 }}> · {type}</span>
                                  )}
                                </td>
                                <td className="px-4 py-2" style={{ maxWidth: 280 }}>
                                  <span
                                    className="block truncate"
                                    style={{ opacity: 0.7 }}
                                    title={str(r.target) ?? undefined}
                                  >
                                    {str(r.target) ?? "—"}
                                  </span>
                                </td>
                                <td className="text-right px-4 py-2" style={{ color: ACCENT }}>
                                  {fmtMoney(num(r.dollars_at_stake))}
                                </td>
                                <td className="text-right px-4 py-2" style={{ opacity: 0.7 }}>
                                  {fmtConf(r.confidence)}
                                </td>
                                <td
                                  className="text-right px-4 py-2 font-medium"
                                  style={{ color: effectColor(effect) }}
                                >
                                  {effect != null ? `${effect > 0 ? "+" : ""}${effect.toFixed(1)}%` : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
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
