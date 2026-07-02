import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchSalud, fmtNum, fmtWhen } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

const ACCENT = "#10b981";
const AMBER = "#f59e0b";
const RED = "#ef4444";
const GRAY = "rgba(128,128,128,0.6)";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

type Salud = Awaited<ReturnType<typeof fetchSalud>>;

/** Frescura del último análisis: <=90 min ok, <=180 aviso, más = alerta. */
function freshness(mins: number | null | undefined): { color: string; label: string } {
  if (mins == null || !Number.isFinite(mins)) {
    return { color: GRAY, label: "Sin corridas registradas" };
  }
  if (mins <= 90) return { color: ACCENT, label: "Al día" };
  if (mins <= 180) return { color: AMBER, label: "Con retraso" };
  return { color: RED, label: "Detenido" };
}

/** Estados de collector del engine: running | ok | noaccess | error. */
function statusColor(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "ok" || s === "success") return ACCENT;
  if (s === "error" || s === "failed") return RED;
  return AMBER; // running, noaccess, desconocido
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

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Salud del sistema</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Estado del optimizador: conexión, frescura de datos y colectores
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
            No pudimos cargar el estado del sistema. {error}
          </div>
        ) : (
          <>
            {/* Hero de estado */}
            <div
              className="flex flex-wrap items-center gap-x-10 gap-y-4 mb-8"
              style={{ ...CARD_STYLE, borderLeft: `4px solid ${fresh.color}` }}
            >
              <div>
                <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                  Último análisis
                </p>
                <p className="text-2xl font-bold mt-1" style={{ color: fresh.color }}>
                  {mins != null && Number.isFinite(mins) ? `hace ${fmtNum(mins)} min` : "—"}
                </p>
                <p className="text-xs mt-1" style={{ opacity: 0.5 }}>
                  {fresh.label}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                  Google Ads
                </p>
                <p
                  className="text-2xl font-bold mt-1"
                  style={{ color: tokenOk ? ACCENT : RED }}
                >
                  {tokenOk ? "Conectado" : "Desconectado"}
                </p>
                <p className="text-xs mt-1" style={{ opacity: 0.5 }}>
                  {tokenOk ? "Token de acceso activo" : "Reconecta la cuenta de Google Ads"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                  Recomendaciones
                </p>
                <p className="text-2xl font-bold mt-1">{fmtNum(salud?.n_recommendations)}</p>
                <p className="text-xs mt-1" style={{ opacity: 0.5 }}>
                  cuentas con análisis vigente
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                  Hallazgos abiertos
                </p>
                <p className="text-2xl font-bold mt-1">{fmtNum(salud?.n_open_findings)}</p>
                <p className="text-xs mt-1" style={{ opacity: 0.5 }}>
                  alertas de seguridad sin resolver
                </p>
              </div>
            </div>

            {/* Colectores */}
            {collectors.length === 0 ? (
              <div className="text-center py-16" style={{ opacity: 0.4 }}>
                <p className="text-lg">Todavía no hay corridas de colectores.</p>
                <p className="text-sm mt-2">
                  Cuando el optimizador ejecute su primer escaneo verás aquí el detalle.
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
                      <th className="text-left font-medium px-4 py-3">Colector</th>
                      <th className="text-left font-medium px-4 py-3">Estado</th>
                      <th className="text-right font-medium px-4 py-3">Última corrida</th>
                      <th className="text-right font-medium px-4 py-3">Cuentas</th>
                      <th className="text-right font-medium px-4 py-3">Items</th>
                      <th className="text-left font-medium px-4 py-3">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collectors.map((c, i) => (
                      <tr
                        key={c.collector ?? i}
                        style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}
                      >
                        <td className="px-4 py-3 font-medium">{c.collector ?? "—"}</td>
                        <td className="px-4 py-3">
                          <span
                            className="text-xs font-semibold uppercase"
                            style={{ color: statusColor(c.status) }}
                          >
                            {c.status ?? "—"}
                          </span>
                        </td>
                        <td className="text-right px-4 py-3 whitespace-nowrap" style={{ opacity: 0.6 }}>
                          {fmtWhen(c.started_at)}
                        </td>
                        <td className="text-right px-4 py-3">{fmtNum(c.accounts_scanned)}</td>
                        <td className="text-right px-4 py-3">{fmtNum(c.items)}</td>
                        <td className="px-4 py-3" style={{ maxWidth: 320 }}>
                          {c.error ? (
                            <span
                              className="block truncate text-xs"
                              style={{ color: RED }}
                              title={c.error}
                            >
                              {c.error}
                            </span>
                          ) : (
                            <span style={{ opacity: 0.3 }}>—</span>
                          )}
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
