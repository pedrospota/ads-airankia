"use client";

// Command Center v2.4 "Copiloto Anclado" — the docked chat panel (spec §c), mounted in BOTH
// the Google create builder and the Google edit workbench. Owns only UI state (open/closed,
// the in-memory conversation, the accumulated proposals + their accept/reject status) — every
// actual mutation is delegated to the caller's `onAccept`, which already runs the SAME
// applyBlueprintPatch chokepoint the builder/editor's own accept paths use. This file's import
// surface is deliberately narrow: patch/schema+apply TYPES, ui-kit, and the sibling
// copiloto-proposal-card — never executor/gates/actions-repo (the covenant: propose→accept,
// enforced by never importing a path that could execute anything).

import { useEffect, useRef, useState } from "react";
import type { CcBlueprintDoc } from "@/lib/command/blueprint/schema";
import type { GoogleSearchEditDoc } from "@/lib/command/edit/schema";
import type { BlueprintPatch, DocKind } from "@/lib/command/patch/schema";
import type { ApplyPatchResult, PatchTarget } from "@/lib/command/patch/apply";
import type { Proposal } from "@/lib/command/patch/tool-executors";
import { UI } from "@/components/ui-kit";
import { CopilotoProposalCard, type ProposalCardStatus } from "./copiloto-proposal-card";

export interface CopilotoDockProps {
  docKind: DocKind;
  blueprintId: string;
  accountRef: string;
  /** CURRENT in-memory doc (incl. unsaved edits) — called fresh on every render, so proposal
   * cards always diff against the LIVE doc, never a stale snapshot from when the turn ran. */
  getDoc: () => CcBlueprintDoc | GoogleSearchEditDoc;
  /** Parent applies the patch (same applyBlueprintPatch the builder/editor already use),
   * stamps `_prov`, and lets the existing debounced autosave pick it up. */
  onAccept: (patch: BlueprintPatch) => ApplyPatchResult;
  /** "Ver nodo" — editor NodeSelection / builder step jump. Optional: the dock still works
   * (Aceptar/Rechazar only) without it. */
  onSelectNode?: (nodeId: string) => void;
  /** v2.4 spec §d "✦ Pedir al copiloto" shortcut — imperative open. The host bumps this
   * (any change, e.g. a counter incremented on click) to force the dock open regardless of
   * its current internal open/collapsed state; undefined/unchanged is a no-op. Paired with
   * `seedPrompt` so a per-section shortcut button can also prefill (never auto-send) the
   * input. */
  openSignal?: number;
  /** Prefilled into the input the moment `openSignal` changes — the operator still has to
   * press Enviar; this never sends on the host's behalf. */
  seedPrompt?: string;
}

type ChatMessage = { role: "user" | "assistant"; content: string };

interface CopilotoApiResponse {
  reply?: string;
  proposals?: Proposal[];
  toolsUsed?: string[];
  error?: string;
}

// Mirrors the route's own bound (spec §adjudication 4) — a client-side trim only; the server
// re-trims authoritatively, so this never needs to be exactly in sync to stay safe.
const MAX_HISTORY = 12;
// A distinct color from the ui-kit accent (green) — the spec calls for a violet dot
// specifically so a pending copiloto card reads as a different kind of signal than the
// app's usual positive/accent green.
const PENDING_DOT_COLOR = "#8b5cf6";

const EXAMPLE_CHIPS: Record<DocKind, string[]> = {
  google_create: [
    "Sugiere 5 palabras clave más para este grupo.",
    "Propón 2 títulos adicionales para el anuncio.",
    "¿El presupuesto diario es razonable para el objetivo?",
  ],
  google_edit: [
    "¿Qué negativas debería agregar según las palabras clave actuales?",
    "Sugiere un ajuste de CPC para este grupo de anuncios.",
    "Redacta un anuncio de reemplazo para el anuncio actual.",
  ],
};

function toPatchTarget(docKind: DocKind, doc: CcBlueprintDoc | GoogleSearchEditDoc): PatchTarget {
  return docKind === "google_create"
    ? { docKind, doc: doc as CcBlueprintDoc }
    : { docKind, doc: doc as GoogleSearchEditDoc };
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "90%",
        background: isUser ? UI.accentSoft : UI.surface2,
        border: `1px solid ${UI.border}`,
        borderRadius: UI.radiusSm,
        padding: "8px 12px",
        fontSize: 13,
        color: UI.text,
        whiteSpace: "pre-wrap",
        lineHeight: 1.45,
      }}
    >
      {message.content}
    </div>
  );
}

