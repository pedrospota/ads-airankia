"use client";

import { useState } from "react";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";
import {
  Badge,
  DataTable,
  THead,
  Row,
  Cell,
  EmptyState,
  ErrorCard,
  PrimaryButton,
  SecondaryButton,
} from "@/components/ui-kit";

// ---------------------------------------------------------------------------
// Types shared with the server page (all fields nullable — render defensively)
// ---------------------------------------------------------------------------

export interface ConnectionAccountRow {
  id: string;
  customer_id: string | null;
  descriptive_name: string | null;
  currency: string | null;
  time_zone: string | null;
  is_manager: boolean | null;
  enabled: boolean | null;
  brand_id: string | null;
}

export interface ConnectionRow {
  id: string;
  google_email: string | null;
  status: string | null;
  is_engine_source: boolean | null;
  created_at: string | null;
  accounts: ConnectionAccountRow[];
}

export interface BrandOption {
  id: string;
  name: string | null;
}

/** Centro de Mando (beta): Meta status card. Null when the beta flag is off. */
export interface MetaStatus {
  configured: boolean;
  accounts: string[];
}

// ---------------------------------------------------------------------------

/** "123-456-7890" from "1234567890" (Google Ads display convention). */
function fmtCustomerId(id: string | null): string {
  if (!id) return "—";
  const digits = id.replace(/\D/g, "");
  if (digits.length !== 10) return id;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

export function ConexionesClient({
  connections: initialConnections,
  brands,
  connected,
  warn,
  errorParam,
  loadError,
  metaStatus,
}: {
  connections: ConnectionRow[];
  brands: BrandOption[];
  connected: boolean;
  warn: string | null;
  errorParam: string | null;
  loadError: string | null;
  metaStatus?: MetaStatus | null;
}) {
  const { colors } = useTheme();
  const [connections, setConnections] = useState<ConnectionRow[]>(initialConnections);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Engine-source bridge state (which connection is being sent to the engine).
  const [engineSavingId, setEngineSavingId] = useState<string | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);

  // Theme-aware button overrides (primary = ink-on-paper, the quiet move).
  const primaryStyle: React.CSSProperties = {
    background: colors.text,
    color: colors.bg,
    border: `1px solid ${colors.text}`,
  };
  const secondaryStyle: React.CSSProperties = {
    background: "transparent",
    color: colors.text,
    border: `1px solid ${colors.border}`,
  };

  const cardStyle: React.CSSProperties = {
    background: colors.bgCard,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
  };

  const cellTheme: React.CSSProperties = {
    color: colors.text,
    borderBottom: `1px solid ${colors.border}`,
  };

  function patchAccount(accountId: string, patch: Partial<ConnectionAccountRow>) {
    setConnections((prev) =>
      prev.map((c) => ({
        ...c,
        accounts: c.accounts.map((a) => (a.id === accountId ? { ...a, ...patch } : a)),
      }))
    );
  }

  async function saveAccount(
    account: ConnectionAccountRow,
    patch: { enabled?: boolean; brand_id?: string | null }
  ) {
    const previous: Partial<ConnectionAccountRow> = {
      enabled: account.enabled,
      brand_id: account.brand_id,
    };
    // Optimistic update; revert on failure.
    patchAccount(account.id, patch);
    setSavingId(account.id);
    setSaveError(null);
    try {
      const res = await fetch("/api/connections/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: account.id, ...patch }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Error ${res.status}`);
      }
    } catch (e) {
      patchAccount(account.id, previous);
      setSaveError(
        e instanceof Error ? e.message : "No se pudo guardar el cambio. Vuelve a intentarlo."
      );
    } finally {
      setSavingId(null);
    }
  }

  // F4 bridge: hand this connection's token to the optimizer engine so it
  // scans with it (read-only). Only one connection per workspace is the source.
  async function makeEngineSource(conn: ConnectionRow) {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "El motor escaneará con esta conexión (solo lectura).\n\n" +
          `¿Usar ${conn.google_email || "esta conexión"} como fuente del motor?`
      )
    ) {
      return;
    }
    setEngineSavingId(conn.id);
    setEngineError(null);
    try {
      const res = await fetch("/api/connections/engine-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: conn.id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Error ${res.status}`);
      }
      // Done state: this connection is the source; its siblings are not.
      setConnections((prev) =>
        prev.map((c) => ({ ...c, is_engine_source: c.id === conn.id }))
      );
    } catch (e) {
      setEngineError(
        e instanceof Error
          ? e.message
          : "No se pudo configurar la fuente del motor. Vuelve a intentarlo."
      );
    } finally {
      setEngineSavingId(null);
    }
  }

  const totalAccounts = connections.reduce((n, c) => n + c.accounts.length, 0);
  const enabledAccounts = connections.reduce(
    (n, c) => n + c.accounts.filter((a) => a.enabled === true).length,
    0
  );

  return (
    <div>
      <Header breadcrumbs={[{ label: "Conexiones" }]} />

      <main style={{ marginTop: 24 }}>
        {/* Page header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 32,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h1
              style={{
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                lineHeight: 1.25,
                color: colors.text,
                margin: 0,
              }}
            >
              Conexiones
            </h1>
            <p
              style={{
                fontSize: 13.5,
                color: colors.textMuted,
                margin: "6px 0 0",
                lineHeight: 1.5,
                maxWidth: 620,
              }}
            >
              Conecta Google Ads y activa las cuentas que quieres monitorear, una
              por una; mapea cada una a su marca. Solo las cuentas activadas
              alimentan Performance y Seguridad.
            </p>
          </div>
          <PrimaryButton href="/api/connections/start" style={primaryStyle}>
            Conectar Google Ads
          </PrimaryButton>
        </div>

        {/* Banners */}
        {connected && (
          <div
            style={{
              marginBottom: 16,
              padding: "12px 16px",
              borderRadius: 12,
              background: "rgba(16,185,129,0.06)",
              border: "1px solid rgba(16,185,129,0.35)",
              color: colors.accent,
              fontSize: 13.5,
              lineHeight: 1.5,
            }}
          >
            Cuenta de Google conectada correctamente. Activa abajo las cuentas
            que quieras monitorear y asígnales una marca.
          </div>
        )}
        {warn === "cuentas" && (
          <div
            style={{
              marginBottom: 16,
              padding: "12px 16px",
              borderRadius: 12,
              background: "rgba(245,158,11,0.06)",
              border: "1px solid rgba(245,158,11,0.35)",
              color: colors.warn,
              fontSize: 13.5,
              lineHeight: 1.5,
            }}
          >
            La conexión se guardó, pero no pudimos listar tus cuentas de Google
            Ads en este momento. Vuelve a intentarlo más tarde.
          </div>
        )}
        {errorParam && <ErrorCard message={errorParam} style={{ marginBottom: 16 }} />}
        {loadError && <ErrorCard message={loadError} style={{ marginBottom: 16 }} />}
        {saveError && <ErrorCard message={saveError} style={{ marginBottom: 16 }} />}
        {engineError && <ErrorCard message={engineError} style={{ marginBottom: 16 }} />}

        {/* Summary line */}
        {connections.length > 0 && (
          <p
            style={{
              marginBottom: 16,
              fontSize: 13,
              color: colors.textMuted,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {connections.length}{" "}
            {connections.length === 1 ? "conexión" : "conexiones"} ·{" "}
            {enabledAccounts} de {totalAccounts} cuentas activas
          </p>
        )}

        {/* Empty state */}
        {!loadError && connections.length === 0 && (
          <div style={cardStyle}>
            <EmptyState
              title="Aún no has conectado ninguna cuenta de Google Ads"
              hint="Pulsa «Conectar Google Ads», autoriza el acceso con tu cuenta de Google y aquí aparecerán todas las cuentas a las que tienes acceso para que actives las que quieras monitorear."
              action={
                <SecondaryButton href="/api/connections/start" style={secondaryStyle}>
                  Conectar Google Ads
                </SecondaryButton>
              }
            />
          </div>
        )}

        {/* Connections */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {connections.map((conn) => {
            const engineSaving = engineSavingId === conn.id;
            return (
              <section key={conn.id} style={{ ...cardStyle, overflow: "hidden" }}>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 10,
                    padding: "16px 20px",
                    borderBottom: `1px solid ${colors.border}`,
                  }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: 550, color: colors.text }}>
                    {conn.google_email || "Cuenta de Google"}
                  </span>
                  <Badge tone={conn.status === "active" || conn.status == null ? "ok" : "danger"}>
                    {conn.status === "active" || conn.status == null ? "Activa" : conn.status}
                  </Badge>
                  {conn.is_engine_source === true ? (
                    <>
                      <Badge tone="accent">Fuente del motor</Badge>
                      <span style={{ fontSize: 12, color: colors.textFaint }}>
                        El motor escaneará con esta conexión (solo lectura).
                      </span>
                    </>
                  ) : (
                    <SecondaryButton
                      onClick={() => makeEngineSource(conn)}
                      disabled={engineSaving}
                      title="El motor escaneará con esta conexión (solo lectura)."
                      style={{ ...secondaryStyle, padding: "5px 10px", fontSize: 12.5 }}
                    >
                      {engineSaving ? "Configurando…" : "Usar como fuente del motor"}
                    </SecondaryButton>
                  )}
                  {conn.created_at && (
                    <span
                      style={{ marginLeft: "auto", fontSize: 12, color: colors.textFaint }}
                    >
                      Conectada el {fmtDate(conn.created_at)}
                    </span>
                  )}
                </div>

                {conn.accounts.length === 0 ? (
                  <p style={{ padding: 20, fontSize: 13.5, color: colors.textMuted, margin: 0 }}>
                    No encontramos cuentas de Google Ads accesibles con este
                    correo. Si te acaban de dar acceso, vuelve a conectar la
                    cuenta para actualizar la lista.
                  </p>
                ) : (
                  <>
                    {/* Theme-aware row hover (overrides the kit's dark default). */}
                    <style>{`.uik-row:hover td{background:${colors.hover} !important;}`}</style>
                    <DataTable>
                      <THead
                        cols={[
                          { label: "Cuenta", width: 170 },
                          { label: "Nombre" },
                          { label: "Moneda", width: 90 },
                          { label: "Monitorear", width: 110 },
                          { label: "Marca", width: 200 },
                        ]}
                      />
                      <tbody>
                        {conn.accounts.map((account) => {
                          const enabled = account.enabled === true;
                          const saving = savingId === account.id;
                          return (
                            <Row
                              key={account.id}
                              style={{ opacity: saving ? 0.6 : 1 }}
                            >
                              <Cell mono style={{ ...cellTheme, whiteSpace: "nowrap" }}>
                                {fmtCustomerId(account.customer_id)}
                                {account.is_manager === true && (
                                  <Badge
                                    tone="muted"
                                    style={{ marginLeft: 8 }}
                                  >
                                    MCC
                                  </Badge>
                                )}
                              </Cell>
                              <Cell style={cellTheme}>
                                {account.descriptive_name || (
                                  <span style={{ color: colors.textFaint }}>Sin nombre</span>
                                )}
                              </Cell>
                              <Cell style={{ ...cellTheme, whiteSpace: "nowrap" }}>
                                {account.currency || "—"}
                              </Cell>
                              <Cell style={cellTheme}>
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={enabled}
                                  disabled={saving}
                                  onClick={() => saveAccount(account, { enabled: !enabled })}
                                  title={enabled ? "Dejar de monitorear" : "Activar monitoreo"}
                                  style={{
                                    width: 40,
                                    height: 22,
                                    borderRadius: 999,
                                    position: "relative",
                                    cursor: saving ? "wait" : "pointer",
                                    background: enabled ? colors.accent : colors.surface2,
                                    border: `1px solid ${enabled ? colors.accent : colors.border}`,
                                    transition: "background 0.15s ease",
                                    flexShrink: 0,
                                    padding: 0,
                                  }}
                                >
                                  <span
                                    style={{
                                      position: "absolute",
                                      top: 2,
                                      left: enabled ? 20 : 2,
                                      width: 16,
                                      height: 16,
                                      borderRadius: "50%",
                                      background: "#fff",
                                      transition: "left 0.15s ease",
                                    }}
                                  />
                                </button>
                              </Cell>
                              <Cell style={cellTheme}>
                                <select
                                  value={account.brand_id ?? ""}
                                  disabled={saving}
                                  onChange={(e) =>
                                    saveAccount(account, {
                                      brand_id: e.target.value || null,
                                    })
                                  }
                                  style={{
                                    padding: "6px 10px",
                                    borderRadius: 8,
                                    fontSize: 13,
                                    minWidth: 160,
                                    background: colors.bgInput,
                                    color: colors.text,
                                    border: `1px solid ${colors.border}`,
                                  }}
                                >
                                  <option value="">Sin marca</option>
                                  {brands.map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.name || b.id}
                                    </option>
                                  ))}
                                </select>
                              </Cell>
                            </Row>
                          );
                        })}
                      </tbody>
                    </DataTable>
                  </>
                )}
              </section>
            );
          })}
        </div>

        {metaStatus && (
          <section
            style={{
              marginTop: 32,
              padding: 20,
              borderRadius: 12,
              border: `1px solid ${colors.border}`,
              background: colors.bgCard,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: colors.textMuted,
                }}
              >
                Meta Ads · Centro de Mando (beta)
              </span>
              <Badge tone={metaStatus.configured ? "ok" : "muted"} dot>
                {metaStatus.configured ? "Token de sistema configurado" : "Pendiente de credenciales"}
              </Badge>
            </div>
            <p style={{ color: colors.textMuted, fontSize: 13, marginTop: 10, marginBottom: 0 }}>
              {metaStatus.configured
                ? `${metaStatus.accounts.length} cuenta(s) permitida(s)${
                    metaStatus.accounts.length ? ": " + metaStatus.accounts.join(", ") : ""
                  }.`
                : "Configura META_SYSTEM_USER_TOKEN y META_AD_ACCOUNT_IDS en el servidor para habilitar lectura y ejecución en Meta desde el Centro de Mando."}
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
