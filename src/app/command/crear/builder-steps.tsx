"use client";

// The 4 guided steps (objetivo / presupuesto+puja / grupo+palabras clave / anuncio) plus the
// shared field/why-box/nav primitives they use. All state lives in builder-client.tsx; every
// step here is a pure function of `StepCtx` + its own local UI concerns (which headline row is
// being edited, etc. — none of that is state that needs to survive a step switch).

import { useState } from "react";
import { UI } from "@/components/ui-kit";
import { GOOGLE_THRESHOLDS, RSA_SPEC } from "@/lib/command/knowledge";
import type { SuggestKind } from "@/lib/command/blueprint/suggest";
import {
  BIDDING_LABELS,
  BUDGET_CHIPS,
  COUNTRY_LABELS,
  GOALS,
  LANGUAGE_LABELS,
  formatMoney,
  suggestContext,
  type BuilderState,
  type CrearAccountOption,
  type Goal,
  type KeywordEntry,
  type MatchType,
} from "./builder-types";

/* ---------------------------------------------------------------------------
 * Shared field primitives
 * ------------------------------------------------------------------------- */

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

export function Field({
  label,
  cnt,
  children,
}: {
  label: string;
  cnt?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ margin: "14px 0" }}>
      <label style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: UI.muted, marginBottom: 6, fontWeight: 600 }}>
        <span>{label}</span>
        {cnt}
      </label>
      {children}
    </div>
  );
}

export function CharCount({ length, max }: { length: number; max: number }) {
  const bad = length > max;
  return (
    <span style={{ fontSize: 12, fontFamily: UI.fontMono, color: bad ? UI.danger : UI.faint, fontWeight: 400 }}>
      {length}/{max}
    </span>
  );
}

export function WhyBox({ title, children, source }: { title: string; children: React.ReactNode; source: string }) {
  return (
    <div
      style={{
        marginTop: 20,
        border: `1px solid ${UI.border}`,
        borderLeft: `2px solid ${UI.accent}`,
        borderRadius: UI.radiusSm,
        background: "color-mix(in srgb, var(--uik-accent) 6%, transparent)",
        padding: "12px 14px",
        fontSize: 13,
        color: UI.muted,
      }}
    >
      <b style={{ color: UI.text, display: "block", marginBottom: 2, fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        {title}
      </b>
      {children}
      <span style={{ color: UI.faint, fontSize: 11.5, display: "block", marginTop: 6 }}>Fuente: {source}</span>
    </div>
  );
}

export function NavRow({
  onBack,
  onNext,
  nextLabel = "Siguiente →",
  nextDisabled,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 22, gap: 10 }}>
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          style={{ borderRadius: UI.radiusSm, padding: "10px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer", border: `1px solid ${UI.borderStrong}`, background: "none", color: UI.muted }}
        >
          ← Atrás
        </button>
      ) : (
        <span />
      )}
      {onNext ? (
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          style={{
            borderRadius: UI.radiusSm,
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            cursor: nextDisabled ? "default" : "pointer",
            opacity: nextDisabled ? 0.4 : 1,
            border: "1px solid transparent",
            background: UI.text,
            color: UI.bg,
          }}
        >
          {nextLabel}
        </button>
      ) : null}
    </div>
  );
}

