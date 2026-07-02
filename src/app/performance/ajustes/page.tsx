import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import {
  PageHeader,
  Card,
  SectionLabel,
  Badge,
  EmptyState,
  ErrorCard,
  UI,
} from "@/components/ui-kit";
import { fetchConfig, fmtNum, type EngineConfig } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

const VALUE_STYLE: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 600,
  letterSpacing: "-0.02em",
  lineHeight: 1.2,
  marginTop: 8,
  color: UI.text,
  fontVariantNumeric: "tabular-nums",
};

const DETAIL_STYLE: React.CSSProperties = {
  marginTop: 12,
  fontSize: 13.5,
  lineHeight: 1.6,
  display: "grid",
  gap: 4,
};

/** Badge sí/no para flags de configuración (null = desconocido → "no"). */
function YesNoBadge({ on, label }: { on: boolean | null | undefined; label: string }) {
  const active = on === true;
  return (
    <Badge tone={active ? "ok" : "muted"}>
      {label}: {active ? "sí" : "no"}
    </Badge>
  );
}

export default async function AjustesPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let cfg: EngineConfig | null = null;
  let error: string | null = null;

  try {
    cfg = await fetchConfig();
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar la configuración.";
  }

  const tokenOk = cfg?.token_connected === true;

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Ajustes" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Ajustes del motor"
          subtitle="Configuración vigente del optimizador — solo lectura; la edición fina vive en el motor por ahora"
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar la configuración. ${error}`} />
        ) : !cfg ? (
          <EmptyState
            title="Sin configuración disponible."
            hint="El motor todavía no reporta sus ajustes."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 16 }}>
            {/* Conexión del motor */}
            <Card>
              <SectionLabel style={{ marginBottom: 0 }}>Conexión del motor</SectionLabel>
              <div
                style={{
                  ...VALUE_STYLE,
                  color: tokenOk ? UI.accent : UI.danger,
                }}
              >
                {tokenOk ? "Conectado" : "Desconectado"}
              </div>
              <div style={DETAIL_STYLE}>
                <p style={{ margin: 0 }}>
                  <span style={{ color: UI.muted }}>Cuenta Google: </span>
                  <span style={{ fontWeight: 500 }}>{cfg.token_email ?? "—"}</span>
                </p>
                <p style={{ margin: 0 }}>
                  <span style={{ color: UI.muted }}>MCC: </span>
                  <span
                    style={{
                      fontWeight: 500,
                      fontFamily: UI.fontMono,
                      fontSize: 13,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {cfg.mcc ?? "—"}
                  </span>
                </p>
              </div>
            </Card>

            {/* Modelo */}
            <Card>
              <SectionLabel style={{ marginBottom: 0 }}>Modelo</SectionLabel>
              <div style={VALUE_STYLE}>{cfg.llm_model ?? "—"}</div>
              <div style={DETAIL_STYLE}>
                <p style={{ margin: 0 }}>
                  <span style={{ color: UI.muted }}>Modelo de visión: </span>
                  <span style={{ fontWeight: 500 }}>{cfg.vision_model ?? "—"}</span>
                </p>
              </div>
            </Card>

            {/* Notificaciones */}
            <Card>
              <SectionLabel style={{ marginBottom: 0 }}>Notificaciones</SectionLabel>
              <div
                style={{
                  ...VALUE_STYLE,
                  color: cfg.alerts_enabled === true ? UI.accent : UI.muted,
                }}
              >
                {cfg.alerts_enabled === true ? "Activadas" : "Desactivadas"}
              </div>
              <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
                <YesNoBadge on={cfg.telegram_configured} label="Telegram" />
                <YesNoBadge on={cfg.chat_configured} label="Google Chat" />
              </div>
            </Card>

            {/* Cadencia */}
            <Card>
              <SectionLabel style={{ marginBottom: 0 }}>Cadencia</SectionLabel>
              <div style={VALUE_STYLE}>
                {cfg.scan_interval_minutes != null && Number.isFinite(cfg.scan_interval_minutes)
                  ? `cada ${fmtNum(cfg.scan_interval_minutes)} min`
                  : "—"}
              </div>
              <div style={DETAIL_STYLE}>
                <p style={{ margin: 0 }}>
                  <span style={{ color: UI.muted }}>Resumen diario (digest): </span>
                  <span style={{ fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
                    {cfg.digest_hour_utc != null && Number.isFinite(cfg.digest_hour_utc)
                      ? `${fmtNum(cfg.digest_hour_utc)}:00 UTC`
                      : "—"}
                  </span>
                </p>
              </div>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
