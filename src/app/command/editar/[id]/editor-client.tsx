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

export default function EditorClient({
  blueprintId,
  doc: initialDoc,
  status,
  connectionId,
  accountRef,
}: {
  blueprintId: string;
  doc: GoogleSearchEditDoc;
  status: string;
  connectionId: string | null;
  accountRef: string;
}) {
  const router = useRouter();
  const [doc, setDoc] = useState<GoogleSearchEditDoc>(initialDoc);
  const [selected, setSelected] = useState<NodeSelection>({ kind: "campaign" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const n = useMemo(() => countEdits(doc), [doc]);

  function updateDoc(fn: (d: GoogleSearchEditDoc) => GoogleSearchEditDoc) {
    setDoc(fn);
  }

  async function saveNow(current: GoogleSearchEditDoc): Promise<boolean> {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/command/blueprint/${blueprintId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: current }),
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

          <NodePanel doc={doc} selected={selected} onSelect={setSelected} onChange={updateDoc} />
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
    </div>
  );
}
