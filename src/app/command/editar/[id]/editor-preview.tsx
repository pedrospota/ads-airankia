"use client";

// LEFT live tree (campaign → ad groups → keywords/ads, with en-vivo/editado/nuevo
// badges + "Cargado hace N min" + Recargar) + RIGHT rail (SERP preview of the
// selected/replacement ad, running "N cambios" counter, ACTIVE-campaign banner).
// Pure presentational except LiveTree's own "re-render every minute" ticker — all
// doc state lives in editor-client.tsx. Mirrors crear/builder-preview.tsx's role.

import { useEffect, useState } from "react";
import { Badge, Card, EmptyState, ErrorCard, SecondaryButton, SectionLabel, StatCard, UI } from "@/components/ui-kit";
import type { GoogleSearchEditDoc } from "@/lib/command/edit/schema";
import { SerpPreview } from "../../crear/builder-preview";
import { initialBuilderState } from "../../crear/builder-types";
import {
  adGroupTone,
  adTone,
  campaignTone,
  keywordsTone,
  minutesSince,
  sameSelection,
  type EditAd,
  type NodeSelection,
  type NodeTone,
} from "./editor-types";

/* ---------------------------------------------------------------------------
 * LEFT — live tree
 * ------------------------------------------------------------------------- */

const TONE_BADGE: Record<NodeTone, { label: string; tone: "muted" | "warn" | "ok" }> = {
  "en-vivo": { label: "en vivo", tone: "muted" },
  editado: { label: "editado", tone: "warn" },
  nuevo: { label: "nuevo", tone: "ok" },
};

function ToneBadge({ tone }: { tone: NodeTone }) {
  const b = TONE_BADGE[tone];
  return (
    <Badge tone={b.tone} dot>
      {b.label}
    </Badge>
  );
}

function TreeRow({
  label,
  tone,
  active,
  indent = 0,
  locked = false,
  onClick,
}: {
  label: string;
  tone: NodeTone;
  active: boolean;
  indent?: number;
  locked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        width: "100%",
        textAlign: "left",
        background: active ? UI.accentSoft : "none",
        border: 0,
        borderRadius: 6,
        padding: `6px 8px 6px ${8 + indent * 16}px`,
        fontSize: indent === 0 ? 13.5 : 12.5,
        fontWeight: indent === 0 ? 600 : 400,
        color: active ? UI.text : UI.muted,
        cursor: "pointer",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
        {locked ? <span style={{ color: UI.faint }}> · no compatible</span> : null}
      </span>
      <ToneBadge tone={tone} />
    </button>
  );
}

