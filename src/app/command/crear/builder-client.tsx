"use client";

// The Constructor workbench: left structure tree, center one-step-at-a-time
// form, right live SERP preview + running summary + "EN PAUSA" badge. Holds
// the blueprint doc in React state, creates-then-PUTs a draft (debounced
// autosave), calls /suggest for the per-field ✨ buttons, and navigates to the
// (future) review screen on "Revisar y publicar". Never touches the account —
// publishing happens on that later screen.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, EmptyState, ErrorCard, UI } from "@/components/ui-kit";
import { blueprintDocSchema } from "@/lib/command/blueprint/schema";
import type { SuggestKind } from "@/lib/command/blueprint/suggest";
import type { GateResult } from "@/lib/command/types";
import { PausedBadge, RunningSummary, SerpPreview, StructureTree } from "./builder-preview";
import { StepAnuncio, StepGrupo, StepObjetivo, StepPresupuesto, type StepCtx } from "./builder-steps";
import {
  buildDoc,
  initialBuilderState,
  missingSteps,
  newBuilderIds,
  type BuilderState,
  type CrearAccountOption,
  type MatchType,
} from "./builder-types";

interface CreateResponse {
  blueprint?: { id: string };
  error?: string;
}
interface SaveResponse {
  blueprint?: { id: string };
  error?: string;
}
interface SuggestResponse {
  value?: string | { text: string; matchType: MatchType }[];
  warnings?: GateResult[];
  error?: string;
}

const AUTOSAVE_DELAY_MS = 1200;

