"use client";

import { useState } from "react";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";

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
}: {
  connections: ConnectionRow[];
  brands: BrandOption[];
  connected: boolean;
  warn: string | null;
  errorParam: string | null;
  loadError: string | null;
}) {
  const { colors } = useTheme();
  const [connections, setConnections] = useState<ConnectionRow[]>(initialConnections);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const cardStyle: React.CSSProperties = {
    background: colors.bgCard,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
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

  const totalAccounts = connections.reduce((n, c) => n + c.accounts.length, 0);
  const enabledAccounts = connections.reduce(
    (n, c) => n + c.accounts.filter((a) => a.enabled === true).length,
    0
  );

  return (
    <div className="min-h-screen">
      <Header breadcrumbs={[{ label: "Conexiones" }]} />

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Hero */}
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Conexiones</h1>
            <p className="mt-2 max-w-2xl" style={{ color: colors.textMuted, lineHeight: 1.6 }}>
              Conecta Google Ads y activa las cuentas que quieres monitorear, una
              por una; mapea cada una a su marca. Solo las cuentas activadas
              alimentan Performance y Seguridad.
            </p>
          </div>
          <a
            href="/api/connections/start"
            style={{
              padding: "10px 18px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              background: colors.accent,
              color: "#fff",
              whiteSpace: "nowrap",
            }}
          >
            Conectar Google Ads
          </a>
        </div>

        {/* Banners */}
        {connected && (
          <div
            className="mb-4"
            style={{
              padding: 14,
              borderRadius: 8,
              background: "rgba(16,185,129,0.1)",
              border: "1px solid rgba(16,185,129,0.3)",
              color: colors.accent,
              fontSize: 14,
            }}
          >
            Cuenta de Google conectada correctamente. Activa abajo las cuentas
            que quieras monitorear y asígnales una marca.
          </div>
        )}
        {warn === "cuentas" && (
          <div
            className="mb-4"
            style={{
              padding: 14,
              borderRadius: 8,
              background: "rgba(251,191,36,0.1)",
              border: "1px solid rgba(251,191,36,0.3)",
              color: "#F59E0B",
              fontSize: 14,
            }}
          >
            La conexión se guardó, pero no pudimos listar tus cuentas de Google
            Ads en este momento. Vuelve a intentarlo más tarde.
          </div>
        )}
        {errorParam && (
          <div
            className="mb-4"
            style={{
              padding: 14,
              borderRadius: 8,
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.3)",
              color: "#F87171",
              fontSize: 14,
            }}
          >
            {errorParam}
          </div>
        )}
        {loadError && (
          <div
            className="mb-4"
            style={{
              padding: 16,
              borderRadius: 8,
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.3)",
              color: "#F87171",
            }}
          >
            {loadError}
          </div>
        )}
        {saveError && (
          <div
            className="mb-4"
            style={{
              padding: 14,
              borderRadius: 8,
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.3)",
              color: "#F87171",
              fontSize: 14,
            }}
          >
            {saveError}
          </div>
        )}

        {/* Summary line */}
        {connections.length > 0 && (
          <p className="mb-4 text-sm" style={{ color: colors.textMuted }}>
            {connections.length}{" "}
            {connections.length === 1 ? "conexión" : "conexiones"} ·{" "}
            {enabledAccounts} de {totalAccounts} cuentas activas
          </p>
        )}

        {/* Empty state */}
        {!loadError && connections.length === 0 && (
          <div style={{ ...cardStyle, padding: 40 }} className="text-center">
            <p className="text-lg font-semibold">
              Aún no has conectado ninguna cuenta de Google Ads.
            </p>
            <p className="text-sm mt-2 mb-6" style={{ color: colors.textMuted }}>
              Pulsa «Conectar Google Ads», autoriza el acceso con tu cuenta de
              Google y aquí aparecerán todas las cuentas a las que tienes
              acceso para que actives las que quieras monitorear.
            </p>
            <a
              href="/api/connections/start"
              style={{
                display: "inline-block",
                padding: "10px 18px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                background: "rgba(16,185,129,0.12)",
                color: colors.accent,
                border: "1px solid rgba(16,185,129,0.3)",
              }}
            >
              Conectar Google Ads
            </a>
          </div>
        )}

        {/* Connections */}
        <div className="space-y-6">
          {connections.map((conn) => (
            <section key={conn.id} style={cardStyle}>
              <div
                className="flex flex-wrap items-center gap-3"
                style={{ padding: "16px 20px", borderBottom: `1px solid ${colors.border}` }}
              >
                <span style={{ fontWeight: 600 }}>
                  {conn.google_email || "Cuenta de Google"}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "2px 8px",
                    borderRadius: 999,
                    letterSpacing: "0.03em",
                    ...(conn.status === "active" || conn.status == null
                      ? {
                          background: "rgba(16,185,129,0.12)",
                          color: colors.accent,
                          border: "1px solid rgba(16,185,129,0.3)",
                        }
                      : {
                          background: "rgba(248,113,113,0.12)",
                          color: "#F87171",
                          border: "1px solid rgba(248,113,113,0.3)",
                        }),
                  }}
                >
                  {conn.status === "active" || conn.status == null ? "Activa" : conn.status}
                </span>
                {conn.is_engine_source === true && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "rgba(128,128,128,0.12)",
                      color: colors.textMuted,
                      border: `1px solid ${colors.border}`,
                    }}
                  >
                    Fuente del optimizador
                  </span>
                )}
                {conn.created_at && (
                  <span style={{ marginLeft: "auto", fontSize: 12, color: colors.textFaint }}>
                    Conectada el {fmtDate(conn.created_at)}
                  </span>
                )}
              </div>

              {conn.accounts.length === 0 ? (
                <p style={{ padding: 20, fontSize: 14, color: colors.textMuted }}>
                  No encontramos cuentas de Google Ads accesibles con este
                  correo. Si te acaban de dar acceso, vuelve a conectar la
                  cuenta para actualizar la lista.
                </p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                    <thead>
                      <tr
                        style={{
                          textAlign: "left",
                          fontSize: 12,
                          color: colors.textMuted,
                          borderBottom: `1px solid ${colors.border}`,
                        }}
                      >
                        <th style={{ padding: "10px 20px", fontWeight: 500 }}>Cuenta</th>
                        <th style={{ padding: "10px 12px", fontWeight: 500 }}>Nombre</th>
                        <th style={{ padding: "10px 12px", fontWeight: 500 }}>Moneda</th>
                        <th style={{ padding: "10px 12px", fontWeight: 500 }}>Monitorear</th>
                        <th style={{ padding: "10px 20px", fontWeight: 500 }}>Marca</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conn.accounts.map((account) => {
                        const enabled = account.enabled === true;
                        const saving = savingId === account.id;
                        return (
                          <tr
                            key={account.id}
                            style={{
                              borderBottom: `1px solid ${colors.border}`,
                              opacity: saving ? 0.6 : 1,
                            }}
                          >
                            <td style={{ padding: "12px 20px", whiteSpace: "nowrap" }}>
                              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                                {fmtCustomerId(account.customer_id)}
                              </span>
                              {account.is_manager === true && (
                                <span
                                  title="Cuenta administradora (MCC)"
                                  style={{
                                    marginLeft: 8,
                                    fontSize: 10,
                                    fontWeight: 700,
                                    padding: "1px 6px",
                                    borderRadius: 4,
                                    background: "rgba(96,165,250,0.15)",
                                    color: "#60A5FA",
                                    border: "1px solid rgba(96,165,250,0.3)",
                                    letterSpacing: "0.05em",
                                  }}
                                >
                                  MCC
                                </span>
                              )}
                            </td>
                            <td style={{ padding: "12px 12px" }}>
                              {account.descriptive_name || (
                                <span style={{ color: colors.textFaint }}>Sin nombre</span>
                              )}
                            </td>
                            <td style={{ padding: "12px 12px", whiteSpace: "nowrap" }}>
                              {account.currency || "—"}
                            </td>
                            <td style={{ padding: "12px 12px" }}>
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
                                  background: enabled ? colors.accent : "rgba(128,128,128,0.35)",
                                  border: "none",
                                  transition: "background 0.15s ease",
                                  flexShrink: 0,
                                }}
                              >
                                <span
                                  style={{
                                    position: "absolute",
                                    top: 3,
                                    left: enabled ? 21 : 3,
                                    width: 16,
                                    height: 16,
                                    borderRadius: "50%",
                                    background: "#fff",
                                    transition: "left 0.15s ease",
                                  }}
                                />
                              </button>
                            </td>
                            <td style={{ padding: "12px 20px" }}>
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
                                  borderRadius: 6,
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
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
