import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchConfig, fmtNum, type EngineConfig } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

const ACCENT = "#10b981";
const RED = "#ef4444";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

/** Chip sí/no para flags de configuración (null = desconocido → "no"). */
function YesNoChip({ on, label }: { on: boolean | null | undefined; label: string }) {
  const active = on === true;
  const color = active ? ACCENT : "rgba(128,128,128,0.7)";
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1"
      style={{
        borderRadius: 999,
        color,
        background: active ? "rgba(16,185,129,0.1)" : "rgba(128,128,128,0.08)",
        border: `1px solid ${active ? "rgba(16,185,129,0.3)" : "rgba(128,128,128,0.25)"}`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: color,
          display: "inline-block",
        }}
      />
      {label}: {active ? "sí" : "no"}
    </span>
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

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Ajustes del motor</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Configuración vigente del optimizador — solo lectura; la edición fina vive en el motor por ahora
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
            No pudimos cargar la configuración. {error}
          </div>
        ) : !cfg ? (
          <div className="text-center py-16" style={{ opacity: 0.4 }}>
            <p className="text-lg">Sin configuración disponible.</p>
            <p className="text-sm mt-2">
              El motor todavía no reporta sus ajustes.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Conexión del motor */}
            <div style={{ ...CARD_STYLE, borderLeft: `4px solid ${tokenOk ? ACCENT : RED}` }}>
              <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                Conexión del motor
              </p>
              <p className="text-2xl font-bold mt-2" style={{ color: tokenOk ? ACCENT : RED }}>
                {tokenOk ? "Conectado" : "Desconectado"}
              </p>
              <div className="mt-3 text-sm space-y-1">
                <p>
                  <span style={{ opacity: 0.5 }}>Cuenta Google: </span>
                  <span className="font-medium">{cfg.token_email ?? "—"}</span>
                </p>
                <p>
                  <span style={{ opacity: 0.5 }}>MCC: </span>
                  <span className="font-medium" style={{ fontFamily: "monospace" }}>
                    {cfg.mcc ?? "—"}
                  </span>
                </p>
              </div>
            </div>

            {/* Modelo */}
            <div style={CARD_STYLE}>
              <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                Modelo
              </p>
              <p className="text-2xl font-bold mt-2" style={{ color: ACCENT }}>
                {cfg.llm_model ?? "—"}
              </p>
              <div className="mt-3 text-sm space-y-1">
                <p>
                  <span style={{ opacity: 0.5 }}>Modelo de visión: </span>
                  <span className="font-medium">{cfg.vision_model ?? "—"}</span>
                </p>
              </div>
            </div>

            {/* Notificaciones */}
            <div style={CARD_STYLE}>
              <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                Notificaciones
              </p>
              <p
                className="text-2xl font-bold mt-2"
                style={{ color: cfg.alerts_enabled === true ? ACCENT : "rgba(128,128,128,0.7)" }}
              >
                {cfg.alerts_enabled === true ? "Activadas" : "Desactivadas"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <YesNoChip on={cfg.telegram_configured} label="Telegram" />
                <YesNoChip on={cfg.chat_configured} label="Google Chat" />
              </div>
            </div>

            {/* Cadencia */}
            <div style={CARD_STYLE}>
              <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                Cadencia
              </p>
              <p className="text-2xl font-bold mt-2">
                {cfg.scan_interval_minutes != null && Number.isFinite(cfg.scan_interval_minutes)
                  ? `cada ${fmtNum(cfg.scan_interval_minutes)} min`
                  : "—"}
              </p>
              <div className="mt-3 text-sm space-y-1">
                <p>
                  <span style={{ opacity: 0.5 }}>Resumen diario (digest): </span>
                  <span className="font-medium">
                    {cfg.digest_hour_utc != null && Number.isFinite(cfg.digest_hour_utc)
                      ? `${fmtNum(cfg.digest_hour_utc)}:00 UTC`
                      : "—"}
                  </span>
                </p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
