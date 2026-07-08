"use client";

// Command Center v2.4 "Copiloto Anclado" — the proposal card (spec §c). Purely
// presentational + read-only diffing: it never calls applyBlueprintPatch itself — accepting
// delegates to the dock's `onAccept`/`onReject` callbacks, which own the actual patch
// application (copiloto-dock.tsx) against the SAME chokepoint the builder/editor use. That
// keeps this file's import surface to patch/schema (types + resolveNode) + ui-kit + the
// isomorphic `@/lib/command/types` constant, never executor/gates/actions-repo.
//
// Rendering contract (spec §c): summary + node breadcrumb; per-op old→new rows read from the
// LIVE doc at render time (never the proposal-time snapshot — the doc may have moved since);
// array fields collapse to +N/−N chips; "Por qué: …" is plain text (React text nodes are
// never HTML-interpreted — this is the copilot's one direct text surface, never markdown).
// One-shot: `status` is owned by the dock (a shared map so the collapsed pill's violet dot
// can reflect "any card still pending" without each card holding its own hidden state).

import { MICROS_PER_UNIT } from "@/lib/command/types";
import { resolveNode } from "@/lib/command/patch/schema";
import type { PatchTarget } from "@/lib/command/patch/apply";
import type { Proposal } from "@/lib/command/patch/tool-executors";
import { Badge, UI } from "@/components/ui-kit";

export type ProposalCardStatus = "pending" | "accepted" | "rejected" | "stale";

const FIELD_LABEL: Record<string, string> = {
  name: "Nombre",
  bidding: "Puja",
  geo: "Ubicación",
  languageCode: "Idioma",
  dailyMicros: "Presupuesto diario",
  cpcMicros: "CPC máx.",
  keywords: "Palabras clave",
  negatives: "Negativas",
  finalUrl: "URL final",
  headlines: "Títulos",
  descriptions: "Descripciones",
  path1: "Ruta 1",
  path2: "Ruta 2",
  "desired.status": "Estado",
  "desired.dailyBudgetMicros": "Presupuesto diario",
  "desired.cpcBidMicros": "CPC máx.",
  newNegatives: "Negativas nuevas",
  removeNegatives: "Negativas a quitar",
  newKeywords: "Palabras clave nuevas",
  newAds: "Anuncios nuevos",
  desiredStatus: "Estado deseado",
  replacement: "Reemplazo de anuncio",
};

function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

/** Node breadcrumb — a display-only counterpart to resolveNode's identity resolution, never a
 * second source of truth for WHICH nodes are writable (that's WRITABLE_FIELDS, enforced only
 * by applyBlueprintPatch). Falls back to the raw nodeId if the node has since vanished from
 * the live doc (the exact case Accept's stale-node re-validation also catches). */
function describeNode(target: PatchTarget, nodeId: string): string {
  const resolved = resolveNode(target.doc, nodeId);
  if (!resolved) return nodeId;
  if (target.docKind === "google_create") {
    const c = target.doc.campaign;
    if (resolved.kind === "campaign") return "Campaña";
    if (resolved.kind === "budget") return "Presupuesto";
    if (resolved.kind === "adGroup") {
      const ag = c.adGroups.find((a) => a.nodeId === resolved.canonicalId);
      return `Grupo — ${ag?.name.trim() || "sin nombre"}`;
    }
    if (resolved.kind === "ad") return "Anuncio";
    return nodeId;
  }
  const c = target.doc.campaign;
  if (resolved.kind === "campaign") return "Campaña";
  if (resolved.kind === "adGroup") {
    const ag = c.adGroups.find((a) => a.resourceName === resolved.canonicalId);
    return `Grupo — ${ag?.base.name || "sin nombre"}`;
  }
  if (resolved.kind === "baseKeyword") {
    for (const ag of c.adGroups) {
      const kw = ag.baseKeywords.find((k) => k.resourceName === resolved.canonicalId);
      if (kw) return `Palabra clave — ${kw.text}`;
    }
    return "Palabra clave";
  }
  if (resolved.kind === "ad") return "Anuncio";
  return nodeId;
}

