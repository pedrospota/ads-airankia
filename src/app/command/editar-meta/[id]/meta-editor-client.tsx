"use client";

// The Editar-Meta workbench: campaign card + adset rows + ad status toggles.
// Holds the MetaEditDoc in React state, debounced-autosaves it (PUT, whole doc
// — the server merges via mergeMetaEditDoc so client edits to base/ids are
// silently ignored), and navigates to the review screen. Never touches the
// live account — publishing happens on the revisar screen. Mirrors
// editar/[id]/editor-client.tsx minus Copiloto (never mounted here) and minus
// the SERP/keyword panels (no creative surface in slice-1).

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, ErrorCard, PageHeader, PrimaryButton, SecondaryButton, SectionLabel, UI } from "@/components/ui-kit";
import type { MetaEditDoc } from "@/lib/command/edit/meta-schema";
import { MICROS_PER_MINOR_UNIT, MICROS_PER_UNIT } from "@/lib/command/types";

const AUTOSAVE_DELAY_MS = 1200; // same cadence as editar/[id]/editor-client.tsx

interface SaveResponse { blueprint?: { id: string }; error?: string }
interface EditResponse { id?: string; error?: string }

type MetaAdset = MetaEditDoc["campaign"]["adsets"][number];

/** Pure diff counter (sibling of editor-types.ts's countEdits): one unit per
 * status flip / budget change across all 3 levels. Drives the footer button. */
function countMetaEdits(doc: MetaEditDoc): number {
  const c = doc.campaign;
  let n = 0;
  if (c.desired.status !== c.base.status) n += 1;
  if (c.desired.dailyBudgetMicros !== c.base.dailyBudgetMicros) n += 1;
  for (const as of c.adsets) {
    if (as.desired.status !== as.base.status) n += 1;
    if (as.desired.dailyBudgetMicros !== as.base.dailyBudgetMicros) n += 1;
    for (const ad of as.ads) if (ad.desired.status !== ad.base.status) n += 1;
  }
  return n;
}

/** Copy of editar/[id]/editor-panels.tsx's StatusToggle (lines 151-186) —
 * identical segmented Activa/Pausada control + "En vivo: …" hint. Duplicated
 * (not imported) so the google editor files stay untouched. */
