// ============================================================================
// /performance/[id]/reporte — native premium client report (OPERATOR view).
//
// Mirrors the engine's /account/{id}/reporte in the platform's own design
// system: period-over-period KPIs, AI exec summary (if generated), "Qué
// sigue" (top-5 recommendations by $ at stake) and the share card with the
// public read-only link. The public token is computed SERVER-SIDE here with
// the exact same HMAC the engine uses (_report_token): the engine's session
// secret IS SENTINEL_API_KEY in this deploy, so both sides agree.
// ============================================================================

import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import {
  fetchAccount,
  fetchAccountFull,
  fmtMoney,
  fmtNum,
  type AccountDetail,
  type AccountFull,
} from "@/lib/sentinel";
import {
  PageHeader,
  Card,
  StatCard,
  SectionLabel,
  ErrorCard,
  SecondaryButton,
  UI,
} from "@/components/ui-kit";

// Per-request data (cache: "no-store") + runtime env vars — never prerender.
export const dynamic = "force-dynamic";

const PUBLIC_BASE = "https://ads.airankia.com";

/** Mirror of the engine's _report_token: HMAC-SHA256(secret, "report:{id}")[:20]. */
function reportToken(accountId: string): string | null {
  const secret = process.env.SENTINEL_API_KEY;
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(`report:${accountId}`)
    .digest("hex")
    .slice(0, 20);
}

/** Delta sub-line for a StatCard. `invert`: a DROP is good (CPA). */
function deltaParts(
  delta: number | null | undefined,
  opts: { invert?: boolean; neutral?: boolean } = {}
): { sub: string; tone: "ok" | "danger" | "muted" } {
  if (delta == null || !Number.isFinite(delta)) {
    return { sub: "sin comparativa", tone: "muted" };
  }
  const arrow = delta < 0 ? "↓" : "↑";
  const sub = `${arrow} ${Math.abs(delta).toFixed(0)}% vs mes previo`;
  if (opts.neutral) return { sub, tone: "muted" };
  const good = opts.invert ? delta < 0 : delta > 0;
  return { sub, tone: good ? "ok" : "danger" };
}

/** "cpa alto" ← "cpa_alto" — business-readable label for a recommendation. */
function recLabel(r: Record<string, unknown>): string {
  const raw =
    (typeof r.action_type === "string" && r.action_type) ||
    (typeof r.action_family === "string" && r.action_family) ||
    "";
  return raw.replace(/_/g, " ");
}

