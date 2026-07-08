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
import { blueprintDocSchema, type CcBlueprintDoc } from "@/lib/command/blueprint/schema";
import type { SuggestKind } from "@/lib/command/blueprint/suggest";
import type { GateResult } from "@/lib/command/types";
import {
  clearProv,
  deriveAiMarkers,
  resolveNode,
  stampProv,
  type BlueprintPatch,
  type ProvenanceMap,
} from "@/lib/command/patch/schema";
import { applyBlueprintPatch, type ApplyPatchResult } from "@/lib/command/patch/apply";
import { CopilotoDock } from "@/components/command/copiloto-dock";
import { PausedBadge, RunningSummary, SerpPreview, StructureTree } from "./builder-preview";
import { StepAnuncio, StepGrupo, StepObjetivo, StepPresupuesto, type StepCtx } from "./builder-steps";
import {
  buildDoc,
  initialBuilderState,
  missingSteps,
  newBuilderIds,
  stateFromDoc,
  type BuilderIds,
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

// v2.4 Copiloto — maps a BuilderState key touched by patch()/applySuggestion() to the
// canonical `${nodeId}:${field}` provenance key(s) it corresponds to in the compiled create
// doc (patch/schema.ts's WRITABLE_FIELDS.google_create). BuilderState's shape doesn't mirror
// CcBlueprintDoc 1:1 (e.g. dailyAmount is currency units, a string; the doc field is
// dailyMicros) — spelled out explicitly rather than guessed, same reasoning buildDoc/
// stateFromDoc document for their own field-by-field mapping. UI-only keys (accountRef, goal)
// resolve to no doc field, so they never touch `prov` — deliberately not listed below.
function provKeysForStateKeys(ids: BuilderIds, keys: Array<keyof BuilderState>): string[] {
  const has = (k: keyof BuilderState) => keys.includes(k);
  const out: string[] = [];
  if (has("campaignName")) out.push(`${ids.campaignNodeId}:name`);
  if (has("bidding") || has("targetCpaAmount") || has("targetRoas")) out.push(`${ids.campaignNodeId}:bidding`);
  if (has("countryCodes") || has("presenceOnly")) out.push(`${ids.campaignNodeId}:geo`);
  if (has("languageCode")) out.push(`${ids.campaignNodeId}:languageCode`);
  if (has("dailyAmount")) out.push(`${ids.budgetNodeId}:dailyMicros`);
  if (has("groupName")) out.push(`${ids.adGroupNodeId}:name`);
  if (has("keywords")) out.push(`${ids.adGroupNodeId}:keywords`);
  if (has("negatives")) out.push(`${ids.adGroupNodeId}:negatives`);
  if (has("finalUrl")) out.push(`${ids.adNodeId}:finalUrl`);
  if (has("headlines")) out.push(`${ids.adNodeId}:headlines`);
  if (has("descriptions")) out.push(`${ids.adNodeId}:descriptions`);
  if (has("path1")) out.push(`${ids.adNodeId}:path1`);
  if (has("path2")) out.push(`${ids.adNodeId}:path2`);
  return out;
}

/** Mirrors patch/schema.ts's `attachProvenance` for the create doc: the create POST/PUT
 * already saves the RAW body.doc (route.ts), so `_prov`/`_ai` ride along for free — no server
 * plumbing change needed on this side (spec §b). Omits both siblings entirely when there is
 * nothing to attach, so a draft with zero AI-accepted fields never grows empty-object noise. */
function attachBuilderProvenance(doc: CcBlueprintDoc, prov: ProvenanceMap): CcBlueprintDoc & { _prov?: ProvenanceMap; _ai?: string[] } {
  if (Object.keys(prov).length === 0) return doc;
  return { ...doc, _prov: prov, _ai: deriveAiMarkers(doc, prov) };
}

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
  // v2.4 Copiloto — this NEW draft never loads an existing doc (crear/page.tsx always starts
  // fresh), so there is no raw `_prov` to seed from; every entry is either stamped by an
  // accepted propose_patch op (handleAcceptPatch) or an accepted ✨ suggest (applySuggestion).
  const [prov, setProv] = useState<ProvenanceMap>({});

  const account = useMemo(() => accounts.find((a) => a.accountRef === state.accountRef) ?? null, [accounts, state.accountRef]);

  // The SINGLE choke point for every MANUAL field write in the builder (every step's
  // onChange routes through StepCtx.patch, which is this function) — downgrades any touched
  // field's provenance to manual by clearing its `_prov` entry (spec §b's ia→manual
  // enforcement). ✨ suggest deliberately does NOT go through here — see applySuggestion below.
  function patch(p: Partial<BuilderState>) {
    const keys = provKeysForStateKeys(idsRef.current, Object.keys(p) as Array<keyof BuilderState>);
    if (keys.length > 0) {
      setProv((prev) => keys.reduce((acc, k) => clearProv(acc, k), prev));
    }
    setState((s) => ({ ...s, ...p }));
  }

  // The second (and only other) writer of 'ia': an accepted ✨ per-field suggestion is, like an
  // accepted propose_patch op, an AI-authored value the operator chose to keep — spec §b closes
  // "today's gap where AI-authored values are indistinguishable from typed ones" by stamping
  // both through the same ProvenanceMap.
  function applySuggestion(p: Partial<BuilderState>) {
    const keys = provKeysForStateKeys(idsRef.current, Object.keys(p) as Array<keyof BuilderState>);
    if (keys.length > 0) {
      setProv((prev) => stampProv(prev, keys));
    }
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
      // v2.4 Copiloto: attach `_prov` + the derived `_ai` markers (spec §b) — the create
      // POST/PUT already saves the RAW body.doc (route.ts), so both raw-jsonb siblings ride
      // along for free once attached here; no server plumbing change needed on this side.
      const docToSave = attachBuilderProvenance(doc, prov);
      if (!blueprintId) {
        const res = await fetch("/api/command/blueprint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            network: "google_ads",
            account_ref: account.accountRef,
            connection_id: account.connectionId,
            doc: docToSave,
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
        body: JSON.stringify({ doc: docToSave }),
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

  // v2.4 Copiloto dock — Accept re-runs the SAME applyBlueprintPatch chokepoint the plan
  // spells out verbatim: apply against the freshly built LIVE doc (never a stale snapshot),
  // then on success rehydrate BuilderState via the Task 3 bijection and stamp `_prov` from
  // exactly what the chokepoint reports as `touched` (never from the model's raw ops — a
  // touched entry's `nodeId` is the CANONICAL id, matching what deriveAiMarkers/sanitizeProv
  // expect). Both setState calls land in the same handler, so the debounced autosave's
  // `[state, blueprintId]` effect re-fires once, picking up the accepted change.
  function handleAcceptPatch(patch: BlueprintPatch): ApplyPatchResult {
    const result = applyBlueprintPatch({ docKind: "google_create", doc: buildDoc(state, idsRef.current) }, patch);
    if (result.ok) {
      const keys = result.touched.map((t) => `${t.nodeId}:${t.field}`);
      setProv((prev) => stampProv(prev, keys));
      setState((s) => stateFromDoc(result.doc as CcBlueprintDoc, s));
    }
    return result;
  }

  // "Ver nodo" — jump the step wizard to whichever step owns the resolved node. Best-effort:
  // an unresolvable nodeId (shouldn't happen — the card only offers nodes the live doc had at
  // render time) is a silent no-op rather than a crash.
  function handleSelectNode(nodeId: string) {
    const resolved = resolveNode(doc, nodeId);
    if (!resolved) return;
    if (resolved.kind === "campaign") setStep(0);
    else if (resolved.kind === "budget") setStep(1);
    else if (resolved.kind === "adGroup") setStep(2);
    else if (resolved.kind === "ad") setStep(3);
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

  const ctx: StepCtx = {
    state,
    patch,
    account,
    accounts,
    selectAccount,
    busyField,
    suggest,
    accountLocked: Boolean(blueprintId),
    applySuggestion,
    prov,
    ids: idsRef.current,
  };
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
        <RunningSummary account={account} state={state} prov={prov} />
        <PausedBadge elementCount={elementCount} />
      </div>

      {/* v2.4 Copiloto dock — only once a draft exists: /api/command/copiloto grounds against
          a STORED blueprint (it loads by blueprintId), so the dock has nothing to patch before
          the first save. The dock never creates a draft itself, only proposes patches onto an
          open one (spec §d "the dock never creates, only patches an open draft"). */}
      {blueprintId ? (
        <CopilotoDock
          docKind="google_create"
          blueprintId={blueprintId}
          accountRef={account?.accountRef ?? ""}
          getDoc={() => buildDoc(state, idsRef.current)}
          onAccept={handleAcceptPatch}
          onSelectNode={handleSelectNode}
        />
      ) : null}
    </div>
  );
}
