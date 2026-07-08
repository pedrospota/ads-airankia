"use client";

// Command Center v2.4 "Copiloto Anclado" — provenance rendering (spec §b). Exactly two
// badges: `IA` (accent — an accepted propose_patch op, or an accepted ✨ suggest) and `Dato`
// (muted — an edit-mode live baseline field). Nothing renders for manual/auto: the spec's
// explicit call — badge noise on every untouched field would outweigh the value of the label.
//
// Import surface is deliberately narrow: ui-kit + the isomorphic patch/schema.ts
// ProvenanceMap type only — never executor/gates/actions-repo, mirroring the dock/card.

import type { ReactNode } from "react";
import { Badge, UI } from "@/components/ui-kit";
import type { ProvenanceMap } from "@/lib/command/patch/schema";

export function ProvBadge({ kind }: { kind: "ia" | "dato" }) {
  if (kind === "ia") {
    return (
      <span title="Sugerido por el copiloto y aceptado por ti">
        <Badge tone="accent">IA</Badge>
      </span>
    );
  }
  return (
    <span title="Dato cargado de la cuenta en vivo — no editable aquí">
      <Badge tone="muted">Dato</Badge>
    </span>
  );
}

/** The one place call sites should check `${nodeId}:${field}` against a ProvenanceMap —
 * renders `<ProvBadge kind="ia"/>` iff that exact key is stamped 'ia', else nothing. */
export function IaBadgeFor({
  prov,
  nodeId,
  field,
}: {
  prov: ProvenanceMap;
  nodeId: string;
  field: string;
}): ReactNode {
  return prov[`${nodeId}:${field}`] === "ia" ? <ProvBadge kind="ia" /> : null;
}

/** One-line legend, mounted once per screen (not per field) next to wherever badges appear. */
export function ProvLegend({ style }: { style?: React.CSSProperties }) {
  return (
    <span style={{ fontSize: 11, color: UI.faint, ...style }}>
      Sin etiqueta = escrito por ti.
    </span>
  );
}
