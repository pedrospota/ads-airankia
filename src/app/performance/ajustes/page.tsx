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
  PrimaryButton,
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

const INPUT_STYLE: React.CSSProperties = {
  boxSizing: "border-box",
  background: UI.surface2,
  border: `1px solid ${UI.border}`,
  borderRadius: 8,
  padding: "9px 12px",
  fontSize: 13.5,
  color: UI.text,
  outline: "none",
};

const FIELD_LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: UI.muted,
  marginBottom: 6,
};

export default async function AjustesPage({
  searchParams,
}: {
  searchParams: Promise<{ ga4?: string | string[] }>;
}) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const ga4Flag = Array.isArray(sp.ga4) ? sp.ga4[0] : sp.ga4;

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
          subtitle="Configuración vigente del optimizador — lectura, más el evento GA4 real por propiedad; la edición fina vive en el motor por ahora"
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

            {/* Evento GA4 real */}
            <Card style={{ gridColumn: "1 / -1" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <SectionLabel style={{ marginBottom: 0 }}>Evento GA4 real</SectionLabel>
                {ga4Flag === "ok" && <Badge tone="ok">guardado</Badge>}
                {ga4Flag === "err" && <Badge tone="danger">no se pudo guardar</Badge>}
              </div>
              <p
                style={{
                  fontSize: 13.5,
                  lineHeight: 1.6,
                  color: UI.muted,
                  margin: "10px 0 16px",
                  maxWidth: 720,
                }}
              >
                Elige el evento que SÍ es la conversión para una propiedad GA4 (p. ej.{" "}
                <code style={{ fontFamily: UI.fontMono, fontSize: 12.5 }}>OfertaAceptada</code>).
                El próximo escaneo mide las conversiones solo con ese evento.
              </p>
              <form
                method="post"
                action="/api/performance/ga4-event"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "flex-end",
                  gap: 12,
                }}
              >
                <div style={{ flex: "1 1 200px", minWidth: 180 }}>
                  <label htmlFor="ga4-property-id" style={FIELD_LABEL_STYLE}>
                    Property ID
                  </label>
                  <input
                    id="ga4-property-id"
                    name="property_id"
                    required
                    placeholder="123456789"
                    style={{ ...INPUT_STYLE, width: "100%", fontFamily: UI.fontMono }}
                  />
                </div>
                <div style={{ flex: "2 1 260px", minWidth: 220 }}>
                  <label htmlFor="ga4-chosen-event" style={FIELD_LABEL_STYLE}>
                    Evento de conversión
                  </label>
                  <input
                    id="ga4-chosen-event"
                    name="chosen_event"
                    placeholder="OfertaAceptada"
                    style={{ ...INPUT_STYLE, width: "100%", fontFamily: UI.fontMono }}
                  />
                </div>
                <PrimaryButton type="submit">Guardar</PrimaryButton>
              </form>
              <p style={{ fontSize: 12, color: UI.faint, margin: "10px 0 0" }}>
                Vacío = volver a auto (suma los eventos clave no-basura).
              </p>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