export function LiveTree({
  doc,
  selected,
  onSelect,
  onReload,
  reloading,
  reloadError,
}: {
  doc: GoogleSearchEditDoc;
  selected: NodeSelection;
  onSelect: (s: NodeSelection) => void;
  onReload: () => void;
  reloading: boolean;
  reloadError: string | null;
}) {
  // Re-render every minute so "Cargado hace N min" stays accurate without a full refresh.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const c = doc.campaign;
  const mins = minutesSince(doc.loadedAt);
  const isSel = (s: NodeSelection) => sameSelection(s, selected);

  return (
    <Card style={{ position: "sticky", top: 16, padding: 20 }}>
      <SectionLabel style={{ marginBottom: 4 }}>Árbol en vivo</SectionLabel>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8 }}>
        <span style={{ fontSize: 11.5, color: UI.faint }}>Cargado hace {mins} min</span>
        <SecondaryButton onClick={onReload} disabled={reloading}>
          {reloading ? "Recargando…" : "Recargar"}
        </SecondaryButton>
      </div>
      {reloadError ? <ErrorCard message={reloadError} style={{ marginBottom: 12, fontSize: 12.5, padding: "10px 12px" }} /> : null}

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <li>
          <TreeRow label={c.base.name || "Campaña"} tone={campaignTone(doc)} active={isSel({ kind: "campaign" })} onClick={() => onSelect({ kind: "campaign" })} />
        </li>
        {c.adGroups.map((g) => (
          <li key={g.resourceName}>
            <TreeRow
              label={g.base.name || "Grupo de anuncios"}
              tone={adGroupTone(g)}
              active={isSel({ kind: "adGroup", groupRef: g.resourceName })}
              indent={1}
              onClick={() => onSelect({ kind: "adGroup", groupRef: g.resourceName })}
            />
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              <li>
                <TreeRow
                  label="Palabras clave"
                  tone={keywordsTone(g)}
                  active={isSel({ kind: "keywords", groupRef: g.resourceName })}
                  indent={2}
                  onClick={() => onSelect({ kind: "keywords", groupRef: g.resourceName })}
                />
              </li>
              {g.ads.map((a) => (
                <li key={a.resourceName}>
                  <TreeRow
                    label={a.base.headlines[0]?.text?.trim() || "Anuncio"}
                    tone={adTone(a)}
                    active={isSel({ kind: "ad", groupRef: g.resourceName, adRef: a.resourceName })}
                    indent={2}
                    locked={a.unsupported}
                    onClick={() => onSelect({ kind: "ad", groupRef: g.resourceName, adRef: a.resourceName })}
                  />
                </li>
              ))}
              {g.newAds.map((na) => (
                <li key={na.tempId}>
                  <TreeRow
                    label={na.headlines[0]?.text?.trim() || "Anuncio nuevo"}
                    tone="nuevo"
                    active={isSel({ kind: "newAd", groupRef: g.resourceName, tempId: na.tempId })}
                    indent={2}
                    onClick={() => onSelect({ kind: "newAd", groupRef: g.resourceName, tempId: na.tempId })}
                  />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * RIGHT — SERP preview, diff counter, ACTIVE banner
 * ------------------------------------------------------------------------- */

export function ActiveBanner() {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        fontSize: 12.5,
        color: UI.text,
        border: `1px dashed ${UI.warn}`,
        borderRadius: UI.radiusSm,
        padding: "9px 12px",
        background: `color-mix(in srgb, ${UI.warn} 8%, transparent)`,
      }}
    >
      <span style={{ color: UI.warn, fontWeight: 700, fontSize: 11, letterSpacing: "0.06em", flexShrink: 0 }}>ACTIVA</span>
      <span>Editando una campaña ACTIVA — los cambios aplican de inmediato al publicar.</span>
    </div>
  );
}

export function DiffSummary({ n }: { n: number }) {
  return (
    <StatCard
      label="Cambios pendientes"
      value={`${n} cambio${n === 1 ? "" : "s"}`}
      sub={n === 0 ? "Sin cambios" : "Se aplicarán al publicar la revisión"}
      tone={n > 0 ? "warn" : "muted"}
    />
  );
}

/** Resolves the ad whose text should drive the SERP preview for the current selection:
 * an existing ad's replacement (if drafted) else its live base, or a newAd draft. */
function activeAdOf(doc: GoogleSearchEditDoc, selected: NodeSelection): EditAd["base"] | EditAd["replacement"] | null {
  if (selected.kind === "ad") {
    const g = doc.campaign.adGroups.find((g) => g.resourceName === selected.groupRef);
    const a = g?.ads.find((a) => a.resourceName === selected.adRef);
    if (!a || a.unsupported) return null;
    return a.replacement ?? a.base;
  }
  if (selected.kind === "newAd") {
    const g = doc.campaign.adGroups.find((g) => g.resourceName === selected.groupRef);
    return g?.newAds.find((a) => a.tempId === selected.tempId) ?? null;
  }
  return null;
}

export function AdSerpPreview({ doc, selected }: { doc: GoogleSearchEditDoc; selected: NodeSelection }) {
  const ad = activeAdOf(doc, selected);
  if (!ad) {
    return (
      <Card style={{ padding: 20 }}>
        <SectionLabel style={{ marginBottom: 12 }}>Así se verá tu anuncio</SectionLabel>
        <EmptyState title="Selecciona un anuncio" hint="Elige un anuncio del árbol a la izquierda para previsualizarlo." />
      </Card>
    );
  }
  const state = {
    ...initialBuilderState(null),
    headlines: ad.headlines.map((h) => h.text),
    descriptions: ad.descriptions.map((d) => d.text),
    finalUrl: ad.finalUrl ?? "",
  };
  return <SerpPreview state={state} />;
}
