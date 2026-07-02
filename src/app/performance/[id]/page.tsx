import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import {
  fetchAccount,
  fmtMoney,
  fmtNum,
  fmtWhen,
  type AccountDetail,
  type DeltaKey,
} from "@/lib/sentinel";

// Per-request data (cache: "no-store") + runtime env vars — never prerender.
export const dynamic = "force-dynamic";

const ACCENT = "#10b981";
const RED = "#ef4444";
const AMBER = "#f59e0b";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function gradeColor(grade: string | null | undefined): string {
  const g = (grade || "").trim().charAt(0).toUpperCase();
  if (g === "A" || g === "B") return ACCENT;
  if (g === "C") return AMBER;
  if (g === "D" || g === "F") return RED;
  return "rgba(128,128,128,0.6)";
}

/** For CPA, a drop is good; for the rest, growth is good. */
function DeltaArrow({ kpi, delta }: { kpi: DeltaKey; delta: number | null | undefined }) {
  if (delta == null || !Number.isFinite(delta)) return null;
  const up = delta >= 0;
  const good = kpi === "cpa" ? delta < 0 : delta > 0;
  const color = delta === 0 ? "rgba(128,128,128,0.6)" : good ? ACCENT : RED;
  return (
    <span className="text-xs font-semibold" style={{ color }}>
      {up ? "▲" : "▼"} {Math.abs(delta).toLocaleString("en-US", { maximumFractionDigits: 1 })}%
    </span>
  );
}

