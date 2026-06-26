"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";

// One row in the Search campaigns list. Built server-side in page.tsx.
export interface CampaignListItem {
  campaignId: string;
  runId: string | null;
  displayName: string;
  campaignStatus: string; // draft | active | paused | exhausted | stopped
  runStatus: string | null; // queued|running|awaiting_approval|completed|failed|aborted
  googleCampaignId: string | null;
  dailyBudgetCents: number | null;
  landingPageUrl: string | null;
  createdAt: string | null; // ISO
  deepLink: string | null;
}

interface DashboardProps {
  brandId: string;
  brandName: string;
  items: CampaignListItem[];
}

// Symbol shown next to budgets (display only; Google charges in account currency).
const CURRENCY = "€";

interface StatusInfo {
  label: string;
  color: string;
  bg: string;
  /** What the main button says for this state. */
  action: string;
}

// Friendly, plain-Spanish status derived from the campaign + run state.
function statusFor(item: CampaignListItem): StatusInfo {
  const inGoogle = item.googleCampaignId != null;
  if (inGoogle && item.campaignStatus === "active") {
    return {
      label: "Activa",
      color: "#10B981",
      bg: "rgba(16,185,129,0.12)",
      action: "Ver detalles",
    };
  }
  if (inGoogle) {
    // Created in Google but not enabled (paused / draft row).
    return {
      label: "Creada · en pausa",
      color: "#FBBF24",
      bg: "rgba(251,191,36,0.12)",
      action: "Ver y poner en marcha",
    };
  }
  // Not in Google yet → still being built or unfinished.
  if (item.runStatus === "running" || item.runStatus === "queued") {
    return {
      label: "Creándose…",
      color: "#3B82F6",
      bg: "rgba(59,130,246,0.12)",
      action: "Continuar",
    };
  }
  if (item.runStatus === "awaiting_approval") {
    return {
      label: "Esperando tu revisión",
      color: "#3B82F6",
      bg: "rgba(59,130,246,0.12)",
      action: "Revisar",
    };
  }
  if (item.runStatus === "failed" || item.runStatus === "aborted") {
    return {
      label: "Sin terminar",
      color: "#F87171",
      bg: "rgba(248,113,113,0.12)",
      action: "Retomar",
    };
  }
  // Completed-but-not-activated, or a fresh draft.
  return {
    label: "Pendiente de activar",
    color: "#FBBF24",
    bg: "rgba(251,191,36,0.12)",
    action: "Revisar y activar",
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("es-ES", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export function CampaignsDashboard({ brandId, brandName, items }: DashboardProps) {
  const { colors } = useTheme();
  const router = useRouter();
  const newHref = `/brands/${brandId}/campaigns/new/search`;

  // Which campaign (by run id) is currently being discarded.
  const [discardingId, setDiscardingId] = useState<string | null>(null);

  // Discard / undo: safe at any time because Search campaigns are created
  // PAUSED and never spend. Removes it from Google (if it got there) and drops
  // it from this list. The end user is the one clicking, so this is the only
  // place that touches their account from the dashboard.
  async function discard(runId: string) {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Vamos a eliminar esta campaña de tu cuenta de Google Ads.\n\nNo se ha gastado nada (estaba en pausa) y podrás crear otra cuando quieras.\n\n¿Seguro que quieres descartarla?",
      )
    ) {
      return;
    }
    setDiscardingId(runId);
    try {
      const r = await fetch(`/api/search/runs/${runId}/discard`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !data.ok) {
        throw new Error(data.error || "No se pudo descartar la campaña.");
      }
      router.refresh();
    } catch (e) {
      if (typeof window !== "undefined") {
        window.alert(
          e instanceof Error ? e.message : "No se pudo descartar la campaña.",
        );
      }
    } finally {
      setDiscardingId(null);
    }
  }

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Marcas", href: "/brands" },
          { label: brandName, href: `/brands/${brandId}/citations` },
          { label: "Campañas" },
        ]}
        action={
          <Link
            href={newHref}
            style={{
              padding: "8px 16px",
              borderRadius: 10,
              background: colors.accent,
              color: "#000",
              fontWeight: 700,
              fontSize: 13,
              textDecoration: "none",
            }}
          >
            + Nueva campaña
          </Link>
        }
      />

      <main className="max-w-3xl mx-auto px-6 py-8">
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
            Tus campañas de Búsqueda
          </h1>
          <p style={{ fontSize: 14, color: colors.textMuted }}>
            Aquí ves todas tus campañas y en qué punto está cada una. Puedes
            volver cuando quieras para revisarlas, ponerlas en marcha o seguir
            una que dejaste a medias.
          </p>
        </div>

        {items.length === 0 ? (
          <div
            style={{
              background: colors.bgCard,
              border: `1px solid ${colors.border}`,
              borderRadius: 14,
              padding: 40,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 12 }}>🚀</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
              Todavía no tienes campañas
            </h2>
            <p
              style={{
                fontSize: 14,
                color: colors.textMuted,
                marginBottom: 20,
                maxWidth: 380,
                marginLeft: "auto",
                marginRight: "auto",
              }}
            >
              Crea tu primera campaña en unos minutos. Nosotros nos encargamos de
              todo y la dejamos en pausa para que tú decidas cuándo arrancar.
            </p>
            <Link
              href={newHref}
              style={{
                display: "inline-block",
                padding: "11px 22px",
                borderRadius: 10,
                background: colors.accent,
                color: "#000",
                fontWeight: 700,
                fontSize: 14,
                textDecoration: "none",
              }}
            >
              Crear mi primera campaña
            </Link>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {items.map((item) => {
              const s = statusFor(item);
              const resumeHref = item.runId
                ? `${newHref}?run=${item.runId}`
                : newHref;
              return (
                <div
                  key={item.campaignId}
                  style={{
                    background: colors.bgCard,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 14,
                    padding: 18,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                      marginBottom: 10,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <h3
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          marginBottom: 4,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.displayName}
                      </h3>
                      <p style={{ fontSize: 12.5, color: colors.textFaint }}>
                        {formatDate(item.createdAt)}
                        {item.dailyBudgetCents != null
                          ? ` · ${CURRENCY}${(item.dailyBudgetCents / 100).toFixed(
                              2
                            )}/día`
                          : ""}
                      </p>
                    </div>
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: 11.5,
                        fontWeight: 600,
                        padding: "4px 10px",
                        borderRadius: 999,
                        color: s.color,
                        background: s.bg,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.label}
                    </span>
                  </div>

                  {item.landingPageUrl && (
                    <p
                      style={{
                        fontSize: 12.5,
                        color: colors.textMuted,
                        marginBottom: 14,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      🔗 {item.landingPageUrl}
                    </p>
                  )}

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <Link
                      href={resumeHref}
                      style={{
                        padding: "8px 16px",
                        borderRadius: 9,
                        background: "transparent",
                        border: `1px solid ${colors.accent}`,
                        color: colors.accent,
                        fontWeight: 600,
                        fontSize: 13,
                        textDecoration: "none",
                      }}
                    >
                      {s.action}
                    </Link>
                    {item.deepLink && (
                      <a
                        href={item.deepLink}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          padding: "8px 16px",
                          borderRadius: 9,
                          background: "transparent",
                          border: `1px solid ${colors.border}`,
                          color: colors.text,
                          fontWeight: 600,
                          fontSize: 13,
                          textDecoration: "none",
                        }}
                      >
                        Ver en Google Ads ↗
                      </a>
                    )}
                    {item.runId && item.campaignStatus !== "active" && (
                      <button
                        onClick={() => discard(item.runId!)}
                        disabled={discardingId === item.runId}
                        style={{
                          marginLeft: "auto",
                          padding: "8px 12px",
                          borderRadius: 9,
                          background: "transparent",
                          border: "none",
                          color: colors.textFaint,
                          fontWeight: 600,
                          fontSize: 12.5,
                          textDecoration: "underline",
                          cursor:
                            discardingId === item.runId
                              ? "not-allowed"
                              : "pointer",
                        }}
                      >
                        {discardingId === item.runId
                          ? "Descartando…"
                          : "Descartar"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