/** Read-only counterpart to apply.ts's writeOp — never a write path, just what the old→new
 * row shows for "old" at render time. Kept in sync with WRITABLE_FIELDS by hand (mirrors the
 * same tradeoff editor-types.ts's countEdits documents for edit/diff.ts). */
function readFieldValue(target: PatchTarget, nodeId: string, field: string): unknown {
  const resolved = resolveNode(target.doc, nodeId);
  if (!resolved) return undefined;
  if (target.docKind === "google_create") {
    const c = target.doc.campaign;
    if (resolved.kind === "campaign") return (c as unknown as Record<string, unknown>)[field];
    if (resolved.kind === "budget") return (c.budget as unknown as Record<string, unknown>)[field];
    if (resolved.kind === "adGroup") {
      const ag = c.adGroups.find((a) => a.nodeId === resolved.canonicalId);
      return ag ? (ag as unknown as Record<string, unknown>)[field] : undefined;
    }
    if (resolved.kind === "ad") {
      for (const ag of c.adGroups) {
        const ad = ag.ads.find((a) => a.nodeId === resolved.canonicalId);
        if (ad) return (ad as unknown as Record<string, unknown>)[field];
      }
    }
    return undefined;
  }
  const c = target.doc.campaign;
  if (resolved.kind === "campaign") {
    if (field === "desired.status") return c.desired.status;
    if (field === "desired.dailyBudgetMicros") return c.desired.dailyBudgetMicros;
    if (field === "newNegatives") return c.newNegatives;
    if (field === "removeNegatives") return c.removeNegatives;
    return undefined;
  }
  if (resolved.kind === "adGroup") {
    const ag = c.adGroups.find((a) => a.resourceName === resolved.canonicalId);
    if (!ag) return undefined;
    if (field === "desired.status") return ag.desired.status;
    if (field === "desired.cpcBidMicros") return ag.desired.cpcBidMicros;
    if (field === "newKeywords") return ag.newKeywords;
    if (field === "newAds") return ag.newAds;
    return undefined;
  }
  if (resolved.kind === "baseKeyword") {
    for (const ag of c.adGroups) {
      const row = ag.baseKeywords.find((k) => k.resourceName === resolved.canonicalId);
      if (row) return field === "desiredStatus" ? row.desiredStatus : undefined;
    }
    return undefined;
  }
  if (resolved.kind === "ad") {
    for (const ag of c.adGroups) {
      const ad = ag.ads.find((a) => a.resourceName === resolved.canonicalId);
      if (ad) return field === "replacement" ? ad.replacement : undefined;
    }
  }
  return undefined;
}

function money(micros: number): string {
  return (micros / MICROS_PER_UNIT).toFixed(2);
}

function renderScalar(field: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "number") return /Micros$/.test(field) ? money(value) : String(value);
  if (typeof value === "string") return value.trim() || "—";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "—";
    }
  }
  return String(value);
}

