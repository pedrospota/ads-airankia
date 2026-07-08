"use client";

// CENTER pane — per-selected-node editors. Only the §a-editable fields (see the
// v2.3 edit-mode design spec) are ever active here; every base/live value is
// rendered greyed and read-only next to its editable counterpart. Reuses the
// Field/CharCount primitives from crear/builder-steps.tsx (the "RSA field editor")
// so the ad-replace/new-ad forms match the create flow pixel-for-pixel.

import { useState } from "react";
import { GhostDangerButton, SecondaryButton, SectionLabel, UI } from "@/components/ui-kit";
import { CharCount, Field } from "../../crear/builder-steps";
import { formatMoney } from "../../crear/builder-types";
import { RSA_SPEC } from "@/lib/command/knowledge";
import { MICROS_PER_UNIT } from "@/lib/command/types";
import type { GoogleSearchEditDoc } from "@/lib/command/edit/schema";
import type { ProvenanceMap } from "@/lib/command/patch/schema";
import { IaBadgeFor, ProvBadge } from "@/components/command/prov-badge";
import {
  blankNewAd,
  queueRemoveNegative,
  replacementFromBase,
  setKeywordDesiredStatus,
  undoRemoveNegative,
  unitsToCpcMicros,
  updateAd,
  updateAdGroup,
  updateNewAd,
  type EditAd,
  type EditAdGroup,
  type EditNewAd,
  type NodeSelection,
} from "./editor-types";

type MatchType = "EXACT" | "PHRASE" | "BROAD";
type DocUpdater = (fn: (d: GoogleSearchEditDoc) => GoogleSearchEditDoc) => void;

const MATCH_LABEL: Record<MatchType, string> = { PHRASE: "frase", EXACT: "exacta", BROAD: "amplia" };

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: UI.surface2,
  border: `1px solid ${UI.border}`,
  borderRadius: UI.radiusSm,
  color: UI.text,
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: "inherit",
};

const secondaryBtnStyle: React.CSSProperties = {
  border: `1px solid ${UI.borderStrong}`,
  background: "none",
  color: UI.muted,
  borderRadius: UI.radiusSm,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
};

const removeBtnStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  color: UI.faint,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
};

// v2.7 pruning — small inline text buttons for the live-keyword/live-negative
// row controls ([Pausar]/[Reactivar]/[Quitar]/[Deshacer]). Color is set per
// call site (amber for a pending pause, green/accent for a pending reactivate,
// danger for Quitar, muted for Deshacer).
const rowActionBtnStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
  padding: "2px 4px",
  whiteSpace: "nowrap",
};

/** v2.7 — CPC needs 2 decimal places always (unlike formatMoney's whole-unit budget
 * formatting): a $0.65 live CPC must never render as "$1" or "$0". */
function formatCpc(micros: number): string {
  return `$${(micros / MICROS_PER_UNIT).toFixed(2)}`;
}

