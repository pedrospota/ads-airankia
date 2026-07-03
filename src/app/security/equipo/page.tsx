import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchOptimizers, fetchScorecard, fmtNum, type ScorecardRow } from "@/lib/sentinel";
import {
  PageHeader,
  Card,
  StatCard,
  SectionLabel,
  DataTable,
  THead,
  Row,
  Cell,
  Badge,
  EmptyState,
  ErrorCard,
  UI,
} from "@/components/ui-kit";

// Per-request data (cache: "no-store") + runtime env vars — never prerender.
export const dynamic = "force-dynamic";

// The engine only accepts these windows (anything else falls back to 14).
const DAY_OPTIONS = [7, 14, 30] as const;

interface OptimizerRow {
  person?: string;
  account_id?: string;
  account_name?: string;
  n_changes?: number;
  types?: Record<string, number>;
}

function DaysSwitcher({ days }: { days: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {DAY_OPTIONS.map((d) => {
        const active = d === days;
        return (
          <Link
            key={d}
            href={`/security/equipo?days=${d}`}
            aria-current={active ? "page" : undefined}
            style={{
              padding: "5px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 500,
              whiteSpace: "nowrap",
              textDecoration: "none",
              color: active ? UI.text : UI.muted,
              background: active ? UI.surface2 : "transparent",
              border: `1px solid ${active ? UI.border : "transparent"}`,
            }}
          >
            {d} días
          </Link>
        );
      })}
    </div>
  );
}

/** Nombre visible de una fila del scorecard (el motor manda `optimizer`). */
function personName(r: ScorecardRow): string {
  return (
    r.optimizer ||
    r.person ||
    r.name ||
    (r.email ? r.email.split("@")[0] : "") ||
    "(desconocido)"
  );
}

/** "62%" desde win_rate 0–1; "—" cuando no hay decisivos. */
function fmtWinRate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

