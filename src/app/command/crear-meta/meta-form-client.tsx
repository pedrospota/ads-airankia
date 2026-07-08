"use client";

// Centro de Mando v2.2 — Meta lean create form. Single screen, no step machine: one
// campaign, one ad set, N link ads. Builds a `CcMetaBlueprintDoc` client-side, validates
// it with the SAME zod schema the server enforces (metaBlueprintDocSchema.safeParse) to
// gate the submit button, POSTs once (no autosave — unlike the Google guided builder,
// there's no draft to resume here), then hands off to the existing network-agnostic
// review screen. Never touches the account — publishing happens on that later screen.

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Card, SectionLabel, Badge, ErrorCard, PrimaryButton, UI } from "@/components/ui-kit";
import { metaBlueprintDocSchema, type CcMetaBlueprintDoc } from "@/lib/command/blueprint/meta-schema";
import { META_LINK_AD_SPEC } from "@/lib/command/knowledge";
import { MICROS_PER_MINOR_UNIT } from "@/lib/command/types";
import { newId } from "../crear/builder-types";
import { Field, CharCount } from "../crear/builder-steps";

/* ---------------------------------------------------------------------------
 * Local types + constants — mirrors crear/builder-types.ts's shape, scoped to
 * exactly what the Meta doc needs (see meta-schema.ts for the binding contract).
 * ------------------------------------------------------------------------- */

type MetaCountry = "MX" | "US" | "AR" | "CO" | "CL" | "PE";
type MetaCta = "LEARN_MORE" | "CONTACT_US" | "SHOP_NOW" | "SIGN_UP" | "GET_QUOTE";

interface MetaAdDraft {
  nodeId: string;
  tempId: string;
  link: string;
  message: string;
  headline: string;
  description: string;
  callToActionType: "" | MetaCta;
  imageUrl: string;
}

interface MetaFormState {
  accountRef: string;
  campaignName: string;
  adsetName: string;
  dailyAmount: string; // currency units (not micros) — e.g. "350"
  countryCodes: MetaCountry[];
  ageMin: string;
  ageMax: string;
  ads: MetaAdDraft[];
}

interface MetaIds {
  campaignNodeId: string;
  campaignTempId: string;
  adsetNodeId: string;
  adsetTempId: string;
}

const COUNTRIES: { code: MetaCountry; label: string }[] = [
  { code: "MX", label: "México" },
  { code: "US", label: "Estados Unidos" },
  { code: "AR", label: "Argentina" },
  { code: "CO", label: "Colombia" },
  { code: "CL", label: "Chile" },
  { code: "PE", label: "Perú" },
];

const CTA_OPTIONS: { value: MetaCta; label: string }[] = [
  { value: "LEARN_MORE", label: "Más información" },
  { value: "CONTACT_US", label: "Contáctanos" },
  { value: "SHOP_NOW", label: "Comprar ahora" },
  { value: "SIGN_UP", label: "Regístrate" },
  { value: "GET_QUOTE", label: "Solicitar cotización" },
];

function blankAd(): MetaAdDraft {
  return {
    nodeId: newId("ad"),
    tempId: newId("ad"),
    link: "",
    message: "",
    headline: "",
    description: "",
    callToActionType: "",
    imageUrl: "",
  };
}

function initialState(accountRef: string): MetaFormState {
  return {
    accountRef,
    campaignName: "",
    adsetName: "",
    dailyAmount: "350",
    countryCodes: ["MX"],
    ageMin: "18",
    ageMax: "65",
    ads: [blankAd()],
  };
}

function newMetaIds(): MetaIds {
  return {
    campaignNodeId: newId("campaign"),
    campaignTempId: newId("campaign"),
    adsetNodeId: newId("adset"),
    adsetTempId: newId("adset"),
  };
}

/** raw currency units → whole-cent micros. Guarantees `.multipleOf(MICROS_PER_MINOR_UNIT)`
 * never trips server-side — see meta-schema.ts's `dailyBudgetMicros`. */
function metaUnitsToMicros(raw: string): number {
  return Math.round(parseFloat(raw) * 100) * MICROS_PER_MINOR_UNIT;
}

/** Builds the exact CcMetaBlueprintDoc shape (meta-schema.ts). Always returns a full
 * object — even mid-edit while fields are still empty — so it can be safeParse-checked
 * on every keystroke to drive the submit button. */