function StatusToggle({ value, base, onChange }: {
  value: "ENABLED" | "PAUSED";
  base: "ENABLED" | "PAUSED";
  onChange: (s: "ENABLED" | "PAUSED") => void;
}) {
  const segStyle = (active: boolean): CSSProperties => ({
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

/** "en aprendizaje" badge from base.learningPhase — display/warn only; the
 * LEARNING_PHASE gate is the enforcement (execute-time snapshot). */
function LearningBadge({ phase }: { phase: MetaAdset["base"]["learningPhase"] }) {
  if (phase === "LEARNING") return <Badge tone="warn">en aprendizaje</Badge>;
  if (phase === "LIMITED") return <Badge tone="danger">aprendizaje limitado</Badge>;
  return null;
}

/** Budget input, rendered ONLY where base.dailyBudgetMicros is non-null.
 * Local text state, committed on blur/Enter, CENT-QUANTIZED:
 * Math.round(units × 100) cents × MICROS_PER_MINOR_UNIT — so every value the
 * doc ever holds is exactly what the schema's multipleOf accepts and what the
 * adapter writes without rounding. Sub-floor input reverts with an inline hint. */
function BudgetInput({ valueMicros, baseMicros, currency, onCommit }: {
  valueMicros: number;
  baseMicros: number;
  currency: string | null;
  onCommit: (micros: number) => void;
}) {
  const [text, setText] = useState((valueMicros / 1_000_000).toFixed(2));
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => { setText((valueMicros / 1_000_000).toFixed(2)); }, [valueMicros]);

  function commit() {
    const units = Number(text.replace(",", "."));
    if (!Number.isFinite(units)) {
      setText((valueMicros / 1_000_000).toFixed(2));
      setHint(null);
      return;
    }
    const micros = Math.round(units * 100) * MICROS_PER_MINOR_UNIT;
    if (micros < MICROS_PER_UNIT) {
      setText((valueMicros / 1_000_000).toFixed(2));
      setHint("El presupuesto mínimo es 1.00");
      return;
    }
    setHint(null);
    onCommit(micros);
    setText((micros / 1_000_000).toFixed(2));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
          style={{
            width: 120, padding: "8px 10px", borderRadius: UI.radiusSm,
            border: `1px solid ${UI.borderStrong}`, background: "none",
            color: UI.text, fontFamily: UI.fontMono, fontSize: 13.5,
          }}
        />
        <span style={{ fontSize: 12, color: UI.muted }}>{currency ?? ""} / día</span>
        <span style={{ fontSize: 11.5, color: UI.faint }}>
          En vivo: <b style={{ color: UI.muted }}>{(baseMicros / 1_000_000).toFixed(2)}</b>
        </span>
      </div>
      {hint ? <span style={{ color: UI.danger, fontSize: 11.5 }}>{hint}</span> : null}
    </div>
  );
}

export default function MetaEditorClient({ blueprintId, doc: initialDoc, status, accountRef }: {
  blueprintId: string;
  doc: MetaEditDoc;
  status: string;
  accountRef: string;
}) {
  const router = useRouter();
  const [doc, setDoc] = useState<MetaEditDoc>(initialDoc);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const n = useMemo(() => countMetaEdits(doc), [doc]);

  // Every field write routes through here (single choke point, mirror of
  // editor-client.tsx's updateDoc minus the provenance diffing meta doesn't have).
  function updateDoc(fn: (d: MetaEditDoc) => MetaEditDoc) {
    setDoc(fn(doc));
  }

  function setCampaign(patch: Partial<MetaEditDoc["campaign"]["desired"]>) {
    updateDoc((d) => ({ ...d, campaign: { ...d.campaign, desired: { ...d.campaign.desired, ...patch } } }));
  }
  function setAdset(adsetId: string, patch: Partial<MetaAdset["desired"]>) {
    updateDoc((d) => ({
      ...d,
      campaign: {
        ...d.campaign,
        adsets: d.campaign.adsets.map((as) =>
          as.id === adsetId ? { ...as, desired: { ...as.desired, ...patch } } : as
        ),
      },
    }));
  }
  function setAd(adsetId: string, adId: string, statusValue: "ENABLED" | "PAUSED") {
    updateDoc((d) => ({
      ...d,
      campaign: {
        ...d.campaign,
        adsets: d.campaign.adsets.map((as) =>
          as.id !== adsetId ? as : {
            ...as,
            ads: as.ads.map((ad) => (ad.id === adId ? { ...ad, desired: { status: statusValue } } : ad)),
          }
        ),
      },
    }));
  }

  async function saveNow(current: MetaEditDoc): Promise<boolean> {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/command/blueprint/${blueprintId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: current }), // whole doc; server merges (mergeMetaEditDoc)
      });
      const data = (await res.json()) as SaveResponse;
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLastSavedAt(Date.now());
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Error guardando cambios");
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Debounced autosave — identical skip-first pattern to editor-client.tsx.
  const skipFirst = useRef(true);
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const t = setTimeout(() => { void saveNow(doc); }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Reload-recreates-session: POST /api/command/edit again → new blueprint id.
  async function handleReload() {
    if (!window.confirm("Se descartarán los cambios sin aplicar. ¿Recargar los datos en vivo de la campaña?")) {
      return;
    }
    setReloading(true);
    setReloadError(null);
    try {
      const res = await fetch("/api/command/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "meta_ads",
          account_ref: accountRef,
          campaign_id: doc.campaign.id,
        }),
      });
      const data = (await res.json()) as EditResponse;
      if (!res.ok || !data.id) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.replace(`/command/editar-meta/${data.id}`);
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : "Error recargando la campaña");
    } finally {
      setReloading(false);
    }
  }

  async function handleReview() {
    const ok = await saveNow(doc);
    if (!ok) return;
    router.push(`/command/editar-meta/${blueprintId}/revisar`);
  }

  const c = doc.campaign;

  return (
    <div>
      <PageHeader
        title={
          <>
            Editar campaña Meta — <em style={{ fontStyle: "italic", color: UI.accent }}>{c.base.name}</em>
          </>
        }
        subtitle="Los cambios se autoguardan en este borrador. Nada toca la cuenta en vivo hasta que revises y publiques en la siguiente pantalla."
      />

      {status !== "draft" ? (
        <ErrorCard message={`Este borrador ya no está en edición (estado: ${status}).`} style={{ marginBottom: 16 }} />
      ) : null}

      {c.base.status === "ENABLED" ? (
        // Same EN VIVO honesty treatment as editor-preview.tsx's ActiveBanner
        // (dashed danger border + short warning) — inline here, meta copy.
        <div style={{
          border: `1px dashed ${UI.danger}`, borderRadius: UI.radiusSm, padding: "9px 12px",
          background: `color-mix(in srgb, ${UI.danger} 8%, transparent)`,
          fontSize: 12.5, color: UI.text, marginBottom: 16,
        }}>
          <b style={{ color: UI.danger, fontSize: 11, letterSpacing: "0.06em" }}>EN VIVO</b>{" "}
          Esta campaña está activa en Meta. Los cambios se aplicarán sobre entrega real al publicar.
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <SecondaryButton disabled={reloading} onClick={() => void handleReload()}>
          {reloading ? "Recargando…" : "Recargar datos en vivo"}
        </SecondaryButton>
        <span style={{ fontSize: 12, color: UI.faint }}>
          {saving ? "Guardando…" : lastSavedAt ? `Guardado ${new Date(lastSavedAt).toLocaleTimeString("es-MX")}` : "Sin cambios guardados"}
        </span>
      </div>
      {reloadError ? <ErrorCard message={reloadError} style={{ marginBottom: 16 }} /> : null}
      {saveError ? <ErrorCard message={saveError} style={{ marginBottom: 16 }} /> : null}

      {/* ── Campaign card ── */}
      <Card style={{ marginBottom: 16 }}>
        <SectionLabel>Campaña</SectionLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 14px", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{c.base.name}</span>
          <Badge tone="muted">{c.base.effectiveStatus}</Badge>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <StatusToggle value={c.desired.status} base={c.base.status} onChange={(s) => setCampaign({ status: s })} />
          {c.base.dailyBudgetMicros !== null && c.desired.dailyBudgetMicros !== null ? (
            <BudgetInput
              valueMicros={c.desired.dailyBudgetMicros}
              baseMicros={c.base.dailyBudgetMicros}
              currency={c.base.currency}
              onCommit={(m) => setCampaign({ dailyBudgetMicros: m })}
            />
          ) : c.base.lifetimeBudgetMicros !== null ? (
            <span style={{ fontSize: 12.5, color: UI.muted }}>
              Presupuesto total (lifetime) — bloqueado en esta versión; el estado sí es editable.
            </span>
          ) : (
            <span style={{ fontSize: 12.5, color: UI.muted }}>
              El presupuesto diario vive en los conjuntos de anuncios (ABO).
            </span>
          )}
        </div>
      </Card>

      {/* ── Adset cards ── */}
      {c.adsets.map((as) => (
        <Card key={as.id} style={{ marginBottom: 16 }}>
          <SectionLabel>Conjunto de anuncios</SectionLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 14px", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 14.5 }}>{as.base.name}</span>
            <Badge tone="muted">{as.base.effectiveStatus}</Badge>
            <LearningBadge phase={as.base.learningPhase} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <StatusToggle value={as.desired.status} base={as.base.status} onChange={(s) => setAdset(as.id, { status: s })} />
            {as.base.dailyBudgetMicros !== null && as.desired.dailyBudgetMicros !== null ? (
              <BudgetInput
                valueMicros={as.desired.dailyBudgetMicros}
                baseMicros={as.base.dailyBudgetMicros}
                currency={c.base.currency}
                onCommit={(m) => setAdset(as.id, { dailyBudgetMicros: m })}
              />
            ) : as.base.lifetimeBudgetMicros !== null ? (
              <span style={{ fontSize: 12.5, color: UI.muted }}>
                Presupuesto total (lifetime) — bloqueado en esta versión; el estado sí es editable.
              </span>
            ) : (
              <span style={{ fontSize: 12.5, color: UI.muted }}>
                Presupuesto administrado por la campaña (CBO).
              </span>
            )}
          </div>

          {as.ads.length > 0 ? (
            <div style={{ marginTop: 16, borderTop: `1px solid ${UI.border}`, paddingTop: 12 }}>
              <SectionLabel>Anuncios ({as.ads.length})</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
                {as.ads.map((ad) => (
                  <div key={ad.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13.5 }}>{ad.base.name}</span>
                      <Badge tone="muted">{ad.base.effectiveStatus}</Badge>
                    </div>
                    <StatusToggle value={ad.desired.status} base={ad.base.status} onChange={(s) => setAd(as.id, ad.id, s)} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      ))}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <PrimaryButton onClick={() => void handleReview()} disabled={n === 0}>
          Revisar cambios ({n})
        </PrimaryButton>
      </div>
    </div>
  );
}