function Chip({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${active ? UI.accent : UI.borderStrong}`,
        background: "none",
        color: active ? UI.accent : UI.muted,
        borderRadius: 999,
        padding: "4px 12px",
        fontSize: 12.5,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function PanelHead({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: UI.fontMono, fontSize: 12, color: UI.faint }}>{children}</span>
  );
}

function NodeTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontFamily: UI.fontDisplay, fontWeight: 500, fontSize: 21, margin: "6px 0 18px" }}>{children}</h2>
  );
}

function StatusToggle({
  value,
  base,
  onChange,
}: {
  value: "ENABLED" | "PAUSED";
  base: "ENABLED" | "PAUSED";
  onChange: (s: "ENABLED" | "PAUSED") => void;
}) {
  const segStyle = (active: boolean): React.CSSProperties => ({
    border: `1px solid ${active ? UI.accent : UI.borderStrong}`,
    background: active ? UI.accentSoft : "none",
    color: active ? UI.text : UI.muted,
    borderRadius: UI.radiusSm,
    padding: "8px 16px",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" style={segStyle(value === "ENABLED")} onClick={() => onChange("ENABLED")}>
          Activa
        </button>
        <button type="button" style={segStyle(value === "PAUSED")} onClick={() => onChange("PAUSED")}>
          Pausada
        </button>
      </div>
      <span style={{ fontSize: 11.5, color: UI.faint }}>
        En vivo: <b style={{ color: UI.muted }}>{base === "ENABLED" ? "activa" : "pausada"}</b>
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Shared RSA field editor — mirrors crear/builder-steps.tsx StepAnuncio, minus
 * the account/goal/✨-suggest concerns that don't apply once a campaign is live.
 * ------------------------------------------------------------------------- */

interface RsaValue {
  finalUrl?: string;
  headlines: { text: string; pinnedField?: string }[];
  descriptions: { text: string }[];
  path1?: string;
  path2?: string;
}

function RsaFields({ value, onChange }: { value: RsaValue; onChange: (v: RsaValue) => void }) {
  function updateHeadline(i: number, text: string) {
    onChange({ ...value, headlines: value.headlines.map((h, idx) => (idx === i ? { ...h, text } : h)) });
  }
  function addHeadline() {
    if (value.headlines.length >= RSA_SPEC.headline.max) return;
    onChange({ ...value, headlines: [...value.headlines, { text: "" }] });
  }
  function removeHeadline(i: number) {
    if (value.headlines.length <= RSA_SPEC.headline.min) return;
    onChange({ ...value, headlines: value.headlines.filter((_, idx) => idx !== i) });
  }
  function updateDescription(i: number, text: string) {
    onChange({ ...value, descriptions: value.descriptions.map((d, idx) => (idx === i ? { text } : d)) });
  }
  function addDescription() {
    if (value.descriptions.length >= RSA_SPEC.description.max) return;
    onChange({ ...value, descriptions: [...value.descriptions, { text: "" }] });
  }
  function removeDescription(i: number) {
    if (value.descriptions.length <= RSA_SPEC.description.min) return;
    onChange({ ...value, descriptions: value.descriptions.filter((_, idx) => idx !== i) });
  }

  return (
    <div>
      <Field label="Página de destino">
        <input
          type="text"
          style={inputStyle}
          placeholder="https://tu-sitio.com/pagina"
          value={value.finalUrl ?? ""}
          onChange={(e) => onChange({ ...value, finalUrl: e.target.value })}
        />
      </Field>

      <div style={{ margin: "14px 0" }}>
        <label style={{ display: "block", fontSize: 13, color: UI.muted, marginBottom: 6, fontWeight: 600 }}>
          Títulos{" "}
          <span style={{ fontFamily: UI.fontMono, fontSize: 12, color: UI.faint, fontWeight: 400 }}>
            ({value.headlines.length}/{RSA_SPEC.headline.max}, mín {RSA_SPEC.headline.min})
          </span>
        </label>
        {value.headlines.map((h, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input
              type="text"
              style={inputStyle}
              maxLength={RSA_SPEC.headline.maxLen}
              value={h.text}
              placeholder={`Título ${i + 1}`}
              onChange={(e) => updateHeadline(i, e.target.value)}
            />
            <CharCount length={h.text.length} max={RSA_SPEC.headline.maxLen} />
            <button
              type="button"
              onClick={() => removeHeadline(i)}
              disabled={value.headlines.length <= RSA_SPEC.headline.min}
              aria-label="Quitar título"
              style={{ ...removeBtnStyle, opacity: value.headlines.length <= RSA_SPEC.headline.min ? 0.3 : 1 }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addHeadline}
          disabled={value.headlines.length >= RSA_SPEC.headline.max}
          style={{ ...secondaryBtnStyle, opacity: value.headlines.length >= RSA_SPEC.headline.max ? 0.4 : 1 }}
        >
          + Agregar título
        </button>
      </div>

      <div style={{ margin: "14px 0" }}>
        <label style={{ display: "block", fontSize: 13, color: UI.muted, marginBottom: 6, fontWeight: 600 }}>
          Descripciones{" "}
          <span style={{ fontFamily: UI.fontMono, fontSize: 12, color: UI.faint, fontWeight: 400 }}>
            ({value.descriptions.length}/{RSA_SPEC.description.max}, mín {RSA_SPEC.description.min})
          </span>
        </label>
        {value.descriptions.map((d, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
            <textarea
              style={{ ...inputStyle, minHeight: 56, resize: "vertical" }}
              maxLength={RSA_SPEC.description.maxLen}
              value={d.text}
              placeholder={`Descripción ${i + 1}`}
              onChange={(e) => updateDescription(i, e.target.value)}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
              <CharCount length={d.text.length} max={RSA_SPEC.description.maxLen} />
              <button
                type="button"
                onClick={() => removeDescription(i)}
                disabled={value.descriptions.length <= RSA_SPEC.description.min}
                aria-label="Quitar descripción"
                style={{ ...removeBtnStyle, opacity: value.descriptions.length <= RSA_SPEC.description.min ? 0.3 : 1 }}
              >
                ×
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={addDescription}
          disabled={value.descriptions.length >= RSA_SPEC.description.max}
          style={{ ...secondaryBtnStyle, opacity: value.descriptions.length >= RSA_SPEC.description.max ? 0.4 : 1 }}
        >
          + Agregar descripción
        </button>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <Field label={`Ruta 1 (opcional, máx ${RSA_SPEC.path.maxLen})`}>
          <input
            type="text"
            style={inputStyle}
            maxLength={RSA_SPEC.path.maxLen}
            value={value.path1 ?? ""}
            onChange={(e) => onChange({ ...value, path1: e.target.value })}
          />
        </Field>
        <Field label={`Ruta 2 (opcional, máx ${RSA_SPEC.path.maxLen})`}>
          <input
            type="text"
            style={inputStyle}
            maxLength={RSA_SPEC.path.maxLen}
            value={value.path2 ?? ""}
            onChange={(e) => onChange({ ...value, path2: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}

function BaseAdPreview({ ad }: { ad: EditAd["base"] }) {
  return (
    <div
      style={{
        border: `1px solid ${UI.border}`,
        borderRadius: UI.radiusSm,
        padding: 14,
        marginBottom: 16,
        opacity: 0.65,
      }}
    >
      <SectionLabel style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        Anuncio en vivo (no editable) <ProvBadge kind="dato" />
      </SectionLabel>
      <p style={{ fontSize: 13, color: UI.muted, margin: "0 0 6px" }}>{ad.finalUrl || "sin URL"}</p>
      <p style={{ fontSize: 13.5, color: UI.text, margin: "0 0 6px" }}>{ad.headlines.map((h) => h.text).join(" | ")}</p>
      <p style={{ fontSize: 12.5, color: UI.muted, margin: 0 }}>{ad.descriptions.map((d) => d.text).join(" · ")}</p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Campaign panel — budget (shared-budget locked), status, campaign negatives.
 * ------------------------------------------------------------------------- */

function CampaignPanel({ doc, onChange, prov }: { doc: GoogleSearchEditDoc; onChange: DocUpdater; prov: ProvenanceMap }) {
  const c = doc.campaign;
  const [budgetInput, setBudgetInput] = useState(String(c.desired.dailyBudgetMicros / MICROS_PER_UNIT));
  const [negDraft, setNegDraft] = useState("");

  function commitBudget(raw: string) {
    setBudgetInput(raw.replace(/[^0-9.]/g, ""));
    const n = Number(raw.replace(/[^0-9.]/g, ""));
    const micros = Number.isFinite(n) && n > 0 ? Math.round(n * MICROS_PER_UNIT) : 0;
    onChange((d) => ({ ...d, campaign: { ...d.campaign, desired: { ...d.campaign.desired, dailyBudgetMicros: micros } } }));
  }

  function setStatus(status: "ENABLED" | "PAUSED") {
    onChange((d) => ({ ...d, campaign: { ...d.campaign, desired: { ...d.campaign.desired, status } } }));
  }

  function addNegatives() {
    const lines = negDraft.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    onChange((d) => ({
      ...d,
      campaign: { ...d.campaign, newNegatives: [...d.campaign.newNegatives, ...lines.map((text) => ({ text, match: "BROAD" as const }))] },
    }));
    setNegDraft("");
  }
  function removeNegative(i: number) {
    onChange((d) => ({ ...d, campaign: { ...d.campaign, newNegatives: d.campaign.newNegatives.filter((_, idx) => idx !== i) } }));
  }

  return (
    <div>
      <PanelHead>Campaña · Google Ads</PanelHead>
      <NodeTitle>{c.base.name}</NodeTitle>

      <Field label="Presupuesto diario" cnt={<IaBadgeFor prov={prov} nodeId={c.resourceName} field="desired.dailyBudgetMicros" />}>
        {c.base.budgetShared ? (
          <p style={{ fontSize: 13, color: UI.muted, margin: 0 }}>
            <b style={{ color: UI.text }}>Presupuesto compartido — no editable.</b> Actual en vivo:{" "}
            {formatMoney(c.base.dailyBudgetMicros / MICROS_PER_UNIT, c.base.currency)}/día
          </p>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="text"
                inputMode="decimal"
                style={{ ...inputStyle, fontFamily: UI.fontMono, fontVariantNumeric: "tabular-nums", fontSize: 19, width: 150 }}
                value={budgetInput}
                onChange={(e) => commitBudget(e.target.value)}
              />
              <span style={{ color: UI.faint, fontSize: 13 }}>{c.base.currency ?? "MXN"} / día</span>
            </div>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: UI.faint, marginTop: 6 }}>
              <ProvBadge kind="dato" /> Actual en vivo: {formatMoney(c.base.dailyBudgetMicros / MICROS_PER_UNIT, c.base.currency)}/día
            </span>
          </>
        )}
      </Field>

      <Field label="Estado" cnt={<IaBadgeFor prov={prov} nodeId={c.resourceName} field="desired.status" />}>
        <StatusToggle value={c.desired.status} base={c.base.status} onChange={setStatus} />
      </Field>

      <Field
        label="Agregar negativas de campaña"
        cnt={
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <IaBadgeFor prov={prov} nodeId={c.resourceName} field="newNegatives" />
            <span style={{ fontSize: 12, color: UI.faint, fontFamily: UI.fontMono }}>{c.newNegatives.length} agregadas</span>
          </span>
        }
      >
        <textarea
          style={{ ...inputStyle, minHeight: 56, resize: "vertical" }}
          placeholder={"Una por línea, p. ej.\ngratis\nempleo"}
          value={negDraft}
          onChange={(e) => setNegDraft(e.target.value)}
        />
        <button type="button" onClick={addNegatives} style={{ ...secondaryBtnStyle, marginTop: 8 }}>
          Agregar negativas
        </button>
      </Field>
      {c.newNegatives.length > 0 ? (
        <ul style={{ listStyle: "none", margin: "0 0 14px", padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {c.newNegatives.map((n, i) => (
            <li
              key={`${n.text}-${i}`}
              style={{ display: "flex", alignItems: "center", gap: 6, background: UI.surface2, border: `1px solid ${UI.border}`, borderRadius: 999, padding: "4px 10px", fontSize: 12.5, color: UI.muted }}
            >
              −{n.text}
              <button type="button" onClick={() => removeNegative(i)} aria-label="Quitar" style={removeBtnStyle}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${UI.border}` }}>
        <SectionLabel style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
          Negativas de campaña en vivo ({c.baseNegatives.length}) <ProvBadge kind="dato" />
        </SectionLabel>
        {c.baseNegatives.length === 0 ? (
          <p style={{ fontSize: 13, color: UI.faint }}>Sin negativas de campaña en vivo.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {c.baseNegatives.map((n) => {
              const pending = c.removeNegatives.includes(n.resourceName);
              return (
                <li
                  key={n.resourceName}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12.5, padding: "3px 0" }}
                >
                  <span style={{ color: pending ? UI.faint : UI.muted, textDecoration: pending ? "line-through" : "none" }}>
                    −{n.text} <span style={{ color: UI.faint }}>· {MATCH_LABEL[n.match]}</span>
                  </span>
                  {pending ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11.5, color: UI.faint }}>se quitará</span>
                      <button
                        type="button"
                        onClick={() => onChange((d) => undoRemoveNegative(d, n.resourceName))}
                        style={{ ...rowActionBtnStyle, color: UI.muted }}
                      >
                        Deshacer
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onChange((d) => queueRemoveNegative(d, n.resourceName))}
                      style={{ ...rowActionBtnStyle, color: UI.danger }}
                    >
                      Quitar
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {c.removeNegatives.length > 0 ? (
          <p style={{ fontSize: 12, color: UI.faint, marginTop: 10 }}>
            Pausar es reversible; quitar negativas re-crea recursos nuevos al revertir.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Ad-group panel — status + "Añadir anuncio" entry point.
 * ------------------------------------------------------------------------- */

function AdGroupPanel({
  group,
  currency,
  onChange,
  onSelect,
  prov,
}: {
  group: EditAdGroup;
  currency: string | null;
  onChange: DocUpdater;
  onSelect: (s: NodeSelection) => void;
  prov: ProvenanceMap;
}) {
  // NodePanel keys this component by group.resourceName, so this local state
  // resets whenever the operator selects a different ad group — it never
  // shows a stale CPC input carried over from the previously viewed group.
  const [cpcInput, setCpcInput] = useState(
    group.desired.cpcBidMicros != null ? String(group.desired.cpcBidMicros / MICROS_PER_UNIT) : ""
  );

  function setStatus(status: "ENABLED" | "PAUSED") {
    onChange((d) => updateAdGroup(d, group.resourceName, (g) => ({ ...g, desired: { ...g.desired, status } })));
  }
  function commitCpc(raw: string) {
    setCpcInput(raw.replace(/[^0-9.]/g, ""));
    const cpcBidMicros = unitsToCpcMicros(raw);
    onChange((d) => updateAdGroup(d, group.resourceName, (g) => ({ ...g, desired: { ...g.desired, cpcBidMicros } })));
  }
  function addAd() {
    const na = blankNewAd();
    onChange((d) => updateAdGroup(d, group.resourceName, (g) => ({ ...g, newAds: [...g.newAds, na] })));
    onSelect({ kind: "newAd", groupRef: group.resourceName, tempId: na.tempId });
  }

  return (
    <div>
      <PanelHead>Grupo de anuncios</PanelHead>
      <NodeTitle>{group.base.name}</NodeTitle>

      <Field label="Estado" cnt={<IaBadgeFor prov={prov} nodeId={group.resourceName} field="desired.status" />}>
        <StatusToggle value={group.desired.status} base={group.base.status} onChange={setStatus} />
      </Field>

      <Field label="CPC máx." cnt={<IaBadgeFor prov={prov} nodeId={group.resourceName} field="desired.cpcBidMicros" />}>
        {group.base.cpcBidMicros == null ? (
          <p style={{ fontSize: 13, color: UI.muted, margin: 0 }}>
            <b style={{ color: UI.text }}>La campaña usa puja automática.</b>
          </p>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="text"
                inputMode="decimal"
                style={{ ...inputStyle, fontFamily: UI.fontMono, fontVariantNumeric: "tabular-nums", fontSize: 16, width: 120 }}
                value={cpcInput}
                onChange={(e) => commitCpc(e.target.value)}
              />
              <span style={{ color: UI.faint, fontSize: 13 }}>{currency ?? "MXN"}</span>
            </div>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: UI.faint, marginTop: 6 }}>
              <ProvBadge kind="dato" /> En vivo: {formatCpc(group.base.cpcBidMicros)}
            </span>
          </>
        )}
      </Field>

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${UI.border}` }}>
        <SectionLabel style={{ marginBottom: 10 }}>Anuncios</SectionLabel>
        <p style={{ fontSize: 13, color: UI.muted, margin: "0 0 12px" }}>
          {group.ads.length} en vivo · {group.newAds.length} nuevo{group.newAds.length === 1 ? "" : "s"} · usa el árbol para editarlos
        </p>
        <SecondaryButton onClick={addAd}>+ Añadir anuncio</SecondaryButton>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Keywords panel — base (read-only) + newKeywords add editor (keywords + negatives).
 * ------------------------------------------------------------------------- */

function KeywordsPanel({ group, onChange, prov }: { group: EditAdGroup; onChange: DocUpdater; prov: ProvenanceMap }) {
  const [posDraft, setPosDraft] = useState("");
  const [posMatch, setPosMatch] = useState<MatchType>("PHRASE");
  const [negDraft, setNegDraft] = useState("");

  function addPositive() {
    const lines = posDraft.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    onChange((d) =>
      updateAdGroup(d, group.resourceName, (g) => ({
        ...g,
        newKeywords: [...g.newKeywords, ...lines.map((text) => ({ text, match: posMatch, negative: false }))],
      }))
    );
    setPosDraft("");
  }
  function addNegative() {
    const lines = negDraft.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    onChange((d) =>
      updateAdGroup(d, group.resourceName, (g) => ({
        ...g,
        newKeywords: [...g.newKeywords, ...lines.map((text) => ({ text, match: "BROAD" as MatchType, negative: true }))],
      }))
    );
    setNegDraft("");
  }
  function removeNew(i: number) {
    onChange((d) => updateAdGroup(d, group.resourceName, (g) => ({ ...g, newKeywords: g.newKeywords.filter((_, idx) => idx !== i) })));
  }

  return (
    <div>
      <PanelHead>Palabras clave</PanelHead>
      <NodeTitle>{group.base.name}</NodeTitle>

      <Field
        label="Agregar palabras clave"
        cnt={
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <IaBadgeFor prov={prov} nodeId={group.resourceName} field="newKeywords" />
            <span style={{ fontSize: 12, color: UI.faint, fontFamily: UI.fontMono }}>{group.newKeywords.filter((k) => !k.negative).length} agregadas</span>
          </span>
        }
      >
        <textarea
          style={{ ...inputStyle, minHeight: 74, resize: "vertical" }}
          placeholder={"Una por línea, p. ej.\nimplantes dentales cdmx\nprecio implante dental"}
          value={posDraft}
          onChange={(e) => setPosDraft(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
          {(["PHRASE", "EXACT", "BROAD"] as MatchType[]).map((m) => (
            <Chip key={m} label={MATCH_LABEL[m]} active={posMatch === m} onClick={() => setPosMatch(m)} />
          ))}
          <button type="button" onClick={addPositive} style={secondaryBtnStyle}>
            Agregar
          </button>
        </div>
      </Field>

      <Field label="Agregar negativas" cnt={<span style={{ fontSize: 12, color: UI.faint, fontFamily: UI.fontMono }}>{group.newKeywords.filter((k) => k.negative).length} agregadas</span>}>
        <textarea
          style={{ ...inputStyle, minHeight: 56, resize: "vertical" }}
          placeholder={"Una por línea, p. ej.\ngratis\nempleo"}
          value={negDraft}
          onChange={(e) => setNegDraft(e.target.value)}
        />
        <button type="button" onClick={addNegative} style={{ ...secondaryBtnStyle, marginTop: 8 }}>
          Agregar negativas
        </button>
      </Field>

      {group.newKeywords.length > 0 ? (
        <ul style={{ listStyle: "none", margin: "0 0 14px", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {group.newKeywords.map((k, i) => (
            <li
              key={`${k.text}-${i}`}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: UI.surface2, border: `1px solid ${UI.border}`, borderRadius: UI.radiusSm, padding: "6px 10px", fontSize: 13 }}
            >
              <span>
                {k.negative ? "−" : ""}
                {k.text}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: UI.faint, textTransform: "uppercase", letterSpacing: "0.04em" }}>{MATCH_LABEL[k.match]}</span>
                <button type="button" onClick={() => removeNew(i)} aria-label="Quitar" style={removeBtnStyle}>
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${UI.border}` }}>
        <SectionLabel style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
          Palabras clave en vivo ({group.baseKeywords.length}) <ProvBadge kind="dato" />
        </SectionLabel>
        {group.baseKeywords.length === 0 ? (
          <p style={{ fontSize: 13, color: UI.faint }}>Sin palabras clave en vivo.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {group.baseKeywords.map((k) => {
              // Negatives never get a status control — the differ throws if a
              // negative ever carries a desiredStatus (edit/diff.ts guard).
              const pending = !k.negative && k.desiredStatus !== undefined && k.desiredStatus !== k.status;
              return (
                <li
                  key={k.resourceName}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12.5, color: UI.muted, padding: "3px 0" }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {k.negative ? "−" : ""}
                    {k.text} <span style={{ color: UI.faint }}>· {MATCH_LABEL[k.match]}</span>
                    <IaBadgeFor prov={prov} nodeId={k.resourceName} field="desiredStatus" />
                  </span>
                  {k.negative ? null : pending ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: k.desiredStatus === "PAUSED" ? UI.warn : UI.accent }}>
                        {k.desiredStatus === "PAUSED" ? "se pausará" : "se reactivará"}
                      </span>
                      <button
                        type="button"
                        onClick={() => onChange((d) => setKeywordDesiredStatus(d, group.resourceName, k.resourceName, undefined))}
                        style={{ ...rowActionBtnStyle, color: UI.muted }}
                      >
                        Deshacer
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        onChange((d) =>
                          setKeywordDesiredStatus(
                            d,
                            group.resourceName,
                            k.resourceName,
                            k.status === "ENABLED" ? "PAUSED" : "ENABLED"
                          )
                        )
                      }
                      style={{ ...rowActionBtnStyle, color: k.status === "ENABLED" ? UI.warn : UI.accent }}
                    >
                      {k.status === "ENABLED" ? "Pausar" : "Reactivar"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Ad panel — existing ad: base greyed + "Reemplazar anuncio" (RSA replace), or
 * the locked non-RSA notice.
 * ------------------------------------------------------------------------- */

function AdPanel({ group, ad, onChange, prov }: { group: EditAdGroup; ad: EditAd; onChange: DocUpdater; prov: ProvenanceMap }) {
  function startReplace() {
    onChange((d) => updateAd(d, group.resourceName, ad.resourceName, (a) => ({ ...a, replacement: replacementFromBase(a) })));
  }
  function discardReplace() {
    onChange((d) => updateAd(d, group.resourceName, ad.resourceName, (a) => ({ ...a, replacement: null })));
  }
  function updateReplacement(v: RsaValue) {
    onChange((d) =>
      updateAd(d, group.resourceName, ad.resourceName, (a) =>
        a.replacement ? { ...a, replacement: { ...a.replacement, ...v, finalUrl: v.finalUrl ?? "" } } : a
      )
    );
  }

  return (
    <div>
      <PanelHead>Anuncio</PanelHead>
      <NodeTitle>{group.base.name}</NodeTitle>

      {ad.unsupported ? (
        <>
          <BaseAdPreview ad={ad.base} />
          <p style={{ fontSize: 13, color: UI.muted }}>
            <b style={{ color: UI.text }}>Tipo de anuncio no compatible.</b> Este editor solo puede reemplazar anuncios de
            búsqueda adaptables (RSA).
          </p>
        </>
      ) : (
        <>
          <BaseAdPreview ad={ad.base} />
          {ad.replacement ? (
            <>
              <p style={{ fontSize: 12.5, color: UI.warn, margin: "0 0 14px", display: "flex", alignItems: "center", gap: 8 }}>
                Google no permite editar anuncios publicados: se creará este anuncio nuevo y se pausará el anterior al
                publicar. <IaBadgeFor prov={prov} nodeId={ad.resourceName} field="replacement" />
              </p>
              <RsaFields value={ad.replacement} onChange={updateReplacement} />
              <div style={{ marginTop: 10 }}>
                <GhostDangerButton onClick={discardReplace}>Descartar reemplazo</GhostDangerButton>
              </div>
            </>
          ) : (
            <SecondaryButton onClick={startReplace}>Reemplazar anuncio</SecondaryButton>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * New-ad panel — a freshly added RSA (newAds entry).
 * ------------------------------------------------------------------------- */

function NewAdPanel({
  group,
  newAd,
  onChange,
  onRemove,
}: {
  group: EditAdGroup;
  newAd: EditNewAd;
  onChange: DocUpdater;
  onRemove: () => void;
}) {
  function updateValue(v: RsaValue) {
    onChange((d) => updateNewAd(d, group.resourceName, newAd.tempId, (a) => ({ ...a, ...v, finalUrl: v.finalUrl ?? "" })));
  }

  return (
    <div>
      <PanelHead>Anuncio nuevo</PanelHead>
      <NodeTitle>{group.base.name}</NodeTitle>
      <RsaFields value={newAd} onChange={updateValue} />
      <div style={{ marginTop: 10 }}>
        <GhostDangerButton onClick={onRemove}>Eliminar anuncio nuevo</GhostDangerButton>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Dispatcher — routes the CENTER pane by the LEFT tree's current selection.
 * ------------------------------------------------------------------------- */

export function NodePanel({
  doc,
  selected,
  onSelect,
  onChange,
  prov,
}: {
  doc: GoogleSearchEditDoc;
  selected: NodeSelection;
  onSelect: (s: NodeSelection) => void;
  onChange: DocUpdater;
  /** v2.4 Copiloto — read-only, threaded to every sub-panel for <IaBadgeFor/>/<ProvBadge/>.
   * Optional so any other caller of NodePanel keeps compiling unchanged. */
  prov?: ProvenanceMap;
}) {
  const p = prov ?? {};
  if (selected.kind === "campaign") {
    return <CampaignPanel doc={doc} onChange={onChange} prov={p} />;
  }

  const group = doc.campaign.adGroups.find((g) => g.resourceName === selected.groupRef);
  if (!group) {
    return <p style={{ color: UI.muted }}>Selecciona un elemento del árbol.</p>;
  }

  if (selected.kind === "adGroup") {
    // Keyed by resourceName so AdGroupPanel's local CPC-input state resets
    // when the operator switches to a different ad group in the tree, rather
    // than carrying over the previously selected group's draft text.
    return (
      <AdGroupPanel
        key={group.resourceName}
        group={group}
        currency={doc.campaign.base.currency}
        onChange={onChange}
        onSelect={onSelect}
        prov={p}
      />
    );
  }
  if (selected.kind === "keywords") {
    return <KeywordsPanel group={group} onChange={onChange} prov={p} />;
  }
  if (selected.kind === "ad") {
    const ad = group.ads.find((a) => a.resourceName === selected.adRef);
    if (!ad) return <p style={{ color: UI.muted }}>Selecciona un elemento del árbol.</p>;
    return <AdPanel group={group} ad={ad} onChange={onChange} prov={p} />;
  }

  const newAd = group.newAds.find((a) => a.tempId === selected.tempId);
  if (!newAd) return <p style={{ color: UI.muted }}>Selecciona un elemento del árbol.</p>;
  return (
    <NewAdPanel
      group={group}
      newAd={newAd}
      onChange={onChange}
      onRemove={() => {
        onChange((d) => updateAdGroup(d, group.resourceName, (g) => ({ ...g, newAds: g.newAds.filter((a) => a.tempId !== newAd.tempId) })));
        onSelect({ kind: "adGroup", groupRef: group.resourceName });
      }}
    />
  );
}
