"use client";

// Left structure tree + right rail (SERP ad preview, running summary, "EN PAUSA" badge).
// Pure presentational — all state lives in builder-client.tsx.

import { Card, SectionLabel, UI } from "@/components/ui-kit";
import type { BuilderState, CrearAccountOption } from "./builder-types";
import { formatMoney, GOALS, treeSubs, unitsToMicros } from "./builder-types";

const STEP_NAMES = ["Campaña · objetivo", "Presupuesto", "Grupo de anuncios", "Anuncio de búsqueda", "Revisión"];

function ShieldIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }}>
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function StructureTree({
  step,
  onStep,
  state,
  ready,
  onReviewClick,
}: {
  step: number;
  onStep: (i: number) => void;
  state: BuilderState;
  ready: boolean;
  onReviewClick: () => void;
}) {
  const subs = treeSubs(state, ready);
  return (
    <Card style={{ position: "sticky", top: 16, padding: 20 }}>
      <SectionLabel style={{ marginBottom: 12 }}>Estructura</SectionLabel>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {STEP_NAMES.map((name, i) => {
          const status = i < step ? "done" : i === step ? "cur" : "todo";
          const isLast = i === STEP_NAMES.length - 1;
          return (
            <li key={name} style={{ position: "relative", padding: "0 0 4px 22px" }}>
              {i < STEP_NAMES.length - 1 && (
                <span aria-hidden="true" style={{ position: "absolute", left: 7, top: 22, bottom: -2, width: 1, background: UI.border }} />
              )}
              <button
                type="button"
                onClick={() => (isLast ? onReviewClick() : onStep(i))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  width: "100%",
                  background: "none",
                  border: 0,
                  padding: "6px 8px 6px 0",
                  fontSize: 13.5,
                  cursor: "pointer",
                  borderRadius: 6,
                  textAlign: "left",
                  color: status === "cur" ? UI.text : UI.muted,
                  fontWeight: status === "cur" ? 600 : 400,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 15,
                    height: 15,
                    borderRadius: "50%",
                    border: `1.5px solid ${status === "done" || status === "cur" ? UI.accent : UI.faint}`,
                    marginLeft: -22,
                    flexShrink: 0,
                    background: status === "done" ? UI.accent : UI.bg,
                    display: "grid",
                    placeItems: "center",
                    fontSize: 9,
                    color: "#fff",
                    boxShadow: status === "cur" ? `0 0 0 3px ${UI.accentSoft}` : "none",
                  }}
                >
                  {status === "done" ? "✓" : null}
                </span>
                <span>
                  {name}
                  <span style={{ display: "block", fontSize: 11.5, color: status === "done" ? UI.muted : UI.faint, fontWeight: 400, marginTop: 1 }}>
                    {subs[i]}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${UI.border}`, fontSize: 12, color: UI.faint, display: "flex", gap: 7 }}>
        <ShieldIcon />
        <span>
          Cada paso pasa por las <b style={{ color: UI.muted }}>compuertas</b> del motor. Todo se crea{" "}
          <b style={{ color: UI.muted }}>en pausa</b> y es reversible desde la Bitácora.
        </span>
      </div>
    </Card>
  );
}

export function SerpPreview({ state }: { state: BuilderState }) {
  const h1 = state.headlines[0]?.trim() || "Tu primer título";
  const h2 = state.headlines[1]?.trim() || "Tu segundo título";
  const d1 = state.descriptions[0]?.trim() || "Tu descripción aparecerá aquí conforme la escribes.";
  const url = state.finalUrl.trim() || "tu-sitio.com";
  return (
    <Card style={{ padding: 20 }}>
      <SectionLabel style={{ marginBottom: 12 }}>Así se verá tu anuncio</SectionLabel>
      <div style={{ background: "#fff", color: "#1a1a1c", borderRadius: UI.radiusSm, padding: 14, fontFamily: "Arial, sans-serif" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#1a1a1c" }}>Patrocinado</div>
        <div style={{ fontSize: 12, color: "#3c4043", margin: "2px 0" }}>{url}</div>
        <div style={{ color: "#1a0dab", fontSize: 16.5, lineHeight: 1.25, margin: "2px 0" }}>
          {h1} | {h2}
        </div>
        <div style={{ fontSize: 13, color: "#4d5156", lineHeight: 1.45 }}>{d1}</div>
      </div>
    </Card>
  );
}

export function RunningSummary({
  account,
  state,
}: {
  account: CrearAccountOption | null;
  state: BuilderState;
}) {
  const rows: Array<[string, string, boolean]> = [
    ["Red", "Google Ads", false],
    ["Cuenta", account ? `${account.name} · ${account.accountRef}` : "sin seleccionar", true],
    ["Objetivo", GOALS[state.goal].label, false],
    ["Presupuesto", `${formatMoney(unitsToMicros(state.dailyAmount) / 1_000_000, account?.currency ?? null)} / día`, true],
    ["Grupo de anuncios", state.groupName.trim() || "sin nombre", false],
    ["Estado al publicar", "EN PAUSA", false],
  ];
  return (
    <Card style={{ padding: 20 }}>
      <SectionLabel style={{ marginBottom: 12 }}>Resumen</SectionLabel>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 13 }}>
        {rows.map(([k, v, mono], i) => (
          <li
            key={k}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              padding: "7px 0",
              borderBottom: i === rows.length - 1 ? "none" : `1px solid ${UI.border}`,
            }}
          >
            <span style={{ color: UI.faint }}>{k}</span>
            <span
              style={{
                color: UI.text,
                textAlign: "right",
                fontWeight: 500,
                maxWidth: "60%",
                fontFamily: mono ? UI.fontMono : undefined,
                fontVariantNumeric: mono ? "tabular-nums" : undefined,
              }}
            >
              {v}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function PausedBadge({ elementCount }: { elementCount: number }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        fontSize: 12.5,
        color: UI.muted,
        border: `1px dashed ${UI.borderStrong}`,
        borderRadius: UI.radiusSm,
        padding: "9px 12px",
      }}
    >
      <span style={{ color: UI.warn, fontWeight: 700, fontSize: 11, letterSpacing: "0.06em" }}>EN PAUSA</span>
      <span>
        Se crearán {elementCount} elementos. Ninguno gastará hasta que tú lo actives.
      </span>
    </div>
  );
}
