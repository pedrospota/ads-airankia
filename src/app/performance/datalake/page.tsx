import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchDatalake, fmtNum, type DatalakeRow } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

const ACCENT = "#10b981";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

/** "a1b2c3d4-e5f6-…" — los episode_id son largos; mostramos el inicio. */
function truncateId(id: string | null | undefined, max = 12): string {
  if (!id) return "—";
  return id.length > max ? `${id.slice(0, max)}…` : id;
}

export default async function DatalakePage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let total: number | null = null;
  let rows: DatalakeRow[] = [];
  let error: string | null = null;

  try {
    const data = await fetchDatalake(50);
    total = data.total ?? 0;
    rows = data.rows ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar el datalake.";
  }

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Datalake" },
        ]}
      />

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Datalake de decisiones</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Cada decisión de optimización queda registrada como un episodio — el datalake que alimenta la IA
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
            No pudimos cargar el datalake. {error}
          </div>
        ) : (
          <>
            {/* Total grande */}
            <div className="mb-8" style={{ ...CARD_STYLE, borderLeft: `4px solid ${ACCENT}` }}>
              <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                Episodios de decisión
              </p>
              <p className="text-5xl font-bold mt-2" style={{ color: ACCENT }}>
                {fmtNum(total)}
              </p>
              <p className="text-xs mt-2" style={{ opacity: 0.5 }}>
                registros acumulados en el datalake
              </p>
            </div>

            {rows.length === 0 ? (
              <div className="text-center py-16" style={{ opacity: 0.4 }}>
                <p className="text-lg">Todavía no hay episodios registrados.</p>
                <p className="text-sm mt-2">
                  Conforme el optimizador tome decisiones, cada episodio aparecerá aquí.
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs uppercase tracking-wide mb-3" style={{ opacity: 0.5 }}>
                  Últimos episodios
                </p>
                <div style={{ ...CARD_STYLE, padding: 0, overflowX: "auto" }}>
                  <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
                    <thead>
                      <tr
                        className="text-xs uppercase tracking-wide"
                        style={{ opacity: 0.5, borderBottom: "1px solid rgba(128,128,128,0.2)" }}
                      >
                        <th className="text-left font-medium px-4 py-3">Cuenta / cliente</th>
                        <th className="text-left font-medium px-4 py-3">Campaña</th>
                        <th className="text-left font-medium px-4 py-3">Nivel</th>
                        <th className="text-left font-medium px-4 py-3">Tipo de acción</th>
                        <th className="text-left font-medium px-4 py-3">Episodio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr
                          key={r.episode_id ?? i}
                          style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}
                        >
                          <td className="px-4 py-3">
                            {r.account_id ? (
                              <Link
                                href={`/performance/${encodeURIComponent(r.account_id)}`}
                                className="font-medium hover:underline"
                                style={{ color: ACCENT }}
                              >
                                {r.client_name ?? r.account_id}
                              </Link>
                            ) : (
                              <span className="font-medium">{r.client_name ?? "—"}</span>
                            )}
                          </td>
                          <td className="px-4 py-3" style={{ maxWidth: 280 }}>
                            <span className="block truncate" title={r.campaign_name ?? undefined}>
                              {r.campaign_name ?? "—"}
                            </span>
                          </td>
                          <td className="px-4 py-3" style={{ opacity: 0.7 }}>
                            {r.entity_level ?? "—"}
                          </td>
                          <td className="px-4 py-3">
                            {r.action_type ? (
                              <span
                                className="text-xs px-2 py-0.5"
                                style={{
                                  borderRadius: 999,
                                  background: "rgba(16,185,129,0.1)",
                                  border: "1px solid rgba(16,185,129,0.25)",
                                  color: ACCENT,
                                }}
                              >
                                {r.action_type}
                              </span>
                            ) : (
                              <span style={{ opacity: 0.3 }}>—</span>
                            )}
                          </td>
                          <td
                            className="px-4 py-3 text-xs whitespace-nowrap"
                            style={{ opacity: 0.5, fontFamily: "monospace" }}
                            title={r.episode_id ?? undefined}
                          >
                            {truncateId(r.episode_id)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