function SparkleButton({ onClick, busy, title = "Sugerir con IA" }: { onClick: () => void; busy: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={title}
      aria-label={title}
      style={{
        border: `1px solid ${UI.borderStrong}`,
        background: "none",
        color: busy ? UI.faint : UI.accent,
        borderRadius: UI.radiusSm,
        padding: "6px 10px",
        fontSize: 13,
        cursor: busy ? "default" : "pointer",
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      {busy ? "Generando…" : "✨ Sugerir"}
    </button>
  );
}

function OptionCard({ active, title, subtitle, onClick }: { active: boolean; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? UI.accentSoft : UI.surface2,
        border: `1px solid ${active ? UI.accent : UI.border}`,
        borderRadius: UI.radiusSm,
        padding: 14,
        cursor: "pointer",
        textAlign: "left",
        color: UI.text,
      }}
    >
      <b style={{ fontSize: 14 }}>{title}</b>
      <small style={{ display: "block", color: UI.muted, marginTop: 3, fontSize: 12.5 }}>{subtitle}</small>
    </button>
  );
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

/* ---------------------------------------------------------------------------
 * Shared step context — everything a step needs from the orchestrator.
 * ------------------------------------------------------------------------- */

export interface StepCtx {
  state: BuilderState;
  patch: (p: Partial<BuilderState>) => void;
  account: CrearAccountOption | null;
  accounts: CrearAccountOption[];
  selectAccount: (ref: string) => void;
  busyField: string | null;
  suggest: (kind: SuggestKind, context: string, busyKey: string, onValue: (v: string | { text: string; matchType: MatchType }[]) => void) => void;
  /** True once a draft exists server-side — the account is fixed at creation, so the picker locks to prevent a doc/account mismatch. */
  accountLocked: boolean;
}

function StepHead({ index, total }: { index: number; total: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
      <span style={{ fontFamily: UI.fontMono, fontSize: 12, color: UI.faint }}>
        Paso {index + 1} de {total} · Google Ads
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Step 1 — Objetivo
 * ------------------------------------------------------------------------- */

export function StepObjetivo({ ctx, onNext }: { ctx: StepCtx; onNext: () => void }) {
  const { state, patch, account, accounts, selectAccount, accountLocked } = ctx;
  return (
    <div>
      <StepHead index={0} total={4} />
      <h2 style={{ fontFamily: UI.fontDisplay, fontWeight: 500, fontSize: 23, margin: "6px 0 2px" }}>¿Qué quieres lograr?</h2>
      <p style={{ color: UI.muted, fontSize: 14, margin: "0 0 18px", maxWidth: "58ch" }}>
        Esto decide cómo la red optimiza tu inversión. Sin jerga: elige lo que de verdad quieres que pase.
      </p>

      <Field label="Cuenta de Google Ads">
        <select
          style={{ ...inputStyle, opacity: accountLocked ? 0.6 : 1 }}
          value={account?.accountRef ?? ""}
          disabled={accountLocked}
          onChange={(e) => selectAccount(e.target.value)}
        >
          <option value="" disabled>
            Selecciona una cuenta…
          </option>
          {accounts.map((a) => (
            <option key={a.accountRef} value={a.accountRef}>
              {a.name} · {a.accountRef}
            </option>
          ))}
        </select>
        {accountLocked ? (
          <span style={{ display: "block", fontSize: 11.5, color: UI.faint, marginTop: 6 }}>
            La cuenta queda fija una vez guardado el borrador.
          </span>
        ) : null}
      </Field>

      <Field label="Nombre de la campaña">
        <input
          type="text"
          style={inputStyle}
          value={state.campaignName}
          placeholder="p. ej. Implantes Dentales — Búsqueda MX"
          onChange={(e) => patch({ campaignName: e.target.value })}
        />
      </Field>

      <Field label="Objetivo">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          {(Object.keys(GOALS) as Goal[]).map((k) => (
            <OptionCard key={k} active={state.goal === k} title={GOALS[k].label} subtitle={GOALS[k].hint} onClick={() => patch({ goal: k })} />
          ))}
        </div>
      </Field>

      <WhyBox title="Por qué importa" source="playbook Meta/Google · Centro de Mando">
        Tu objetivo fija el evento de optimización. Cambiarlo después reinicia el aprendizaje de la campaña — mejor
        decidirlo bien aquí.
      </WhyBox>

      <NavRow onNext={onNext} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Step 2 — Presupuesto y puja
 * ------------------------------------------------------------------------- */

export function StepPresupuesto({ ctx, onBack, onNext }: { ctx: StepCtx; onBack: () => void; onNext: () => void }) {
  const { state, patch, account } = ctx;
  return (
    <div>
      <StepHead index={1} total={4} />
      <h2 style={{ fontFamily: UI.fontDisplay, fontWeight: 500, fontSize: 23, margin: "6px 0 2px" }}>¿Cuánto inviertes al día?</h2>
      <p style={{ color: UI.muted, fontSize: 14, margin: "0 0 18px", maxWidth: "58ch" }}>
        Empieza con un monto que puedas sostener 2 semanas — la red necesita ese tiempo para aprender.
      </p>

      <Field label="Presupuesto diario">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="text"
            inputMode="decimal"
            style={{ ...inputStyle, fontFamily: UI.fontMono, fontVariantNumeric: "tabular-nums", fontSize: 19, width: 150 }}
            value={state.dailyAmount}
            onChange={(e) => patch({ dailyAmount: e.target.value.replace(/[^0-9.]/g, "") })}
          />
          <span style={{ color: UI.faint, fontSize: 13 }}>{account?.currency ?? "MXN"} / día</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {BUDGET_CHIPS.map((amount) => (
            <Chip key={amount} label={formatMoney(amount, account?.currency ?? null)} active={Number(state.dailyAmount) === amount} onClick={() => patch({ dailyAmount: String(amount) })} />
          ))}
        </div>
      </Field>

      <Field label="¿Cómo pujar?">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <OptionCard
            active={state.bidding === "MAXIMIZE_CONVERSIONS"}
            title={BIDDING_LABELS.MAXIMIZE_CONVERSIONS.label}
            subtitle={BIDDING_LABELS.MAXIMIZE_CONVERSIONS.hint}
            onClick={() => patch({ bidding: "MAXIMIZE_CONVERSIONS" })}
          />
          <OptionCard
            active={state.bidding === "TARGET_CPA"}
            title={BIDDING_LABELS.TARGET_CPA.label}
            subtitle={BIDDING_LABELS.TARGET_CPA.hint}
            onClick={() => patch({ bidding: "TARGET_CPA" })}
          />
        </div>
        {state.bidding === "TARGET_CPA" ? (
          <div style={{ marginTop: 10 }}>
            <input
              type="text"
              inputMode="decimal"
              style={{ ...inputStyle, width: 150, fontFamily: UI.fontMono }}
              placeholder="CPA objetivo"
              value={state.targetCpaAmount}
              onChange={(e) => patch({ targetCpaAmount: e.target.value.replace(/[^0-9.]/g, "") })}
            />
          </div>
        ) : null}
      </Field>

      <Field label="Ubicación e idioma">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {Object.keys(COUNTRY_LABELS).map((code) => (
            <Chip
              key={code}
              label={COUNTRY_LABELS[code]}
              active={state.countryCodes.includes(code)}
              onClick={() =>
                patch({
                  countryCodes: state.countryCodes.includes(code)
                    ? state.countryCodes.filter((c) => c !== code)
                    : [...state.countryCodes, code],
                })
              }
            />
          ))}
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: UI.muted }}>
            <input type="checkbox" checked={state.presenceOnly} onChange={(e) => patch({ presenceOnly: e.target.checked })} />
            Solo personas presentes en esas ubicaciones
          </label>
          <select style={{ ...inputStyle, width: "auto" }} value={state.languageCode} onChange={(e) => patch({ languageCode: e.target.value })}>
            {Object.entries(LANGUAGE_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </Field>

      <WhyBox title="Guardarraíl del motor" source="GOOGLE_THRESHOLDS · knowledge pack">
        La puja automática necesita datos: usa CPA objetivo solo con ≥{GOOGLE_THRESHOLDS.smartBiddingMinConv30d}{" "}
        conversiones/30 días. Recuerda: Google puede gastar hasta {GOOGLE_THRESHOLDS.budgetSpendMultiplierPerDay}× tu
        presupuesto en un día pico.
      </WhyBox>

      <NavRow onBack={onBack} onNext={onNext} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Step 3 — Grupo y palabras clave
 * ------------------------------------------------------------------------- */

export function StepGrupo({ ctx, onBack, onNext }: { ctx: StepCtx; onBack: () => void; onNext: () => void }) {
  const { state, patch, account, busyField, suggest } = ctx;
  // Local-only draft text for the "add keywords"/"add negatives" textareas; not part of the blueprint doc.
  const [draft, setDraft] = useState("");
  const [draftMatch, setDraftMatch] = useState<MatchType>("PHRASE");
  const [negDraft, setNegDraft] = useState("");

  function addKeywords() {
    const lines = draft.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const additions: KeywordEntry[] = lines.map((text) => ({ text, match: draftMatch }));
    patch({ keywords: [...state.keywords, ...additions] });
    setDraft("");
  }
  function removeKeyword(i: number) {
    patch({ keywords: state.keywords.filter((_, idx) => idx !== i) });
  }
  function addNegatives() {
    const lines = negDraft.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const additions: KeywordEntry[] = lines.map((text) => ({ text, match: "BROAD" as MatchType }));
    patch({ negatives: [...state.negatives, ...additions] });
    setNegDraft("");
  }
  function removeNegative(i: number) {
    patch({ negatives: state.negatives.filter((_, idx) => idx !== i) });
  }

  return (
    <div>
      <StepHead index={2} total={4} />
      <h2 style={{ fontFamily: UI.fontDisplay, fontWeight: 500, fontSize: 23, margin: "6px 0 2px" }}>¿Qué busca tu cliente?</h2>
      <p style={{ color: UI.muted, fontSize: 14, margin: "0 0 18px", maxWidth: "58ch" }}>
        Escribe las frases que alguien pondría en Google cuando necesita lo tuyo. Nosotros las agrupamos en un tema.
      </p>

      <Field
        label="Nombre del grupo"
        cnt={
          <SparkleButton
            busy={busyField === "group_name"}
            onClick={() =>
              suggest("group_name", suggestContext(state, account?.name ?? null), "group_name", (v) => patch({ groupName: v as string }))
            }
          />
        }
      >
        <input type="text" style={inputStyle} value={state.groupName} onChange={(e) => patch({ groupName: e.target.value })} />
      </Field>

      <Field
        label="Agregar palabras clave"
        cnt={<span style={{ fontSize: 12, color: UI.faint, fontFamily: UI.fontMono }}>{state.keywords.length} agregadas</span>}
      >
        <textarea
          style={{ ...inputStyle, minHeight: 74, resize: "vertical" }}
          placeholder={"Una por línea, p. ej.\nimplantes dentales cdmx\nprecio implante dental"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
          {(["PHRASE", "EXACT", "BROAD"] as MatchType[]).map((m) => (
            <Chip key={m} label={MATCH_LABEL[m]} active={draftMatch === m} onClick={() => setDraftMatch(m)} />
          ))}
          <button type="button" onClick={addKeywords} style={secondaryBtnStyle}>
            Agregar
          </button>
          <SparkleButton
            title="Sugerir palabras clave"
            busy={busyField === "keywords"}
            onClick={() =>
              suggest("keywords", suggestContext(state, account?.name ?? null), "keywords", (v) => {
                const items = v as { text: string; matchType: MatchType }[];
                patch({ keywords: [...state.keywords, ...items.map((k) => ({ text: k.text, match: k.matchType }))] });
              })
            }
          />
        </div>
      </Field>

      {state.keywords.length > 0 ? (
        <ul style={{ listStyle: "none", margin: "0 0 14px", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {state.keywords.map((k, i) => (
            <li
              key={`${k.text}-${i}`}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: UI.surface2, border: `1px solid ${UI.border}`, borderRadius: UI.radiusSm, padding: "6px 10px", fontSize: 13 }}
            >
              <span>{k.text}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: UI.faint, textTransform: "uppercase", letterSpacing: "0.04em" }}>{MATCH_LABEL[k.match]}</span>
                <button type="button" onClick={() => removeKeyword(i)} aria-label="Quitar" style={removeBtnStyle}>
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <Field label="Negativas (opcional)" cnt={<span style={{ fontSize: 12, color: UI.faint, fontFamily: UI.fontMono }}>{state.negatives.length} agregadas</span>}>
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
      {state.negatives.length > 0 ? (
        <ul style={{ listStyle: "none", margin: "0 0 14px", padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {state.negatives.map((n, i) => (
            <li key={`${n.text}-${i}`} style={{ display: "flex", alignItems: "center", gap: 6, background: UI.surface2, border: `1px solid ${UI.border}`, borderRadius: 999, padding: "4px 10px", fontSize: 12.5, color: UI.muted }}>
              −{n.text}
              <button type="button" onClick={() => removeNegative(i)} aria-label="Quitar" style={removeBtnStyle}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <WhyBox title="Por qué importa" source="google-search-playbook · knowledge pack">
        Grupos con un solo tema y 5–15 palabras clave rinden mejor que listas gigantes. Activaremos concordancia
        amplia solo cuando tengas {GOOGLE_THRESHOLDS.broadMatchMinConv30d}+ conversiones/mes y lista de negativas —
        antes es regalar presupuesto.
      </WhyBox>

      <NavRow onBack={onBack} onNext={onNext} />
    </div>
  );
}

const MATCH_LABEL: Record<MatchType, string> = { PHRASE: "frase", EXACT: "exacta", BROAD: "amplia" };

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

/* ---------------------------------------------------------------------------
 * Step 4 — Anuncio (RSA)
 * ------------------------------------------------------------------------- */

export function StepAnuncio({ ctx, onBack, onReview, reviewDisabled }: { ctx: StepCtx; onBack: () => void; onReview: () => void; reviewDisabled: boolean }) {
  const { state, patch, account, busyField, suggest } = ctx;

  function updateHeadline(i: number, v: string) {
    patch({ headlines: state.headlines.map((h, idx) => (idx === i ? v : h)) });
  }
  function addHeadline() {
    if (state.headlines.length >= RSA_SPEC.headline.max) return;
    patch({ headlines: [...state.headlines, ""] });
  }
  function removeHeadline(i: number) {
    if (state.headlines.length <= RSA_SPEC.headline.min) return;
    patch({ headlines: state.headlines.filter((_, idx) => idx !== i) });
  }
  function updateDescription(i: number, v: string) {
    patch({ descriptions: state.descriptions.map((d, idx) => (idx === i ? v : d)) });
  }
  function addDescription() {
    if (state.descriptions.length >= RSA_SPEC.description.max) return;
    patch({ descriptions: [...state.descriptions, ""] });
  }
  function removeDescription(i: number) {
    if (state.descriptions.length <= RSA_SPEC.description.min) return;
    patch({ descriptions: state.descriptions.filter((_, idx) => idx !== i) });
  }

  const headlineCtx = (i: number) => suggestContext(state, account?.name ?? null, `Este será el título #${i + 1} del anuncio.`);
  const descriptionCtx = (i: number) => suggestContext(state, account?.name ?? null, `Esta será la descripción #${i + 1} del anuncio.`);

  return (
    <div>
      <StepHead index={3} total={4} />
      <h2 style={{ fontFamily: UI.fontDisplay, fontWeight: 500, fontSize: 23, margin: "6px 0 2px" }}>Escribe tu anuncio</h2>
      <p style={{ color: UI.muted, fontSize: 14, margin: "0 0 18px", maxWidth: "58ch" }}>
        {RSA_SPEC.headline.min} títulos y {RSA_SPEC.description.min} descripciones bastan para empezar. Míralo armado a
        la derecha, tal como saldría en Google.
      </p>

      <Field label="Página de destino">
        <input
          type="text"
          style={inputStyle}
          placeholder="https://tu-sitio.com/pagina"
          value={state.finalUrl}
          onChange={(e) => patch({ finalUrl: e.target.value })}
        />
      </Field>

      <div style={{ margin: "14px 0" }}>
        <label style={{ display: "block", fontSize: 13, color: UI.muted, marginBottom: 6, fontWeight: 600 }}>
          Títulos <span style={{ fontFamily: UI.fontMono, fontSize: 12, color: UI.faint, fontWeight: 400 }}>({state.headlines.length}/{RSA_SPEC.headline.max}, mín {RSA_SPEC.headline.min})</span>
        </label>
        {state.headlines.map((h, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input type="text" style={inputStyle} maxLength={RSA_SPEC.headline.maxLen} value={h} onChange={(e) => updateHeadline(i, e.target.value)} placeholder={`Título ${i + 1}`} />
            <CharCount length={h.length} max={RSA_SPEC.headline.maxLen} />
            <SparkleButton title="Sugerir título" busy={busyField === `headline-${i}`} onClick={() => suggest("headline", headlineCtx(i), `headline-${i}`, (v) => updateHeadline(i, v as string))} />
            <button type="button" onClick={() => removeHeadline(i)} disabled={state.headlines.length <= RSA_SPEC.headline.min} aria-label="Quitar título" style={{ ...removeBtnStyle, opacity: state.headlines.length <= RSA_SPEC.headline.min ? 0.3 : 1 }}>
              ×
            </button>
          </div>
        ))}
        <button type="button" onClick={addHeadline} disabled={state.headlines.length >= RSA_SPEC.headline.max} style={{ ...secondaryBtnStyle, opacity: state.headlines.length >= RSA_SPEC.headline.max ? 0.4 : 1 }}>
          + Agregar título
        </button>
      </div>

      <div style={{ margin: "14px 0" }}>
        <label style={{ display: "block", fontSize: 13, color: UI.muted, marginBottom: 6, fontWeight: 600 }}>
          Descripciones <span style={{ fontFamily: UI.fontMono, fontSize: 12, color: UI.faint, fontWeight: 400 }}>({state.descriptions.length}/{RSA_SPEC.description.max}, mín {RSA_SPEC.description.min})</span>
        </label>
        {state.descriptions.map((d, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
            <textarea style={{ ...inputStyle, minHeight: 56, resize: "vertical" }} maxLength={RSA_SPEC.description.maxLen} value={d} onChange={(e) => updateDescription(i, e.target.value)} placeholder={`Descripción ${i + 1}`} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
              <CharCount length={d.length} max={RSA_SPEC.description.maxLen} />
              <SparkleButton title="Sugerir descripción" busy={busyField === `description-${i}`} onClick={() => suggest("description", descriptionCtx(i), `description-${i}`, (v) => updateDescription(i, v as string))} />
              <button type="button" onClick={() => removeDescription(i)} disabled={state.descriptions.length <= RSA_SPEC.description.min} aria-label="Quitar descripción" style={{ ...removeBtnStyle, opacity: state.descriptions.length <= RSA_SPEC.description.min ? 0.3 : 1 }}>
                ×
              </button>
            </div>
          </div>
        ))}
        <button type="button" onClick={addDescription} disabled={state.descriptions.length >= RSA_SPEC.description.max} style={{ ...secondaryBtnStyle, opacity: state.descriptions.length >= RSA_SPEC.description.max ? 0.4 : 1 }}>
          + Agregar descripción
        </button>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <Field label={`Ruta 1 (opcional, máx ${RSA_SPEC.path.maxLen})`}>
          <input type="text" style={inputStyle} maxLength={RSA_SPEC.path.maxLen} value={state.path1} onChange={(e) => patch({ path1: e.target.value })} />
        </Field>
        <Field label={`Ruta 2 (opcional, máx ${RSA_SPEC.path.maxLen})`}>
          <input type="text" style={inputStyle} maxLength={RSA_SPEC.path.maxLen} value={state.path2} onChange={(e) => patch({ path2: e.target.value })} />
        </Field>
      </div>

      <WhyBox title="Validador en vivo" source="rsa-output-spec · gates">
        Los límites (títulos ≤{RSA_SPEC.headline.maxLen}, descripción ≤{RSA_SPEC.description.maxLen}) se validan aquí
        y otra vez en la compuerta antes de publicar — un anuncio inválido nunca llega a la red.
      </WhyBox>

      <NavRow onBack={onBack} onNext={onReview} nextLabel="Revisar y publicar →" nextDisabled={reviewDisabled} />
    </div>
  );
}