/** Multiset delta — arrays render as +N/−N chips (spec §c), never an item-by-item dump. */
function arrayDelta(oldArr: unknown[], newArr: unknown[]): { added: number; removed: number } {
  const count = (arr: unknown[]) => {
    const m = new Map<string, number>();
    for (const v of arr) {
      const k = JSON.stringify(v);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const oldM = count(oldArr);
  const newM = count(newArr);
  let added = 0;
  let removed = 0;
  for (const k of new Set([...oldM.keys(), ...newM.keys()])) {
    const delta = (newM.get(k) ?? 0) - (oldM.get(k) ?? 0);
    if (delta > 0) added += delta;
    else if (delta < 0) removed += -delta;
  }
  return { added, removed };
}

function OpRow({ target, nodeId, field, value, rationale }: { target: PatchTarget; nodeId: string; field: string; value: unknown; rationale: string }) {
  const oldValue = readFieldValue(target, nodeId, field);
  const isArray = Array.isArray(value) || Array.isArray(oldValue);
  return (
    <div style={{ padding: "10px 0", borderBottom: `1px solid ${UI.border}` }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: UI.text, marginBottom: 4 }}>{fieldLabel(field)}</div>
      {isArray ? (
        (() => {
          const { added, removed } = arrayDelta(Array.isArray(oldValue) ? oldValue : [], Array.isArray(value) ? value : []);
          return (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {added > 0 ? <Badge tone="accent">+{added}</Badge> : null}
              {removed > 0 ? <Badge tone="danger">−{removed}</Badge> : null}
              {added === 0 && removed === 0 ? <span style={{ fontSize: 12, color: UI.faint }}>sin cambios</span> : null}
            </div>
          );
        })()
      ) : (
        <div style={{ fontSize: 12.5, color: UI.muted, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ textDecoration: "line-through", opacity: 0.7 }}>{renderScalar(field, oldValue)}</span>
          <span aria-hidden="true">→</span>
          <span style={{ color: UI.text, fontWeight: 500 }}>{renderScalar(field, value)}</span>
        </div>
      )}
      <p style={{ fontSize: 11.5, color: UI.faint, margin: "6px 0 0" }}>Por qué: {rationale}</p>
    </div>
  );
}

export function CopilotoProposalCard({
  proposal,
  target,
  status,
  onAccept,
  onReject,
  onSelectNode,
}: {
  proposal: Proposal;
  /** The docKind lives on `target.docKind` — never a separate prop that could drift from it. */
  target: PatchTarget;
  status: ProposalCardStatus;
  onAccept: () => void;
  onReject: () => void;
  onSelectNode?: (nodeId: string) => void;
}) {
  const nodeIds = Array.from(new Set(proposal.ops.map((op) => op.nodeId)));
  const breadcrumb = nodeIds.map((id) => describeNode(target, id)).join(" · ");
  const rationaleByKey = new Map(proposal.rationale.map((r) => [`${r.nodeId}:${r.field}`, r.rationale]));

  return (
    <div
      style={{
        border: `1px solid ${status === "stale" ? UI.danger : UI.border}`,
        borderRadius: UI.radiusSm,
        padding: 14,
        background: UI.surface2,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 13.5, fontWeight: 600, color: UI.text, margin: 0 }}>{proposal.summary}</p>
          <p style={{ fontSize: 11.5, color: UI.faint, margin: "3px 0 0" }}>{breadcrumb}</p>
        </div>
        {status === "accepted" ? <Badge tone="accent">Aceptada</Badge> : null}
        {status === "rejected" ? <Badge tone="muted">Rechazada</Badge> : null}
      </div>

      {status === "pending" || status === "stale" ? (
        <div style={{ marginTop: 10 }}>
          {proposal.ops.map((op, i) => (
            <OpRow
              key={`${op.nodeId}:${op.field}:${i}`}
              target={target}
              nodeId={op.nodeId}
              field={op.field}
              value={op.value}
              rationale={rationaleByKey.get(`${op.nodeId}:${op.field}`) ?? op.rationale}
            />
          ))}
        </div>
      ) : null}

      {status === "stale" ? (
        <p style={{ fontSize: 12.5, color: UI.danger, margin: "10px 0 0" }}>
          El borrador cambió; pídela de nuevo.
        </p>
      ) : null}

      {status === "pending" ? (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={onAccept} style={acceptBtnStyle}>
            Aceptar
          </button>
          <button type="button" onClick={onReject} style={rejectBtnStyle}>
            Rechazar
          </button>
          {onSelectNode ? (
            <button type="button" onClick={() => onSelectNode(nodeIds[0])} style={ghostBtnStyle}>
              Ver nodo
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const acceptBtnStyle: React.CSSProperties = {
  border: "1px solid transparent",
  background: UI.text,
  color: UI.bg,
  borderRadius: UI.radiusSm,
  padding: "6px 14px",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

const rejectBtnStyle: React.CSSProperties = {
  border: `1px solid ${UI.borderStrong}`,
  background: "none",
  color: UI.muted,
  borderRadius: UI.radiusSm,
  padding: "6px 14px",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

const ghostBtnStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  color: UI.accent,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  padding: "6px 4px",
};
