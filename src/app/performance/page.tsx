import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
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

const ACCENT = "#10b981";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

function healthColor(health: number | null | undefined): string {
  if (health == null || !Number.isFinite(health)) return "rgba(128,128,128,0.6)";
  if (health >= 80) return "#10b981";
  if (health >= 50) return "#f59e0b";
  return "#ef4444";
}

function KpiCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={CARD_STYLE}>
      <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
        {label}
      </p>
      <p
        className="text-2xl font-bold mt-2"
        style={accent ? { color: ACCENT } : undefined}
      >
        {value}
      </p>
    </div>
  );
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

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Performance</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Optimizador de Google Ads — propuestas medidas, solo-lectura
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
            No pudimos cargar los datos del optimizador. {error}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <KpiCard label="Ahorro detectado" value={fmtMoney(totalAhorro)} accent />
              <KpiCard label="Oportunidad" value={fmtMoney(totalOportunidad)} />
              <KpiCard label="Cuentas analizadas" value={fmtNum(accounts.length)} />
            </div>

            {accounts.length === 0 ? (
              <div className="text-center py-16" style={{ opacity: 0.4 }}>
                <p className="text-lg">Todavía no hay cuentas analizadas.</p>
                <p className="text-sm mt-2">
                  Los resultados aparecerán aquí después del próximo análisis.
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
                      <th className="text-right font-medium px-4 py-3">Inversión 30d</th>
                      <th className="text-right font-medium px-4 py-3">Ahorro</th>
                      <th className="text-right font-medium px-4 py-3">Oportunidad</th>
                      <th className="text-right font-medium px-4 py-3">Propuestas</th>
                      <th className="text-right font-medium px-4 py-3">Salud</th>
                      <th className="text-left font-medium px-4 py-3">Top</th>
                      <th className="text-right font-medium px-4 py-3">Analizada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr
                        key={a.account_id}
                        style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}
                      >
                        <td className="px-4 py-3">
                          <Link
                            href={`/performance/${encodeURIComponent(a.account_id)}`}
                            className="font-medium hover:underline"
                            style={{ color: ACCENT }}
                          >
                            {a.name || a.account_id}
                          </Link>
                        </td>
                        <td className="text-right px-4 py-3">{fmtMoney(a.spend_30d)}</td>
                        <td className="text-right px-4 py-3" style={{ color: ACCENT }}>
                          {fmtMoney(a.ahorro)}
                        </td>
                        <td className="text-right px-4 py-3">{fmtMoney(a.oportunidad)}</td>
                        <td className="text-right px-4 py-3">{fmtNum(a.n_props)}</td>
                        <td className="text-right px-4 py-3">
                          <span
                            className="font-semibold"
                            style={{ color: healthColor(a.health) }}
                          >
                            {a.health != null && Number.isFinite(a.health)
                              ? Math.round(a.health)
                              : "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3" style={{ maxWidth: 260 }}>
                          <span
                            className="block truncate"
                            style={{ opacity: 0.6 }}
                            title={a.top ?? undefined}
                          >
                            {a.top || "—"}
                          </span>
                        </td>
                        <td
                          className="text-right px-4 py-3 whitespace-nowrap"
                          style={{ opacity: 0.5 }}
                        >
                          {fmtWhen(a.analyzed_at)}
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