/** "+4.2%" / "-3.1%" para el efecto neto mediano. */
function fmtNet(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v}%`;
}

function netColor(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return UI.faint;
  if (v > 0) return UI.accent;
  if (v < 0) return UI.danger;
  return UI.muted;
}

/** top_families llega como [["campaign", 12], …] — render defensivo. */
function FamilyChips({ families }: { families: ScorecardRow["top_families"] }) {
  const entries = (Array.isArray(families) ? families : [])
    .map((e) =>
      Array.isArray(e) ? { family: String(e[0] ?? ""), n: Number(e[1] ?? 0) } : null
    )
    .filter((e): e is { family: string; n: number } => e != null && e.family !== "");
  if (entries.length === 0) return <span style={{ color: UI.faint }}>—</span>;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {entries.map(({ family, n }) => (
        <Badge key={family} tone="muted">
          {family}×{fmtNum(n)}
        </Badge>
      ))}
    </span>
  );
}

/** "campaign×3, ad_group_criterion×12" as quiet pills, biggest first. */
function TypeChips({ types }: { types: Record<string, number> | null | undefined }) {
  const entries = Object.entries(types ?? {}).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (entries.length === 0) return <span style={{ color: UI.faint }}>—</span>;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {entries.map(([type, count]) => (
        <Badge key={type} tone="muted">
          {type}×{fmtNum(count)}
        </Badge>
      ))}
    </span>
  );
}

export default async function SecurityTeamPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const rawDays = Number(Array.isArray(sp.days) ? sp.days[0] : sp.days);
  const days = (DAY_OPTIONS as readonly number[]).includes(rawDays) ? rawDays : 14;

  let rows: OptimizerRow[] = [];
  let error: string | null = null;

  try {
    const data = await fetchOptimizers(days);
    rows = data.rows ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar la actividad del equipo.";
  }

  // Scorecard medido (independiente de la actividad: si falla, solo cae su sección).
  let scoreRows: ScorecardRow[] = [];
  let scoreError: string | null = null;

  try {
    const data = await fetchScorecard();
    scoreRows = data.rows ?? [];
  } catch (e) {
    scoreError =
      e instanceof Error ? e.message : "No se pudo cargar el scorecard de decisiones.";
  }

  const sorted = [...rows].sort((a, b) => (b.n_changes ?? 0) - (a.n_changes ?? 0));
  const nPersonas = new Set(sorted.map((r) => r.person || "(desconocido)")).size;
  const nCuentas = new Set(sorted.map((r) => r.account_id || r.account_name || "?")).size;
  const nCambios = sorted.reduce((s, r) => s + (r.n_changes ?? 0), 0);

  return (
    <div>
      <Header
        breadcrumbs={[{ label: "Seguridad", href: "/security" }, { label: "Equipo" }]}
      />

      <main style={{ marginTop: 24 }}>
        <PageHeader
          title="Equipo"
          subtitle={`Cambios atribuidos por persona en Google Ads — últimos ${days} días.`}
          actions={<DaysSwitcher days={days} />}
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar la actividad del equipo. ${error}`} />
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 16,
                marginBottom: 32,
              }}
            >
              <StatCard label="Personas activas" value={fmtNum(nPersonas)} />
              <StatCard label="Cuentas tocadas" value={fmtNum(nCuentas)} />
              <StatCard label="Cambios totales" value={fmtNum(nCambios)} />
            </div>

            {sorted.length === 0 ? (
              <Card style={{ padding: 0 }}>
                <EmptyState
                  title={`Sin cambios atribuidos en los últimos ${days} días`}
                  hint="La actividad del equipo aparecerá aquí cuando el colector detecte cambios en Google Ads."
                />
              </Card>
            ) : (
              <Card style={{ padding: 0 }}>
                <DataTable>
                  <THead
                    cols={[
                      { label: "Persona" },
                      { label: "Cuenta" },
                      { label: "Cambios", align: "right", width: 110 },
                      { label: "Desglose" },
                    ]}
                  />
                  <tbody>
                    {sorted.map((r, i) => (
                      <Row key={`${r.person ?? "?"}-${r.account_id ?? i}`}>
                        <Cell style={{ fontWeight: 500, whiteSpace: "nowrap" }}>
                          {r.person || "(desconocido)"}
                        </Cell>
                        <Cell style={{ color: UI.muted }}>
                          {r.account_name || r.account_id || "—"}
                        </Cell>
                        <Cell align="right" mono>
                          {fmtNum(r.n_changes)}
                        </Cell>
                        <Cell>
                          <TypeChips types={r.types} />
                        </Cell>
                      </Row>
                    ))}
                  </tbody>
                </DataTable>
              </Card>
            )}
          </>
        )}

        {/* Calidad de decisiones (medido) — scorecard de-confundido del datalake */}
        <section style={{ marginTop: 40 }}>
          <SectionLabel>Calidad de decisiones (medido)</SectionLabel>
          {scoreError ? (
            <ErrorCard
              message={`No pudimos cargar el scorecard de decisiones. ${scoreError}`}
            />
          ) : scoreRows.length === 0 ? (
            <Card style={{ padding: 0 }}>
              <EmptyState
                title="Todavía no hay decisiones medidas con autor."
                hint="Cuando el datalake acumule episodios atribuidos a personas (con su ventana post y control), aquí verás el win-rate y el efecto neto medidos de cada quien."
              />
            </Card>
          ) : (
            <>
              <Card style={{ padding: 0 }}>
                <DataTable>
                  <THead
                    cols={[
                      { label: "Persona" },
                      { label: "Win-rate", align: "right", width: 130 },
                      { label: "Efecto neto medio", align: "right", width: 150 },
                      { label: "Decisiones", align: "right", width: 110 },
                      { label: "Top familias" },
                    ]}
                  />
                  <tbody>
                    {scoreRows.map((r, i) => {
                      const nDec = r.n_decisive ?? 0;
                      return (
                        <Row key={r.email ?? personName(r) ?? i}>
                          <Cell style={{ fontWeight: 500, whiteSpace: "nowrap" }}>
                            {personName(r)}
                            {nDec < 5 && (
                              <Badge tone="warn" style={{ marginLeft: 8 }}>
                                señal direccional
                              </Badge>
                            )}
                          </Cell>
                          <Cell align="right" mono>
                            {fmtWinRate(r.win_rate)}
                            <span style={{ color: UI.faint, fontSize: 11 }}>
                              {" "}({fmtNum(nDec)} dec)
                            </span>
                          </Cell>
                          <Cell
                            align="right"
                            mono
                            style={{ color: netColor(r.median_net), fontWeight: 600 }}
                          >
                            {fmtNet(r.median_net)}
                          </Cell>
                          <Cell align="right" mono>
                            {fmtNum(r.n)}
                            {(r.n_accounts ?? 0) > 0 ? (
                              <span style={{ color: UI.faint, fontSize: 11 }}>
                                {" "}· {fmtNum(r.n_accounts)} ctas
                              </span>
                            ) : null}
                          </Cell>
                          <Cell>
                            <FamilyChips families={r.top_families} />
                          </Cell>
                        </Row>
                      );
                    })}
                  </tbody>
                </DataTable>
              </Card>
              <p
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  color: UI.faint,
                  marginTop: 12,
                }}
              >
                Efecto neto de-confundido: ya descuenta la tendencia de cada cuenta, así
                que trabajar una cuenta difícil no penaliza. Con pocas decisiones
                decisivas la señal es direccional — esto sirve para aprender qué
                funciona, no para rankear personas.
              </p>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
