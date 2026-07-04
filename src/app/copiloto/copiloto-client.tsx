"use client";

/**
 * Copiloto — chat over the user's OWN measured Google Ads data.
 *
 * Talks to POST /api/copiloto with { messages: [{role, content}], mode } and
 * renders { reply, toolsUsed, mode }. Quiet, premium, single 760px column:
 * welcome state with suggestion cards, right-aligned user bubbles,
 * left-aligned assistant turns with "consultó:" tool chips, and a sticky
 * composer at the column bottom (Enter sends, Shift+Enter newline).
 *
 * Modes (two-pill toggle next to the composer): "Solo lectura" and "Dry-run".
 * Dry-run offers the model SIMULATION tools that never touch Google Ads —
 * assistant turns that used them get a "SIMULACIÓN" chip, and record_proposal
 * (a propose-only Approval the human applies via Google Ads Editor) gets a
 * "propuesta registrada" chip. There is NO write mode.
 */

import { Fragment, useEffect, useRef, useState } from "react";
import { Badge, ErrorCard, UI } from "@/components/ui-kit";

// ---------------------------------------------------------------------------
// Types + copy
// ---------------------------------------------------------------------------

/** Client-local copy — copiloto-tools.ts is server-only, never import it here. */
type CopilotoMode = "lectura" | "dryrun";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolsUsed?: string[];
}

interface CopilotoResponse {
  reply?: string;
  toolsUsed?: string[];
  mode?: string;
  error?: string;
}

const SUGGESTIONS: Array<{ q: string; hint: string }> = [
  {
    q: "¿Dónde estoy tirando dinero?",
    hint: "Gasto sin retorno detectado por el optimizador",
  },
  {
    q: "¿Qué movida tiene mejor evidencia esta semana?",
    hint: "Propuestas ordenadas por evidencia medida",
  },
  {
    q: "¿Algo raro en seguridad los últimos 7 días?",
    hint: "Presupuestos, URLs y cambios vigilados",
  },
];

/** Extra suggestion card, only shown while Dry-run is active. */
const DRYRUN_SUGGESTION: { q: string; hint: string } = {
  q: "Simula bajar el presupuesto de mi peor campaña",
  hint: "Preview del cambio — nada se toca en Google Ads",
};

/** Short Spanish labels for the tool chips ("consultó: portfolio, playbook"). */
const TOOL_LABELS: Record<string, string> = {
  get_portfolio: "portfolio",
  get_account: "cuenta",
  get_recommendations: "recomendaciones",
  get_security: "seguridad",
  get_triage: "auditoría MCC",
  get_simulacion: "simulación",
  get_backtest: "backtest",
  get_playbook: "playbook",
  get_scorecard: "scorecard",
  get_salud: "salud",
  get_costs: "costes IA",
  propose_budget_change: "presupuesto (sim)",
  propose_pause_campaign: "pausa (sim)",
  propose_negative_keyword: "negativa (sim)",
  propose_bid_modifier: "puja (sim)",
  record_proposal: "registrar propuesta",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/^get_/, "");
}

/** Write-intent tools (dry-run simulations + the propose-only record). */
function isWriteTool(name: string): boolean {
  return name.startsWith("propose_") || name === "record_proposal";
}

// ---------------------------------------------------------------------------
// Minimal markdown: **bold**, line breaks and "- " lists. No external lib.
// ---------------------------------------------------------------------------

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} style={{ fontWeight: 600, color: UI.text }}>
        {part}
      </strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  );
}

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];

  const flushList = (key: string) => {
    if (list.length === 0) return;
    const items = list;
    list = [];
    blocks.push(
      <ul key={key} style={{ margin: "6px 0", paddingLeft: 20 }}>
        {items.map((item, i) => (
          <li key={i} style={{ margin: "3px 0" }}>
            {renderInline(item)}
          </li>
        ))}
      </ul>
    );
  };

  lines.forEach((line, i) => {
    const listMatch = line.match(/^\s*[-•]\s+(.*)$/);
    if (listMatch) {
      list.push(listMatch[1]);
      return;
    }
    flushList(`ul-${i}`);
    const trimmed = line.trim();
    if (!trimmed) {
      blocks.push(<div key={`sp-${i}`} style={{ height: 8 }} />);
      return;
    }
    // Tolerate "#"-style headings from the model → render as a bold line.
    const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
    blocks.push(
      <p key={`p-${i}`} style={{ margin: "2px 0" }}>
        {heading ? (
          <strong style={{ fontWeight: 600, color: UI.text }}>{heading[1]}</strong>
        ) : (
          renderInline(trimmed)
        )}
      </p>
    );
  });
  flushList("ul-end");

  return <>{blocks}</>;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Sparkle({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2c.62 4.9 3.02 7.4 8 8-4.98.6-7.38 3.1-8 8-.62-4.9-3.02-7.4-8-8 4.98-.6 7.38-3.1 8-8z"
        fill={UI.accent}
        opacity="0.9"
      />
    </svg>
  );
}

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="copiloto-spin"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}

