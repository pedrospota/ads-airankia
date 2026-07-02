import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import {
  PageHeader,
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
import { fetchTriage, fmtNum, type TriageRow } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

const GRADES = ["A", "B", "C", "D", "F"] as const;

/** A/B ok, C warn, D/F danger, desconocido muted. */
function gradeTone(grade: string | null | undefined): "ok" | "warn" | "danger" | "muted" {
  const g = (grade ?? "").toUpperCase();
  if (g === "A" || g === "B") return "ok";
  if (g === "C") return "warn";
  if (g === "D" || g === "F") return "danger";
  return "muted";
}

function GradeBadge({ grade }: { grade: string | null | undefined }) {
  return <Badge tone={gradeTone(grade)}>{(grade ?? "—").toUpperCase()}</Badge>;
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

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Auditoría MCC"
          subtitle="Auditoría estructural de todas las cuentas, con reglas de negocio aplicadas — las peores primero"
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar la auditoría. ${error}`} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Todavía no hay cuentas auditadas."
            hint="Cuando el optimizador complete su primer análisis verás aquí la calificación de cada cuenta."
          />
        ) : (
          <>
            {/* Distribución de calificaciones */}
            <div className="flex flex-wrap" style={{ gap: 12, marginBottom: 32 }}>
              {GRADES.map((g) => {
                const count = dist.get(g) ?? 0;
                return (
                  <div
                    key={g}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: UI.surface,
                      border: `1px solid ${UI.border}`,
                      borderRadius: UI.radiusSm,
                      padding: "8px 14px",
                      opacity: count > 0 ? 1 : 0.5,
                    }}
                  >
                    <Badge tone={gradeTone(g)}>{g}</Badge>
                    <span
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: UI.text,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtNum(count)}
                    </span>
                    <span style={{ fontSize: 12, color: UI.muted }}>
                      {count === 1 ? "cuenta" : "cuentas"}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Tabla peor-primero */}
            <Card style={{ padding: 0 }}>
              <DataTable>
                <THead
                  cols={[
                    { label: "Cuenta" },
                    { label: "Nota" },
                    { label: "Score", align: "right" },
                    { label: "Fallos", align: "right" },
                    { label: "Avisos", align: "right" },
                    { label: "Peores categorías" },
                  ]}
                />
                <tbody>
                  {sorted.map((r, i) => (
                    <Row key={r.account_id ?? i}>
                      <Cell>
                        {r.account_id ? (
                          <Link
                            href={`/performance/${encodeURIComponent(r.account_id)}`}
                            className="hover:underline"
                            style={{
                              color: UI.text,
                              fontWeight: 500,
                              textDecoration: "none",
                            }}
                          >
                            {r.name ?? r.account_id}
                          </Link>
                        ) : (
                          <span style={{ fontWeight: 500 }}>{r.name ?? "—"}</span>
                        )}
                        {(r.n_suppressed ?? 0) > 0 && (
                          <span
                            style={{ marginLeft: 8, fontSize: 12, color: UI.faint }}
                            title="Checks suprimidos por reglas de negocio de la cuenta"
                          >
                            {fmtNum(r.n_suppressed)} por regla
                          </span>
                        )}
                      </Cell>
                      <Cell>
                        <GradeBadge grade={r.grade} />
                      </Cell>
                      <Cell
                        align="right"
                        mono
                        style={{ fontWeight: 600, whiteSpace: "nowrap" }}
                      >
                        {r.score != null && Number.isFinite(r.score) ? (
                          <>
                            {fmtNum(r.score)}
                            <span style={{ color: UI.faint, fontWeight: 400 }}>/100</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </Cell>
                      <Cell
                        align="right"
                        mono
                        style={(r.n_fail ?? 0) > 0 ? { color: UI.danger } : undefined}
                      >
                        {fmtNum(r.n_fail)}
                      </Cell>
                      <Cell
                        align="right"
                        mono
                        style={(r.n_warn ?? 0) > 0 ? { color: UI.warn } : undefined}
                      >
                        {fmtNum(r.n_warn)}
                      </Cell>
                      <Cell>
                        {(r.worst ?? []).length === 0 ? (
                          <span style={{ color: UI.faint }}>—</span>
                        ) : (
                          <span className="flex flex-wrap" style={{ gap: 6 }}>
                            {(r.worst ?? []).slice(0, 3).map((w, j) => (
                              <Badge key={j} tone="muted">
                                {w?.label ?? "—"}
                                {w?.score != null && Number.isFinite(w.score) && (
                                  <span style={{ color: UI.faint }}>
                                    {" "}· {fmtNum(w.score)}
                                  </span>
                                )}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </Cell>
                    </Row>
                  ))}
                </tbody>
              </DataTable>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