function buildDoc(state: MetaFormState, ids: MetaIds): CcMetaBlueprintDoc {
  return {
    network: "meta_ads",
    campaign: {
      nodeId: ids.campaignNodeId,
      tempId: ids.campaignTempId,
      name: state.campaignName.trim(),
      status: "PAUSED",
      objective: "OUTCOME_TRAFFIC",
      adsets: [
        {
          nodeId: ids.adsetNodeId,
          tempId: ids.adsetTempId,
          name: state.adsetName.trim(),
          status: "PAUSED",
          dailyBudgetMicros: metaUnitsToMicros(state.dailyAmount),
          targeting: {
            countryCodes: state.countryCodes,
            ageMin: Number(state.ageMin),
            ageMax: Number(state.ageMax),
          },
          ads: state.ads.map((ad, i) => ({
            nodeId: ad.nodeId,
            tempId: ad.tempId,
            // Ad name isn't an operator-facing field (Meta ads are identified by their
            // creative, not a name) — auto-derived like the Google builder's budget name.
            name: `${state.campaignName.trim() || "Meta"} — Anuncio ${i + 1}`,
            link: ad.link.trim(),
            message: ad.message.trim(),
            headline: ad.headline.trim() || undefined,
            description: ad.description.trim() || undefined,
            callToActionType: ad.callToActionType || undefined,
            imageUrl: ad.imageUrl.trim() || undefined,
          })),
        },
      ],
    },
  };
}

/* ---------------------------------------------------------------------------
 * Shared field chrome — small local copies of crear/builder-steps.tsx's private
 * (unexported) style tokens; Field/CharCount themselves ARE imported/reused.
 * ------------------------------------------------------------------------- */

const inputStyle: CSSProperties = {
  width: "100%",
  background: UI.surface2,
  border: `1px solid ${UI.border}`,
  borderRadius: UI.radiusSm,
  color: UI.text,
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: "inherit",
};

const secondaryBtnStyle: CSSProperties = {
  border: `1px solid ${UI.borderStrong}`,
  background: "none",
  color: UI.muted,
  borderRadius: UI.radiusSm,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
};

const removeBtnStyle: CSSProperties = {
  border: "none",
  background: "none",
  color: UI.faint,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
};

interface CreateResponse {
  blueprint?: { id: string };
  error?: string;
}

/* ---------------------------------------------------------------------------
 * Root
 * ------------------------------------------------------------------------- */