function AssistantLabel() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontWeight: 500,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        color: UI.faint,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 5, height: 5, borderRadius: 999, background: UI.accent }}
      />
      Copiloto
    </span>
  );
}

/**
 * One pill of the mode switch. House style (see DaysSwitcher): borderRadius
 * 999, active gets surface2 + hairline; the Dry-run pill takes a warn-amber
 * tint when active instead.
 */
function ModePill({
  active,
  warn = false,
  onClick,
  children,
}: {
  active: boolean;
  warn?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: "nowrap",
        cursor: "pointer",
        transition: "background 150ms ease, border-color 150ms ease, color 150ms ease",
        color: active ? (warn ? UI.warn : UI.text) : UI.muted,
        background: active
          ? warn
            ? `color-mix(in srgb, ${UI.warn} 12%, transparent)`
            : UI.surface2
          : "transparent",
        border: `1px solid ${
          active
            ? warn
              ? `color-mix(in srgb, ${UI.warn} 30%, transparent)`
              : UI.border
            : "transparent"
        }`,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CopilotoClient() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState<CopilotoMode>("lectura");

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const started = messages.length > 0;

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || loading) return;

    setError(null);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const next: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    setLoading(true);

    try {
      const res = await fetch("/api/copiloto", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          mode,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as CopilotoResponse;
      if (!res.ok || typeof data.reply !== "string" || !data.reply.trim()) {
        throw new Error(
          data.error || "El Copiloto no pudo responder. Vuelve a intentarlo."
        );
      }
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply as string,
          toolsUsed: Array.isArray(data.toolsUsed)
            ? data.toolsUsed.filter((t): t is string => typeof t === "string")
            : [],
        },
      ]);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "El Copiloto no pudo responder. Vuelve a intentarlo."
      );
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  const canSend = !loading && input.trim().length > 0;
  const dryrun = mode === "dryrun";
  const suggestions = dryrun ? [...SUGGESTIONS, DRYRUN_SUGGESTION] : SUGGESTIONS;

  return (
    <div
      style={{
        maxWidth: 760,
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 175px)",
        minHeight: 460,
      }}
    >
      {/* Scoped choreography — no external CSS deps. */}
      <style>{`
        @keyframes copiloto-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        .copiloto-msg { animation: copiloto-rise 260ms cubic-bezier(0.22,1,0.36,1) both; }
        @keyframes copiloto-spin { to { transform: rotate(360deg); } }
        .copiloto-spin { animation: copiloto-spin 0.8s linear infinite; }
        .copiloto-sugg { transition: border-color 150ms ease, background 150ms ease; }
        .copiloto-sugg:hover { border-color: var(--uik-border-strong); background: var(--uik-hover); }
      `}</style>

      {/* ------------------------- Scrollable area ------------------------- */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {!started ? (
          /* Welcome state */
          <div
            className="copiloto-msg"
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              padding: "24px 8px",
            }}
          >
            <Sparkle />
            <h1
              style={{
                fontFamily: UI.fontDisplay,
                fontStyle: "italic",
                fontWeight: 400,
                fontSize: 27,
                letterSpacing: "0.005em",
                lineHeight: 1.2,
                color: UI.text,
                margin: "16px 0 0",
              }}
            >
              ¿Qué quieres saber de tus cuentas?
            </h1>
            <p
              style={{
                fontSize: 13.5,
                color: UI.muted,
                margin: "10px 0 0",
                maxWidth: 440,
                lineHeight: 1.55,
              }}
            >
              Respuestas con tus datos medidos por el optimizador — no consejos
              genéricos. El Copiloto propone; nunca ejecuta cambios.
            </p>

            <div
              className={
                suggestions.length > 3
                  ? "grid grid-cols-1 md:grid-cols-2"
                  : "grid grid-cols-1 md:grid-cols-3"
              }
              style={{ gap: 12, marginTop: 32, width: "100%" }}
            >
              {suggestions.map((s) => (
                <button
                  key={s.q}
                  type="button"
                  className="copiloto-sugg"
                  onClick={() => send(s.q)}
                  style={{
                    textAlign: "left",
                    background: UI.surface,
                    border: `1px solid ${UI.border}`,
                    borderTopColor: UI.borderTop,
                    borderRadius: UI.radius,
                    padding: "16px 16px 14px",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: 500,
                      lineHeight: 1.4,
                      color: UI.text,
                    }}
                  >
                    {s.q}
                  </span>
                  <span style={{ fontSize: 12, lineHeight: 1.45, color: UI.faint }}>
                    {s.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Conversation */
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 22,
              padding: "12px 4px 16px",
            }}
          >
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div
                  key={i}
                  className="copiloto-msg"
                  style={{ display: "flex", justifyContent: "flex-end" }}
                >
                  <div
                    style={{
                      maxWidth: "82%",
                      background: UI.surface2,
                      border: `1px solid ${UI.border}`,
                      borderRadius: 14,
                      borderTopRightRadius: 5,
                      padding: "10px 14px",
                      fontSize: 14,
                      lineHeight: 1.55,
                      color: UI.text,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {m.content}
                  </div>
                </div>
              ) : (
                <div
                  key={i}
                  className="copiloto-msg"
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 6,
                    }}
                  >
                    <AssistantLabel />
                    {(m.toolsUsed ?? []).length > 0 && (
                      <>
                        <span style={{ fontSize: 11, color: UI.faint }}>
                          · consultó:
                        </span>
                        {(m.toolsUsed ?? []).map((t) => (
                          <Badge key={t} tone="muted">
                            {toolLabel(t)}
                          </Badge>
                        ))}
                        {(m.toolsUsed ?? []).some(isWriteTool) && (
                          <Badge tone="warn">SIMULACIÓN</Badge>
                        )}
                        {(m.toolsUsed ?? []).includes("record_proposal") && (
                          <Badge tone="accent">propuesta registrada</Badge>
                        )}
                      </>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      lineHeight: 1.62,
                      color: UI.text,
                      wordBreak: "break-word",
                    }}
                  >
                    <MarkdownLite text={m.content} />
                  </div>
                </div>
              )
            )}

            {loading && (
              <div
                className="copiloto-msg"
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
              >
                <AssistantLabel />
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13.5,
                    fontStyle: "italic",
                    color: UI.muted,
                  }}
                >
                  <Spinner />
                  consultando tus datos…
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---------------------- Composer (column bottom) -------------------- */}
      <div style={{ flexShrink: 0, paddingTop: 12 }}>
        {error && (
          <ErrorCard
            message={error}
            style={{ marginBottom: 10, padding: "10px 14px", fontSize: 13 }}
          />
        )}

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 8,
            background: UI.surface,
            border: `1px solid ${focused ? UI.borderStrong : UI.border}`,
            borderRadius: 14,
            padding: 8,
            paddingLeft: 14,
            transition: "border-color 150ms ease",
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            rows={1}
            disabled={loading}
            placeholder="Pregúntale a tus cuentas…"
            aria-label="Escribe tu pregunta"
            style={{
              flex: 1,
              resize: "none",
              border: "none",
              outline: "none",
              background: "transparent",
              color: UI.text,
              fontSize: 14,
              lineHeight: 1.5,
              fontFamily: "inherit",
              padding: "7px 0",
              maxHeight: 140,
              opacity: loading ? 0.6 : 1,
            }}
          />
          <button
            type="button"
            onClick={() => send(input)}
            disabled={!canSend}
            aria-label="Enviar pregunta"
            style={{
              flexShrink: 0,
              width: 34,
              height: 34,
              borderRadius: 10,
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: canSend ? "pointer" : "not-allowed",
              background: canSend ? UI.accent : UI.surface2,
              color: canSend ? "#04120C" : UI.faint,
              transition: "background 150ms ease",
            }}
          >
            {loading ? (
              <Spinner size={15} />
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            )}
          </button>
        </div>

        {/* Mode switch (junto al campo de texto) + dry-run note */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            margin: "8px 4px 0",
          }}
        >
          <div
            role="group"
            aria-label="Modo del Copiloto"
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            <ModePill active={!dryrun} onClick={() => setMode("lectura")}>
              Solo lectura
            </ModePill>
            <ModePill warn active={dryrun} onClick={() => setMode("dryrun")}>
              Dry-run
            </ModePill>
          </div>
          {dryrun && (
            <span style={{ fontSize: 11, lineHeight: 1.4, color: UI.warn }}>
              Simulación: nada se modifica en Google Ads; puedes registrar
              propuestas.
            </span>
          )}
        </div>

        <p
          style={{
            margin: "8px 4px 0",
            fontSize: 11,
            color: UI.faint,
            textAlign: "center",
            lineHeight: 1.4,
          }}
        >
          Respuestas basadas en tus datos medidos. El Copiloto propone; no
          ejecuta cambios.
        </p>
      </div>
    </div>
  );
}
