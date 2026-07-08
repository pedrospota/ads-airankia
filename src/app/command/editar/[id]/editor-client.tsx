"use client";

// The Editar workbench: left live tree, center per-node editor, right SERP
// preview + diff counter. Holds the GoogleSearchEditDoc in React state,
// debounced-autosaves it (PUT, whole doc — the server merges via mergeEditDoc so
// client edits to base/resourceNames are silently ignored), and navigates to the
// (future) review screen on "Revisar cambios". Never touches the live account —
// publishing happens on that later screen. Mirrors crear/builder-client.tsx.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, ErrorCard, PageHeader, PrimaryButton, UI } from "@/components/ui-kit";
import type { GoogleSearchEditDoc } from "@/lib/command/edit/schema";
import {
  clearProv,
  resolveNode,
  stampProv,
  type BlueprintPatch,
  type ProvenanceMap,
} from "@/lib/command/patch/schema";
import { applyBlueprintPatch, type ApplyPatchResult } from "@/lib/command/patch/apply";
import { CopilotoDock } from "@/components/command/copiloto-dock";
import { countEdits, type NodeSelection } from "./editor-types";
import { NodePanel } from "./editor-panels";
import { ActiveBanner, AdSerpPreview, DiffSummary, LiveTree } from "./editor-preview";

const AUTOSAVE_DELAY_MS = 1200;

interface SaveResponse {
  blueprint?: { id: string };
  error?: string;
}
interface EditResponse {
  id?: string;
  error?: string;
}

// v2.4 Copiloto — read-only counterpart to apply.ts's writeOp, scoped to the google_edit
// WRITABLE_FIELDS set only (editor-client is edit-only, unlike the proposal card which needs
// both docKinds). Used ONLY to detect whether a manual edit touched a field that carries an
// 'ia' provenance entry (see clearProvForDiff below) — never a write path.
function readEditField(doc: GoogleSearchEditDoc, nodeId: string, field: string): unknown {
  const c = doc.campaign;
  if (nodeId === "campaign" || nodeId === c.resourceName) {
    if (field === "desired.status") return c.desired.status;
    if (field === "desired.dailyBudgetMicros") return c.desired.dailyBudgetMicros;
    if (field === "newNegatives") return c.newNegatives;
    if (field === "removeNegatives") return c.removeNegatives;
    return undefined;
  }
  for (const ag of c.adGroups) {
    if (ag.resourceName === nodeId) {
      if (field === "desired.status") return ag.desired.status;
      if (field === "desired.cpcBidMicros") return ag.desired.cpcBidMicros;
      if (field === "newKeywords") return ag.newKeywords;
      if (field === "newAds") return ag.newAds;
      return undefined;
    }
    for (const kw of ag.baseKeywords) {
      if (kw.resourceName === nodeId) return field === "desiredStatus" ? kw.desiredStatus : undefined;
    }
    for (const ad of ag.ads) {
      if (ad.resourceName === nodeId) return field === "replacement" ? ad.replacement : undefined;
    }
  }
  return undefined;
}

// v2.4 Copiloto — the ia→manual downgrade (spec §b), generalized to editor-panels.tsx's
// `onChange((d) => ...)` shape: unlike the builder's field-named `patch()`, an arbitrary
// doc-to-doc updater doesn't name which fields it touched, so this diffs every prov-'ia' key
// between before/after and clears any whose live value actually changed.
function clearProvForDiff(before: GoogleSearchEditDoc, after: GoogleSearchEditDoc, prov: ProvenanceMap): ProvenanceMap {
  let next = prov;
  for (const key of Object.keys(prov)) {
    const sep = key.lastIndexOf(":");
    if (sep <= 0) continue;
    const nodeId = key.slice(0, sep);
    const field = key.slice(sep + 1);
    if (JSON.stringify(readEditField(before, nodeId, field)) !== JSON.stringify(readEditField(after, nodeId, field))) {
      next = clearProv(next, key);
    }
  }
  return next;
}