function recStake(r: Record<string, unknown>): number {
  const v = r.dollars_at_stake;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export default async function ClientReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  // -------------------------------------------------------------------------
  // Server action: ask the platform's own /api/performance/generate route
  // (built by another module) for the AI exec summary. Defensive on purpose:
  // if the route is missing or fails we just re-render the page unchanged.
  // -------------------------------------------------------------------------
  async function generateSummary() {
    "use server";
    try {
      const h = await headers();
      const host = h.get("host");
      if (host) {
        const proto = h.get("x-forwarded-proto") ?? "https";
        await fetch(`${proto}://${host}/api/performance/generate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: h.get("cookie") ?? "",
          },
          body: JSON.stringify({
            kind: "report-summary",
            account: id,
            accountId: id,
            account_id: id,
          }),
          cache: "no-store",
        });
      }
    } catch {
      // Defensivo: el botón nunca debe tirar la página.
    }
    revalidatePath(`/performance/${id}/reporte`);
  }

  let account: AccountDetail | null = null;
  let full: AccountFull | null = null;
  let error: string | null = null;

  try {
    // `full` is best-effort (recs + AI summary); the KPI report only needs `account`.
    const [a, f] = await Promise.allSettled([fetchAccount(id), fetchAccountFull(id)]);
    if (a.status === "fulfilled") account = a.value;
    else throw a.reason;
    if (f.status === "fulfilled") full = f.value;
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar el reporte.";
  }

  const name = account?.name || account?.account_id || id;
  const objetivo = account?.objetivo || null;
  const cur = account?.kpis?.current ?? {};
  const delta = account?.kpis?.delta_pct ?? {};

  // AI exec summary lives in the engine's diagnostic payload (same source the
  // engine's own client report reads).
  const diag = (full?.diagnostic ?? {}) as Record<string, unknown>;
  const summ = (diag.client_report_summary ?? {}) as Record<string, unknown>;
  const titular = typeof summ.titular === "string" ? summ.titular : "";
  const resumen = typeof summ.resumen === "string" ? summ.resumen : "";
  const highlights = Array.isArray(summ.highlights)
    ? (summ.highlights as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

  const recs = (full?.recommendations ?? [])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .sort((a, b) => recStake(b) - recStake(a))
    .slice(0, 5);

  const token = reportToken(id);
  const publicUrl = token ? `${PUBLIC_BASE}/r/${encodeURIComponent(id)}/${token}` : null;

  const dSpend = deltaParts(delta.spend, { neutral: true });
  const dConv = deltaParts(delta.conv);
  const dCpa = deltaParts(delta.cpa, { invert: true });
  const dRoas = deltaParts(delta.roas);
  const dCtr = deltaParts(delta.ctr);

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: name, href: `/performance/${encodeURIComponent(id)}` },
          { label: "Reporte" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Reporte de resultados"
          subtitle={
            <>
              {name} · Google Ads · últimos 30 días vs los 30 previos
              {objetivo ? <> · objetivo: {objetivo}</> : null}
            </>
          }
          actions={
            <SecondaryButton href={`/performance/${encodeURIComponent(id)}`}>
              ← Volver a la cuenta
            </SecondaryButton>
          }
        />

        {error || !account ? (
          <ErrorCard
            message={
              <>
                No pudimos cargar el reporte de esta cuenta.{" "}
                {error ?? "Inténtalo de nuevo en unos minutos."}
              </>
            }
          />
        ) : (
          <>
            {/* AI exec summary (when already generated) */}
            {(titular || resumen) && (
              <Card style={{ marginBottom: 24, background: UI.surface2 }}>
                <SectionLabel>Resumen ejecutivo</SectionLabel>
                {titular && (
                  <div
                    style={{
                      fontSize: 19,
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                      color: UI.text,
                      lineHeight: 1.35,
                    }}
                  >
                    {titular}
                  </div>
                )}
                {resumen && (
                  <p style={{ fontSize: 13.5, color: UI.muted, lineHeight: 1.6, margin: "10px 0 0" }}>
                    {resumen}
                  </p>
                )}
                {highlights.length > 0 && (
                  <ul style={{ margin: "12px 0 0", paddingLeft: 18, color: UI.text }}>
                    {highlights.map((h, i) => (
                      <li key={i} style={{ fontSize: 13, lineHeight: 1.7, color: UI.muted }}>
                        {h}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {/* KPIs — period over period */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                gap: 16,
                marginBottom: 32,
              }}
            >
              <StatCard
                label="Inversión"
                value={fmtMoney(cur.spend)}
                sub={dSpend.sub}
                tone={dSpend.tone}
              />
              <StatCard
                label="Conversiones"
                value={fmtNum(cur.conv)}
                sub={dConv.sub}
                tone={dConv.tone}
              />
              <StatCard
                label="CPA"
                value={fmtMoney(cur.cpa)}
                sub={dCpa.sub}
                tone={dCpa.tone}
              />
              <StatCard
                label="ROAS"
                value={cur.roas != null && Number.isFinite(cur.roas) ? `${fmtNum(cur.roas, 2)}x` : "—"}
                sub={dRoas.sub}
                tone={dRoas.tone}
              />
              <StatCard
                label="CTR"
                value={cur.ctr != null && Number.isFinite(cur.ctr) ? `${fmtNum(cur.ctr, 2)}%` : "—"}
                sub={dCtr.sub}
                tone={dCtr.tone}
              />
            </div>

            {/* Qué sigue — top 5 by $ at stake */}
            <Card style={{ marginBottom: 24 }}>
              <SectionLabel>Qué sigue</SectionLabel>
              {recs.length === 0 ? (
                <p style={{ fontSize: 13.5, color: UI.muted, margin: 0, lineHeight: 1.6 }}>
                  Sin recomendaciones pendientes — la cuenta se re-analiza de forma continua.
                </p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {recs.map((r, i) => (
                    <li key={i} style={{ fontSize: 13.5, lineHeight: 1.5, color: UI.text, margin: "6px 0" }}>
                      {recLabel(r) || "recomendación"}{" "}
                      <strong>{typeof r.target === "string" ? r.target : ""}</strong>{" "}
                      <span style={{ color: UI.muted }}>
                        · {fmtMoney(recStake(r))}/mes en juego
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Compartir con el cliente */}
            <Card>
              <SectionLabel>Compartir con el cliente</SectionLabel>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <form action={generateSummary} style={{ margin: 0 }}>
                  <SecondaryButton type="submit">✨ Generar resumen IA</SecondaryButton>
                </form>
                <span style={{ fontSize: 12.5, color: UI.muted }}>
                  Redacta el resumen ejecutivo en lenguaje de negocio (una llamada de IA; puede
                  tardar unos segundos — recarga si no aparece).
                </span>
              </div>

              {publicUrl ? (
                <div
                  style={{
                    marginTop: 18,
                    background: UI.surface2,
                    border: `1px solid ${UI.border}`,
                    borderRadius: UI.radiusSm,
                    padding: "12px 14px",
                  }}
                >
                  <div style={{ fontSize: 12, color: UI.muted, marginBottom: 6 }}>
                    Enlace público de solo lectura — cópialo y compártelo con el cliente
                    (no requiere acceso ni expone ninguna llave):
                  </div>
                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontFamily: UI.fontMono,
                      fontSize: 12.5,
                      color: UI.accent,
                      textDecoration: "none",
                      wordBreak: "break-all",
                    }}
                  >
                    {publicUrl}
                  </a>
                </div>
              ) : (
                <p style={{ fontSize: 12.5, color: UI.muted, marginTop: 16, marginBottom: 0 }}>
                  El enlace público no está disponible (falta la configuración del optimizador
                  en el servidor).
                </p>
              )}
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
