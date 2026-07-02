import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchTriage, fmtNum, type TriageRow } from "@/lib/sentinel";

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

const GRADES = ["A", "B", "C", "D", "F"] as const;

/** A/B verde, C ámbar, D/F rojo, desconocido gris. */
function gradeColor(grade: string | null | undefined): string {
  const g = (grade ?? "").toUpperCase();
  if (g === "A" || g === "B") return ACCENT;
  if (g === "C") return AMBER;
  if (g === "D" || g === "F") return RED;
  return GRAY;
}

function GradeBadge({ grade }: { grade: string | null | undefined }) {
  const color = gradeColor(grade);
  return (
    <span
      className="inline-flex items-center justify-center text-sm font-bold"
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        color,
        background: `${color}1f`,
        border: `1px solid ${color}55`,
      }}
    >
      {(grade ?? "—").toUpperCase()}
    </span>
  );
}

export default async function AuditoriaPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let rows: TriageRow[] = [];
  let error: string | null = null;

  try {
    const data = await fetchTriage();
    rows = data.rows ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar la auditoría.";
  }

  // Distribución de calificaciones (A..F). El engine ya ordena peor-primero
  // (score ascendente), pero reordenamos defensivamente por si acaso.
  const dist = new Map<string, number>();
  for (const r of rows) {
    const g = (r.grade ?? "—").toUpperCase();
    dist.set(g, (dist.get(g) ?? 0) + 1);
  }
  const sorted = [...rows].sort(
    (a, b) => (a.score ?? Number.MAX_SAFE_INTEGER) - (b.score ?? Number.MAX_SAFE_INTEGER)
  );

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Auditoría" },
        ]}
      />

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Auditoría MCC</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Auditoría estructural de todas las cuentas, con reglas de negocio aplicadas — las peores primero
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
            No pudimos cargar la auditoría. {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-16" style={{ opacity: 0.4 }}>
            <p className="text-lg">Todavía no hay cuentas auditadas.</p>
            <p className="text-sm mt-2">
              Cuando el optimizador complete su primer análisis verás aquí la calificación de cada cuenta.
            </p>
          </div>
        ) : (
          <>
            {/* Distribución de calificaciones */}
            <div className="flex flex-wrap gap-3 mb-8">
              {GRADES.map((g) => {
                const count = dist.get(g) ?? 0;
                const color = gradeColor(g);
                return (
                  <div
                    key={g}
                    className="flex items-center gap-2 px-4 py-2"
                    style={{
                      borderRadius: 10,
                      background: count > 0 ? `${color}14` : "rgba(128,128,128,0.06)",
                      border: `1px solid ${count > 0 ? `${color}44` : "rgba(128,128,128,0.2)"}`,
                      opacity: count > 0 ? 1 : 0.5,
                    }}
                  >
                    <span className="text-sm font-bold" style={{ color }}>
                      {g}
                    </span>
                    <span className="text-sm font-semibold">{fmtNum(count)}</span>
                    <span className="text-xs" style={{ opacity: 0.5 }}>
                      {count === 1 ? "cuenta" : "cuentas"}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Tabla peor-primero */}
            <div style={{ ...CARD_STYLE, padding: 0, overflowX: "auto" }}>
              <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr
                    className="text-xs uppercase tracking-wide"
                    style={{ opacity: 0.5, borderBottom: "1px solid rgba(128,128,128,0.2)" }}
                  >
                    <th className="text-left font-medium px-4 py-3">Cuenta</th>
                    <th className="text-left font-medium px-4 py-3">Nota</th>
                    <th className="text-right font-medium px-4 py-3">Score</th>
                    <th className="text-right font-medium px-4 py-3">Fallos</th>
                    <th className="text-right font-medium px-4 py-3">Avisos</th>
                    <th className="text-left font-medium px-4 py-3">Peores categorías</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr
                      key={r.account_id ?? i}
                      style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}
                    >
                      <td className="px-4 py-3">
                        {r.account_id ? (
                          <Link
                            href={`/performance/${encodeURIComponent(r.account_id)}`}
                            className="font-medium hover:underline"
                            style={{ color: ACCENT }}
                          >
                            {r.name ?? r.account_id}
                          </Link>
                        ) : (
                          <span className="font-medium">{r.name ?? "—"}</span>
                        )}
                        {(r.n_suppressed ?? 0) > 0 && (
                          <span
                            className="ml-2 text-xs"
                            style={{ opacity: 0.5 }}
                            title="Checks suprimidos por reglas de negocio de la cuenta"
                          >
                            {fmtNum(r.n_suppressed)} por regla
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <GradeBadge grade={r.grade} />
                      </td>
                      <td className="text-right px-4 py-3 font-semibold whitespace-nowrap">
                        {r.score != null && Number.isFinite(r.score) ? (
                          <>
                            {fmtNum(r.score)}
                            <span style={{ opacity: 0.4 }}>/100</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="text-right px-4 py-3" style={{ color: (r.n_fail ?? 0) > 0 ? RED : undefined }}>
                        {fmtNum(r.n_fail)}
                      </td>
                      <td className="text-right px-4 py-3" style={{ color: (r.n_warn ?? 0) > 0 ? AMBER : undefined }}>
                        {fmtNum(r.n_warn)}
                      </td>
                      <td className="px-4 py-3">
                        {(r.worst ?? []).length === 0 ? (
                          <span style={{ opacity: 0.3 }}>—</span>
                        ) : (
                          <span className="flex flex-wrap gap-1.5">
                            {(r.worst ?? []).slice(0, 3).map((w, j) => (
                              <span
                                key={j}
                                className="text-xs px-2 py-0.5"
                                style={{
                                  borderRadius: 999,
                                  background: "rgba(128,128,128,0.1)",
                                  border: "1px solid rgba(128,128,128,0.2)",
                                }}
                              >
                                {w?.label ?? "—"}
                                {w?.score != null && Number.isFinite(w.score) && (
                                  <span style={{ opacity: 0.5 }}> · {fmtNum(w.score)}</span>
                                )}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