function KpiCard({
  label,
  value,
  kpi,
  delta,
}: {
  label: string;
  value: string;
  kpi: DeltaKey;
  delta: number | null | undefined;
}) {
  return (
    <div style={CARD_STYLE}>
      <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
        {label}
      </p>
      <div className="flex items-baseline gap-2 mt-2">
        <p className="text-xl font-bold">{value}</p>
        <DeltaArrow kpi={kpi} delta={delta} />
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold mb-3 mt-10">{children}</h2>;
}

export default async function PerformanceAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let account: AccountDetail | null = null;
  let error: string | null = null;

  try {
    account = await fetchAccount(id);
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar la cuenta.";
  }

  const name = account?.name || account?.account_id || id;
  const kpis = account?.kpis;
  const current = kpis?.current;
  const delta = kpis?.delta_pct;
  const audit = account?.audit;
  const optimizations = account?.optimizations ?? [];
  const recommendations = account?.recommendations ?? [];

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[{ label: "Performance", href: "/performance" }, { label: name }]}
      />

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">{name}</h1>
          <p className="mt-2 text-sm" style={{ opacity: 0.4 }}>
            {account?.objetivo ? `Objetivo: ${account.objetivo}` : "Análisis de cuenta"}
            {account?.analyzed_at ? ` · Analizada ${fmtWhen(account.analyzed_at)}` : ""}
            {kpis?.period_days ? ` · Período de ${kpis.period_days} días` : ""}
            {account?.business_rules_active ? " · Reglas de negocio activas" : ""}
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
            No pudimos cargar los datos de esta cuenta. {error}
          </div>
        ) : (
          <>
            {/* (a) KPI grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <KpiCard
                label="Inversión 30d"
                value={fmtMoney(current?.spend)}
                kpi="spend"
                delta={delta?.spend}
              />
              <KpiCard
                label="Conversiones"
                value={fmtNum(current?.conv, 1)}
                kpi="conv"
                delta={delta?.conv}
              />
              <KpiCard
                label="CPA"
                value={fmtMoney(current?.cpa, 2)}
                kpi="cpa"
                delta={delta?.cpa}
              />
              <KpiCard
                label="ROAS"
                value={
                  current?.roas != null && Number.isFinite(current.roas)
                    ? `${current.roas.toLocaleString("en-US", { maximumFractionDigits: 2 })}x`
                    : "—"
                }
                kpi="roas"
                delta={delta?.roas}
              />
              <KpiCard
                label="CTR"
                value={
                  current?.ctr != null && Number.isFinite(current.ctr)
                    ? `${current.ctr.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`
                    : "—"
                }
                kpi="ctr"
                delta={delta?.ctr}
              />
            </div>

            {/* (b) Auditoría de estructura */}
            {audit && (
              <>
                <SectionTitle>Auditoría de estructura</SectionTitle>
                <div style={CARD_STYLE}>
                  <div className="flex items-center gap-5 flex-wrap">
                    <span
                      className="text-5xl font-black leading-none"
                      style={{ color: gradeColor(audit.grade) }}
                    >
                      {audit.grade || "—"}
                    </span>
                    <div>
                      <p className="font-semibold">
                        {audit.score != null ? `${fmtNum(audit.score)}/100` : "Sin puntuación"}
                      </p>
                      <p className="text-sm mt-1" style={{ opacity: 0.6 }}>
                        {fmtNum(audit.n_fail)} fallos · {fmtNum(audit.n_warn)} avisos
                        {(audit.n_suppressed ?? 0) > 0
                          ? ` · ${fmtNum(audit.n_suppressed)} por regla de negocio`
                          : ""}
                      </p>
                    </div>
                  </div>
                  {(audit.categories?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-2 mt-5">
                      {audit.categories!.map((cat, i) => (
                        <span
                          key={i}
                          className="text-xs px-2.5 py-1 rounded-full"
                          style={{
                            border: "1px solid rgba(128,128,128,0.25)",
                            background: "rgba(128,128,128,0.08)",
                          }}
                        >
                          {cat.label || "—"}
                          {cat.score != null && (
                            <span className="font-semibold" style={{ opacity: 0.7 }}>
                              {" "}
                              {fmtNum(cat.score)}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* (c) Propuestas */}
            <SectionTitle>Propuestas</SectionTitle>
            {optimizations.length === 0 ? (
              <div style={{ ...CARD_STYLE, textAlign: "center", opacity: 0.4 }}>
                Sin propuestas activas para esta cuenta.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {optimizations.map((opt, i) => (
                  <div key={i} style={CARD_STYLE}>
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{opt.title || opt.action_type || "Propuesta"}</p>
                        {opt.target && (
                          <p
                            className="text-xs mt-1 truncate"
                            style={{ opacity: 0.5 }}
                            title={opt.target}
                          >
                            {opt.target}
                          </p>
                        )}
                        {opt.detail && (
                          <p className="text-sm mt-2" style={{ opacity: 0.7 }}>
                            {truncate(opt.detail, 220)}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        {opt.dollars_at_stake != null && (
                          <p className="font-bold" style={{ color: ACCENT }}>
                            {fmtMoney(opt.dollars_at_stake)}
                          </p>
                        )}
                        {opt.confidence != null && (
                          <p className="text-xs mt-1" style={{ opacity: 0.5 }}>
                            Confianza: {String(opt.confidence)}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* (d) Recomendaciones medidas */}
            <SectionTitle>Recomendaciones medidas</SectionTitle>
            {recommendations.length === 0 ? (
              <div style={{ ...CARD_STYLE, textAlign: "center", opacity: 0.4 }}>
                Sin recomendaciones medidas todavía.
              </div>
            ) : (
              <div style={{ ...CARD_STYLE, padding: 0 }}>
                {recommendations.map((rec, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-4 px-4 py-3 text-sm flex-wrap"
                    style={
                      i > 0 ? { borderTop: "1px solid rgba(128,128,128,0.12)" } : undefined
                    }
                  >
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">
                        {rec.action_family || rec.action_type || "Recomendación"}
                      </span>
                      {rec.action_family && rec.action_type && (
                        <span style={{ opacity: 0.5 }}> · {rec.action_type}</span>
                      )}
                      {rec.target && (
                        <span
                          className="block text-xs truncate mt-0.5"
                          style={{ opacity: 0.5 }}
                          title={rec.target}
                        >
                          {rec.target}
                        </span>
                      )}
                    </div>
                    <div className="text-right shrink-0 whitespace-nowrap">
                      {rec.effect_pct_net != null && Number.isFinite(rec.effect_pct_net) && (
                        <span
                          className="text-xs font-semibold mr-3"
                          style={{ color: rec.effect_pct_net >= 0 ? ACCENT : RED }}
                        >
                          {rec.effect_pct_net >= 0 ? "+" : ""}
                          {rec.effect_pct_net.toLocaleString("en-US", {
                            maximumFractionDigits: 1,
                          })}
                          %
                        </span>
                      )}
                      <span className="font-semibold">{fmtMoney(rec.dollars_at_stake)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