function EmptyBody({ docKind, onPick }: { docKind: DocKind; onPick: (text: string) => void }) {
  return (
    <div>
      <p style={{ fontSize: 13, color: UI.muted, margin: "0 0 12px", lineHeight: 1.5 }}>
        Pídeme propuestas sobre este borrador. Nunca aplico nada sin tu Aceptar.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {EXAMPLE_CHIPS[docKind].map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => onPick(chip)}
            style={{
              textAlign: "left",
              border: `1px solid ${UI.border}`,
              background: UI.surface2,
              color: UI.muted,
              borderRadius: UI.radiusSm,
              padding: "8px 10px",
              fontSize: 12.5,
              cursor: "pointer",
            }}
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CopilotoDock({ docKind, blueprintId, accountRef, getDoc, onAccept, onSelectNode, openSignal, seedPrompt }: CopilotoDockProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ProposalCardStatus>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // spec §d "✦ Pedir al copiloto" shortcut — a host bumps `openSignal` to force this open from
  // outside (a step header / panel header button), optionally seeding the input. Tracks the
  // LAST handled value so the initial mount (where openSignal already equals its own starting
  // value) never spuriously pops the dock open; only an actual CHANGE does.
  const lastOpenSignal = useRef(openSignal);
  useEffect(() => {
    if (openSignal === undefined || openSignal === lastOpenSignal.current) return;
    lastOpenSignal.current = openSignal;
    setOpen(true);
    if (seedPrompt) setInput(seedPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  // Esc collapses — only listens while open, mirrors command-palette.tsx's pattern but scoped
  // to a global keydown (this panel is non-modal: it never blocks the builder/editor behind it).
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, proposals]);

  const hasPending = Object.values(statuses).some((s) => s === "pending");

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    const nextMessages = [...messages, { role: "user" as const, content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/command/copiloto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.slice(-MAX_HISTORY),
          docKind,
          blueprintId,
          doc: getDoc(),
        }),
      });
      const data = (await res.json()) as CopilotoApiResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.reply) setMessages((prev) => [...prev, { role: "assistant", content: data.reply as string }]);
      const newProposals = data.proposals ?? [];
      if (newProposals.length > 0) {
        setProposals((prev) => [...prev, ...newProposals]);
        setStatuses((prev) => {
          const next = { ...prev };
          for (const p of newProposals) next[p.id] = "pending";
          return next;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "El Copiloto no pudo responder. Inténtalo de nuevo.");
    } finally {
      setLoading(false);
    }
  }

  function handleAccept(proposal: Proposal) {
    const patch: BlueprintPatch = { docKind, summary: proposal.summary, ops: proposal.ops };
    const result = onAccept(patch);
    setStatuses((prev) => ({ ...prev, [proposal.id]: result.ok ? "accepted" : "stale" }));
  }

  function handleReject(id: string) {
    setStatuses((prev) => ({ ...prev, [id]: "rejected" }));
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir Copiloto"
        title={`Copiloto · cuenta ${accountRef}`}
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          zIndex: 150,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          borderRadius: 999,
          border: `1px solid ${UI.borderStrong}`,
          background: UI.surface,
          color: UI.text,
          padding: "10px 18px",
          fontSize: 13.5,
          fontWeight: 600,
          cursor: "pointer",
          boxShadow: "0 12px 30px rgba(0,0,0,0.35)",
        }}
      >
        <span aria-hidden="true">✦</span>
        Copiloto
        {hasPending ? (
          <span
            aria-hidden="true"
            style={{ width: 8, height: 8, borderRadius: 999, background: PENDING_DOT_COLOR, flexShrink: 0 }}
          />
        ) : null}
      </button>
    );
  }

  const doc = getDoc();
  const target = toPatchTarget(docKind, doc);

  return (
    <div
      role="dialog"
      aria-label="Copiloto"
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        zIndex: 150,
        width: "min(380px, calc(100vw - 32px))",
        maxHeight: "min(640px, calc(100vh - 96px))",
        display: "flex",
        flexDirection: "column",
        background: UI.surface,
        border: `1px solid ${UI.border}`,
        borderTopColor: UI.borderTop,
        borderRadius: UI.radius,
        boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: `1px solid ${UI.border}`,
          flexShrink: 0,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14, color: UI.text }}>
          <span aria-hidden="true">✦</span>
          Copiloto
          {hasPending ? (
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: PENDING_DOT_COLOR }} />
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Cerrar Copiloto"
          style={{ background: "none", border: "none", color: UI.faint, fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 4 }}
        >
          ✕
        </button>
      </div>

      <div ref={bodyRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.length === 0 && proposals.length === 0 ? (
          <EmptyBody docKind={docKind} onPick={(text) => setInput(text)} />
        ) : (
          messages.map((m, i) => <MessageBubble key={i} message={m} />)
        )}

        {proposals.map((p) => (
          <CopilotoProposalCard
            key={p.id}
            proposal={p}
            target={target}
            status={statuses[p.id] ?? "pending"}
            onAccept={() => handleAccept(p)}
            onReject={() => handleReject(p.id)}
            onSelectNode={onSelectNode}
          />
        ))}

        {loading ? <span style={{ fontSize: 12.5, color: UI.faint }}>Pensando…</span> : null}
        {error ? <span style={{ fontSize: 12.5, color: UI.danger }}>{error}</span> : null}
      </div>

      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: `1px solid ${UI.border}`, flexShrink: 0 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          placeholder="Pregúntale al Copiloto…"
          aria-label="Mensaje para el Copiloto"
          rows={1}
          style={{
            flex: 1,
            minHeight: 36,
            maxHeight: 96,
            resize: "vertical",
            background: UI.surface2,
            border: `1px solid ${UI.border}`,
            borderRadius: UI.radiusSm,
            color: UI.text,
            padding: "8px 10px",
            fontSize: 13,
            fontFamily: "inherit",
          }}
        />
        <button
          type="button"
          onClick={() => void send(input)}
          disabled={loading || !input.trim()}
          style={{
            border: "1px solid transparent",
            background: UI.text,
            color: UI.bg,
            borderRadius: UI.radiusSm,
            padding: "0 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: loading || !input.trim() ? "default" : "pointer",
            opacity: loading || !input.trim() ? 0.5 : 1,
          }}
        >
          Enviar
        </button>
      </div>
    </div>
  );
}