export default function MetaFormClient({ accounts }: { accounts: string[] }) {
  const router = useRouter();
  const idsRef = useRef(newMetaIds());

  const [state, setState] = useState<MetaFormState>(() => initialState(accounts[0]));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function patch(p: Partial<MetaFormState>) {
    setState((s) => ({ ...s, ...p }));
  }
  function updateAd(i: number, p: Partial<MetaAdDraft>) {
    setState((s) => ({ ...s, ads: s.ads.map((a, idx) => (idx === i ? { ...a, ...p } : a)) }));
  }
  function addAd() {
    setState((s) => ({ ...s, ads: [...s.ads, blankAd()] }));
  }
  function removeAd(i: number) {
    setState((s) => (s.ads.length <= 1 ? s : { ...s, ads: s.ads.filter((_, idx) => idx !== i) }));
  }
  function toggleCountry(code: MetaCountry) {
    setState((s) => ({
      ...s,
      countryCodes: s.countryCodes.includes(code)
        ? s.countryCodes.filter((c) => c !== code)
        : [...s.countryCodes, code],
    }));
  }

  const doc = useMemo(() => buildDoc(state, idsRef.current), [state]);
  const docValid = useMemo(() => metaBlueprintDocSchema.safeParse(doc).success, [doc]);

  async function handleContinue() {
    if (!docValid || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/command/blueprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "meta_ads", account_ref: state.accountRef, doc }),
      });
      const data = (await res.json().catch(() => ({}))) as CreateResponse;
      if (!res.ok || !data.blueprint) throw new Error(data.error ?? `HTTP ${res.status}`);
      // `submitting` stays true through the navigation — no window for a second click.
      router.push(`/command/crear/${data.blueprint.id}/revisar`);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Error creando el blueprint.");
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ padding: 24, maxWidth: 720 }}>
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          fontSize: 13,
          border: `1px dashed ${UI.borderStrong}`,
          borderRadius: UI.radiusSm,
          padding: "12px 14px",
          marginBottom: 22,
          color: UI.muted,
        }}
      >
        <Badge tone="warn" dot>
          EN PAUSA
        </Badge>
        <span>La campaña y el conjunto nacen en pausa; nada se publica hasta que la actives.</span>
      </div>

      <SectionLabel>Cuenta</SectionLabel>
      <Field label="Cuenta de Meta Ads">
        <select style={inputStyle} value={state.accountRef} onChange={(e) => patch({ accountRef: e.target.value })}>
          {accounts.map((ref) => (
            <option key={ref} value={ref}>
              {ref}
            </option>
          ))}
        </select>
      </Field>

      <SectionLabel style={{ marginTop: 22 }}>Campaña y conjunto</SectionLabel>
      <Field label="Nombre de la campaña">
        <input
          type="text"
          style={inputStyle}
          placeholder="p. ej. Implantes Dentales — Meta MX"
          value={state.campaignName}
          onChange={(e) => patch({ campaignName: e.target.value })}
        />
      </Field>
      <Field label="Nombre del conjunto de anuncios">
        <input
          type="text"
          style={inputStyle}
          placeholder="p. ej. Prospección — 25-54"
          value={state.adsetName}
          onChange={(e) => patch({ adsetName: e.target.value })}
        />
      </Field>

      <Field label="Presupuesto diario">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="text"
            inputMode="decimal"
            style={{ ...inputStyle, fontFamily: UI.fontMono, fontVariantNumeric: "tabular-nums", fontSize: 19, width: 150 }}
            value={state.dailyAmount}
            onChange={(e) => patch({ dailyAmount: e.target.value.replace(/[^0-9.]/g, "") })}
          />
          <span style={{ color: UI.faint, fontSize: 13 }}>MXN / día · mínimo 1 unidad</span>
        </div>
      </Field>

      <Field label="Países">
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {COUNTRIES.map(({ code, label }) => (
            <label key={code} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: UI.muted }}>
              <input
                type="checkbox"
                checked={state.countryCodes.includes(code)}
                onChange={() => toggleCountry(code)}
              />
              {label}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Rango de edad">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="number"
            min={18}
            max={65}
            style={{ ...inputStyle, width: 90 }}
            value={state.ageMin}
            onChange={(e) => patch({ ageMin: e.target.value })}
          />
          <span style={{ color: UI.faint, fontSize: 13 }}>a</span>
          <input
            type="number"
            min={18}
            max={65}
            style={{ ...inputStyle, width: 90 }}
            value={state.ageMax}
            onChange={(e) => patch({ ageMax: e.target.value })}
          />
        </div>
      </Field>

      <SectionLabel style={{ marginTop: 22 }}>
        Anuncios <span style={{ fontFamily: UI.fontMono, fontWeight: 400, color: UI.faint }}>({state.ads.length})</span>
      </SectionLabel>
      {state.ads.map((ad, i) => (
        <div
          key={ad.tempId}
          style={{
            border: `1px solid ${UI.border}`,
            borderRadius: UI.radiusSm,
            padding: 16,
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: UI.muted }}>Anuncio {i + 1}</span>
            <button
              type="button"
              onClick={() => removeAd(i)}
              disabled={state.ads.length <= 1}
              aria-label="Quitar anuncio"
              style={{ ...removeBtnStyle, opacity: state.ads.length <= 1 ? 0.3 : 1 }}
            >
              Quitar ×
            </button>
          </div>

          <Field label="Enlace">
            <input
              type="url"
              style={inputStyle}
              placeholder="https://tu-sitio.com/pagina"
              value={ad.link}
              onChange={(e) => updateAd(i, { link: e.target.value })}
            />
          </Field>

          <Field label="Mensaje" cnt={<CharCount length={ad.message.length} max={META_LINK_AD_SPEC.message.maxLen} />}>
            <textarea
              style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
              maxLength={META_LINK_AD_SPEC.message.maxLen}
              value={ad.message}
              onChange={(e) => updateAd(i, { message: e.target.value })}
            />
          </Field>

          <Field label="Título (opcional)" cnt={<CharCount length={ad.headline.length} max={META_LINK_AD_SPEC.headline.maxLen} />}>
            <input
              type="text"
              style={inputStyle}
              maxLength={META_LINK_AD_SPEC.headline.maxLen}
              value={ad.headline}
              onChange={(e) => updateAd(i, { headline: e.target.value })}
            />
          </Field>

          <Field label="Descripción (opcional)" cnt={<CharCount length={ad.description.length} max={META_LINK_AD_SPEC.description.maxLen} />}>
            <input
              type="text"
              style={inputStyle}
              maxLength={META_LINK_AD_SPEC.description.maxLen}
              value={ad.description}
              onChange={(e) => updateAd(i, { description: e.target.value })}
            />
          </Field>

          <Field label="Llamado a la acción (opcional)">
            <select
              style={inputStyle}
              value={ad.callToActionType}
              onChange={(e) => updateAd(i, { callToActionType: e.target.value as "" | MetaCta })}
            >
              <option value="">Sin llamado a la acción</option>
              {CTA_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="URL de imagen (opcional, https)">
            <input
              type="url"
              style={inputStyle}
              placeholder="https://tu-sitio.com/imagen.jpg"
              value={ad.imageUrl}
              onChange={(e) => updateAd(i, { imageUrl: e.target.value })}
            />
          </Field>
        </div>
      ))}
      <button type="button" onClick={addAd} style={secondaryBtnStyle}>
        + Añadir anuncio
      </button>

      {submitError ? <ErrorCard message={submitError} style={{ marginTop: 20 }} /> : null}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 24 }}>
        <PrimaryButton disabled={!docValid || submitting} onClick={() => void handleContinue()}>
          {submitting ? "Creando…" : "Continuar a revisión →"}
        </PrimaryButton>
      </div>
      {!docValid ? (
        <p style={{ textAlign: "right", fontSize: 12, color: UI.faint, marginTop: 8 }}>
          Completa cuenta, nombres, presupuesto (mínimo 1 unidad), al menos un país y al menos un anuncio con enlace y
          mensaje antes de continuar.
        </p>
      ) : null}
    </Card>
  );
}