export default function EditorClient({
  blueprintId,
  doc: initialDoc,
  status,
  connectionId,
  accountRef,
  initialProv,
}: {
  blueprintId: string;
  doc: GoogleSearchEditDoc;
  status: string;
  connectionId: string | null;
  accountRef: string;
  /** v2.4 Copiloto — the RAW `_prov` off the loaded blueprint (page.tsx reads it before
   * parseEditDoc strips it). Optional so this component keeps compiling for any other caller. */
  initialProv?: ProvenanceMap;
}) {
  const router = useRouter();
  const [doc, setDoc] = useState<GoogleSearchEditDoc>(initialDoc);
  const [prov, setProv] = useState<ProvenanceMap>(initialProv ?? {});
  const [selected, setSelected] = useState<NodeSelection>({ kind: "campaign" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  // spec §d "✦ Pedir al copiloto" shortcut — bumped by the selected-node panel's button to
  // force the dock open with a seeded prompt (see copiloto-dock.tsx's openSignal/seedPrompt).
  const [copilotoSignal, setCopilotoSignal] = useState(0);
  const [copilotoSeed, setCopilotoSeed] = useState<string | undefined>(undefined);
  function requestCopiloto(prompt: string) {
    setCopilotoSeed(prompt);
    setCopilotoSignal((n) => n + 1);
  }

  const n = useMemo(() => countEdits(doc), [doc]);

  // The SINGLE choke point for every MANUAL field write in the editor (every panel's onChange
  // routes through here) — diffs the update against the current `doc` (read from closure, not
  // a functional setState updater, so `clearProvForDiff` never risks running twice under
  // StrictMode's double-invoke) and downgrades any touched 'ia' field to manual.
  function updateDoc(fn: (d: GoogleSearchEditDoc) => GoogleSearchEditDoc) {
    const next = fn(doc);
    setProv((prev) => clearProvForDiff(doc, next, prev));
    setDoc(next);
  }

  async function saveNow(current: GoogleSearchEditDoc): Promise<boolean> {
    setSaving(true);
    setSaveError(null);
    try {
      // v2.4 Copiloto: the PUT carries `_prov` — the server's edit branch (route.ts, Task 4)
      // re-validates every key against the MERGED doc via sanitizeProv and derives `_ai`
      // before saving; this client never re-derives `_ai` itself for edit docs.
      const docToSave = Object.keys(prov).length > 0 ? { ...current, _prov: prov } : current;
      const res = await fetch(`/api/command/blueprint/${blueprintId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: docToSave }),
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

  // Debounced autosave, mirrors crear/builder-client.tsx: skip the very first render
  // (that's just the server-loaded doc, nothing to save yet).
  const skipFirst = useRef(true);
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const t = setTimeout(() => {
      void saveNow(doc);
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  async function handleReload() {
    if (!connectionId) {
      setReloadError("A este borrador le falta la conexión de la cuenta; no se puede recargar.");
      return;
    }
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
          network: "google_ads",
          connection_id: connectionId,
          account_ref: accountRef,
          campaign_id: doc.campaign.id,
        }),
      });
      const data = (await res.json()) as EditResponse;
      if (!res.ok || !data.id) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.replace(`/command/editar/${data.id}`);
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : "Error recargando la campaña");
    } finally {
      setReloading(false);
    }
  }

  async function handleReview() {
    const ok = await saveNow(doc);
    if (!ok) return;
    router.push(`/command/editar/${blueprintId}/revisar`);
  }

  // v2.4 Copiloto dock — Accept re-runs the SAME applyBlueprintPatch chokepoint against the
  // LIVE doc (never a stale snapshot); on success, stamp `_prov` from the chokepoint's own
  // `touched` report (canonical resourceNames, matching what sanitizeProv/deriveAiMarkers
  // expect on the server) and setDoc — the existing debounced autosave picks it up.
  function handleAcceptPatch(patch: BlueprintPatch): ApplyPatchResult {
    const result = applyBlueprintPatch({ docKind: "google_edit", doc }, patch);
    if (result.ok) {
      const keys = result.touched.map((t) => `${t.nodeId}:${t.field}`);
      setProv((prev) => stampProv(prev, keys));
      setDoc(result.doc as GoogleSearchEditDoc);
    }
    return result;
  }

  // "Ver nodo" — resolve the patch's nodeId to the editor's own NodeSelection shape.
  function handleSelectNode(nodeId: string) {
    const resolved = resolveNode(doc, nodeId);
    if (!resolved) return;
    if (resolved.kind === "campaign") {
      setSelected({ kind: "campaign" });
    } else if (resolved.kind === "adGroup") {
      setSelected({ kind: "adGroup", groupRef: resolved.canonicalId });
    } else if (resolved.kind === "baseKeyword") {
      const ag = doc.campaign.adGroups.find((g) => g.baseKeywords.some((k) => k.resourceName === resolved.canonicalId));
      if (ag) setSelected({ kind: "keywords", groupRef: ag.resourceName });
    } else if (resolved.kind === "ad") {
      const ag = doc.campaign.adGroups.find((g) => g.ads.some((a) => a.resourceName === resolved.canonicalId));
      if (ag) setSelected({ kind: "ad", groupRef: ag.resourceName, adRef: resolved.canonicalId });
    }
  }

  return (
    <div>
      <PageHeader
        title={
          <>
            Editar campaña — <em style={{ fontStyle: "italic", color: UI.accent }}>{doc.campaign.base.name}</em>
          </>
        }
        subtitle="Los cambios se autoguardan en este borrador. Nada toca la cuenta en vivo hasta que revises y publiques en la siguiente pantalla."
      />

      {status !== "draft" ? (
        <ErrorCard message={`Este borrador ya no está en edición (estado: ${status}).`} style={{ marginBottom: 16 }} />
      ) : null}

      <div
        style={{ display: "grid", gridTemplateColumns: "270px minmax(0,1fr) 300px", gap: 18, alignItems: "start" }}
        className="cc-editor-grid"
      >
        <style>{`@media (max-width: 1040px) { .cc-editor-grid { grid-template-columns: 1fr !important; } }`}</style>

        <LiveTree
          doc={doc}
          selected={selected}
          onSelect={setSelected}
          onReload={() => void handleReload()}
          reloading={reloading}
          reloadError={reloadError}
        />

        <Card style={{ padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 12, color: UI.faint }}>
              {saving ? "Guardando…" : lastSavedAt ? `Guardado ${new Date(lastSavedAt).toLocaleTimeString("es-MX")}` : "Sin cambios guardados"}
            </span>
          </div>
          {saveError ? <ErrorCard message={saveError} style={{ marginBottom: 16 }} /> : null}

          <NodePanel doc={doc} selected={selected} onSelect={setSelected} onChange={updateDoc} prov={prov} onRequestCopiloto={requestCopiloto} />
        </Card>

        <div style={{ position: "sticky", top: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          {doc.campaign.base.status === "ENABLED" ? <ActiveBanner /> : null}
          <AdSerpPreview doc={doc} selected={selected} />
          <DiffSummary n={n} />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <PrimaryButton onClick={() => void handleReview()} disabled={n === 0}>
          Revisar cambios ({n})
        </PrimaryButton>
      </div>

      <CopilotoDock
        docKind="google_edit"
        blueprintId={blueprintId}
        accountRef={accountRef}
        getDoc={() => doc}
        onAccept={handleAcceptPatch}
        onSelectNode={handleSelectNode}
        openSignal={copilotoSignal}
        seedPrompt={copilotoSeed}
      />
    </div>
  );
}
