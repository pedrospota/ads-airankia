import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchBacktest, fmtMoney, fmtNum } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

const ACCENT = "#10b981";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

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

function KpiCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div style={CARD_STYLE}>
      <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
        {label}
      </p>
      <p className="text-2xl font-bold mt-2" style={accent ? { color: ACCENT } : undefined}>
        {value}
      </p>
      {sub && (
        <p className="text-xs mt-1" style={{ opacity: 0.4 }}>
          {sub}
        </p>
      )}
    </div>
  );
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

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Backtest</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Si hubieras seguido las recomendaciones: efecto medido vs proyección, por familia
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
            No pudimos cargar el backtest. {error}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
              <KpiCard label="$ en juego" value={fmtMoney(dollars)} accent />
              <KpiCard
                label="Proyección"
                value={fmtMoney(projPoint)}
                sub={
                  projLow != null || projHigh != null
                    ? `rango ${fmtMoney(projLow)} – ${fmtMoney(projHigh)}`
                    : undefined
                }
              />
              <KpiCard
                label="Ahorro / Crecimiento"
                value={`${fmtMoney(ahorro)} / ${fmtMoney(growth)}`}
              />
              <KpiCard
                label="Recomendaciones"
                value={fmtNum(nRecs)}
                sub={`${fmtNum(nAccounts)} cuentas · ${fmtNum(backed)} con evidencia · ${fmtNum(episodes)} episodios`}
              />
            </div>

            {families.length === 0 ? (
              <div className="text-center py-16" style={{ opacity: 0.4 }}>
                <p className="text-lg">Todavía no hay datos de backtest.</p>
                <p className="text-sm mt-2">
                  Cuando existan recomendaciones con histórico, verás aquí el efecto medido
                  por familia de acción.
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
                      <th className="text-left font-medium px-4 py-3">Familia</th>
                      <th className="text-right font-medium px-4 py-3">Recs</th>
                      <th className="text-right font-medium px-4 py-3">$ en juego</th>
                      <th className="text-right font-medium px-4 py-3">Proyección $</th>
                      <th className="text-right font-medium px-4 py-3">Efecto medido</th>
                      <th className="text-right font-medium px-4 py-3">Episodios</th>
                      <th className="text-right font-medium px-4 py-3">Confianza</th>
                    </tr>
                  </thead>
                  <tbody>
                    {families.map((f) => (
                      <tr key={f.family} style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}>
                        <td className="px-4 py-3 font-medium">{f.family}</td>
                        <td className="text-right px-4 py-3">{fmtNum(f.n)}</td>
                        <td className="text-right px-4 py-3">{fmtMoney(f.dollars)}</td>
                        <td className="text-right px-4 py-3" style={{ color: ACCENT }}>
                          {fmtMoney(f.proj)}
                        </td>
                        <td className="text-right px-4 py-3">
                          {f.eff_med != null ? (
                            <span
                              className="font-medium"
                              style={{ color: f.eff_med >= 0 ? ACCENT : "#ef4444" }}
                            >
                              {f.eff_med > 0 ? "+" : ""}
                              {f.eff_med.toFixed(1)}%
                            </span>
                          ) : (
                            <span style={{ opacity: 0.4 }}>sin histórico</span>
                          )}
                        </td>
                        <td className="text-right px-4 py-3" style={{ opacity: 0.7 }}>
                          {fmtNum(f.episodes)}
                        </td>
                        <td className="text-right px-4 py-3" style={{ opacity: 0.7 }}>
                          {f.conf != null ? `${Math.round(f.conf * 100)}%` : "—"}
                        </td>
                      </tr>
                    ))}
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