export default function BuilderClient({ accounts }: { accounts: CrearAccountOption[] }) {
  const router = useRouter();
  const idsRef = useRef(newBuilderIds());

  const [step, setStep] = useState(0);
  const [state, setState] = useState<BuilderState>(() => initialBuilderState(accounts[0]?.accountRef ?? null));
  const [blueprintId, setBlueprintId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [busyField, setBusyField] = useState<string | null>(null);
  const [suggestNotice, setSuggestNotice] = useState<string | null>(null);

  const account = useMemo(() => accounts.find((a) => a.accountRef === state.accountRef) ?? null, [accounts, state.accountRef]);

  function patch(p: Partial<BuilderState>) {
    setState((s) => ({ ...s, ...p }));
  }

  const doc = useMemo(() => buildDoc(state, idsRef.current), [state]);
  const missing = useMemo(() => missingSteps(state), [state]);
  const docValid = useMemo(() => blueprintDocSchema.safeParse(doc).success, [doc]);
  const ready = missing.length === 0 && docValid;

  async function saveDraft(): Promise<string | null> {
    if (!account) {
      setSaveError("Selecciona una cuenta de Google Ads antes de guardar.");
      return null;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (!blueprintId) {
        const res = await fetch("/api/command/blueprint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "google_ads",
            account_ref: account.accountRef,
            connection_id: account.connectionId,
            doc,
          }),
        });
        const data = (await res.json()) as CreateResponse;
        if (!res.ok || !data.blueprint) throw new Error(data.error ?? `HTTP ${res.status}`);
        setBlueprintId(data.blueprint.id);
        setLastSavedAt(Date.now());
        return data.blueprint.id;
      }
      const res = await fetch(`/api/command/blueprint/${blueprintId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc }),
      });
      const data = (await res.json()) as SaveResponse;
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLastSavedAt(Date.now());
      return blueprintId;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Error guardando borrador");
      return null;
    } finally {
      setSaving(false);
    }
  }

  // Debounced autosave — only once a draft exists (the first save always goes through the
  // explicit "Guardar borrador" click, matching the brief's "creates-then-PUTs / autosaves").
  const skipFirst = useRef(true);
  useEffect(() => {
    if (!blueprintId) return;
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const t = setTimeout(() => {
      void saveDraft();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, blueprintId]);

  function selectAccount(ref: string) {
    patch({ accountRef: ref });
  }

  async function suggest(
    kind: SuggestKind,
    context: string,
    busyKey: string,
    onValue: (v: string | { text: string; matchType: MatchType }[]) => void
  ) {
    setBusyField(busyKey);
    setSuggestNotice(null);
    try {
      const res = await fetch("/api/command/blueprint/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, context }),
      });
      const data = (await res.json()) as SuggestResponse;
      if (!res.ok || data.value === undefined) throw new Error(data.error ?? `HTTP ${res.status}`);
      onValue(data.value);
      if (data.warnings && data.warnings.length > 0) {
        setSuggestNotice(data.warnings.map((w) => w.evidence).join(" "));
      }
    } catch (e) {
      setSuggestNotice(e instanceof Error ? e.message : "Error generando sugerencia");
    } finally {
      setBusyField(null);
    }
  }

  async function handleReview() {
    const id = await saveDraft();
    if (!id) return;
    router.push(`/command/crear/${id}/revisar`);
  }

  // The left tree's "Revisión" node is always clickable (mirrors free step navigation), but it
  // must respect the same readiness gate as the "Revisar y publicar" button — jump to the step
  // that still has missing fields instead of saving+navigating an incomplete draft.
  function handleTreeReviewClick() {
    if (!ready) {
      setStep(3);
      return;
    }
    void handleReview();
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Sin cuentas de Google Ads conectadas"
          hint="Conecta y habilita una cuenta en Conexiones antes de construir una campaña."
        />
      </Card>
    );
  }

  const ctx: StepCtx = { state, patch, account, accounts, selectAccount, busyField, suggest, accountLocked: Boolean(blueprintId) };
  const elementCount = 1 + 1 + 1 + 1 + doc.campaign.adGroups[0].ads[0].headlines.length + doc.campaign.adGroups[0].ads[0].descriptions.length;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "250px minmax(0,1fr) 292px", gap: 18, alignItems: "start" }} className="cc-builder-grid">
      <style>{`@media (max-width: 980px) { .cc-builder-grid { grid-template-columns: 1fr !important; } }`}</style>

      <StructureTree step={step} onStep={setStep} state={state} ready={ready} onReviewClick={handleTreeReviewClick} />

      <Card style={{ padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: UI.faint }}>
            {saving ? "Guardando…" : lastSavedAt ? `Guardado ${new Date(lastSavedAt).toLocaleTimeString("es-MX")}` : "Sin guardar"}
          </span>
          <button
            type="button"
            onClick={() => void saveDraft()}
            disabled={saving}
            style={{
              border: `1px solid ${UI.borderStrong}`,
              background: "none",
              color: UI.muted,
              borderRadius: UI.radiusSm,
              padding: "6px 12px",
              fontSize: 12.5,
              cursor: saving ? "default" : "pointer",
              opacity: saving ? 0.5 : 1,
            }}
          >
            Guardar borrador
          </button>
        </div>

        {saveError ? <ErrorCard message={saveError} style={{ marginBottom: 16 }} /> : null}
        {suggestNotice ? (
          <p style={{ color: UI.muted, fontSize: 12.5, marginBottom: 16 }}>{suggestNotice}</p>
        ) : null}

        {step === 0 ? <StepObjetivo ctx={ctx} onNext={() => setStep(1)} /> : null}
        {step === 1 ? <StepPresupuesto ctx={ctx} onBack={() => setStep(0)} onNext={() => setStep(2)} /> : null}
        {step === 2 ? <StepGrupo ctx={ctx} onBack={() => setStep(1)} onNext={() => setStep(3)} /> : null}
        {step === 3 ? (
          <StepAnuncio ctx={ctx} onBack={() => setStep(2)} onReview={() => void handleReview()} reviewDisabled={!ready} />
        ) : null}

        {step === 3 && !ready ? (
          <ul style={{ marginTop: 12, paddingLeft: 18, fontSize: 12.5, color: UI.faint }}>
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
      </Card>

      <div style={{ position: "sticky", top: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        {step === 3 ? <SerpPreview state={state} /> : null}
        <RunningSummary account={account} state={state} />
        <PausedBadge elementCount={elementCount} />
      </div>
    </div>
  );
}
