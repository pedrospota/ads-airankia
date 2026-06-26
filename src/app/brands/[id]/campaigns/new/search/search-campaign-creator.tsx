"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";
import {
  AGENT_TITLES,
  BUDGET,
  PIPELINE,
  type ActivateResponse,
  type AdGroupAds,
  type AgentId,
  type KeywordResearchOutput,
  type PlannerOutput,
  type RunMode,
  type RunStateDTO,
  type RSAOutput,
  type StartRunRequest,
  type StartRunResponse,
  type StepDTO,
  type StructureOutput,
} from "@/lib/engine/types";

// ---------------------------------------------------------------------------
// Plain-Spanish, friendly copy for each agent in the timeline.
// ---------------------------------------------------------------------------
const AGENT_BLURB: Record<AgentId, string> = {
  planner: "Define tu objetivo, dónde anunciarte y cuánto invertir al día.",
  keyword_researcher: "Busca las palabras que escribe tu cliente en Google.",
  structure_architect: "Ordena todo en grupos para que cada anuncio encaje.",
  rsa_copywriter: "Escribe los títulos y textos de tus anuncios.",
  policy_qa: "Revisa que todo cumpla las reglas de Google antes de publicar.",
  activator: "Crea la campaña en Google Ads (siempre en pausa).",
};

const AGENT_EMOJI: Record<AgentId, string> = {
  planner: "🎯",
  keyword_researcher: "🔎",
  structure_architect: "🧩",
  rsa_copywriter: "✍️",
  policy_qa: "✅",
  activator: "🚀",
};

type DotState = "pending" | "working" | "done" | "failed";

interface SearchCampaignCreatorProps {
  brandId: string;
  brandName: string;
  brandWebsite: string | null;
}

// A live event coming off the SSE stream.
interface StreamEvent {
  type: string;
  data: unknown;
}

export function SearchCampaignCreator({
  brandId,
  brandName: initialBrandName,
  brandWebsite,
}: SearchCampaignCreatorProps) {
  const { colors } = useTheme();

  // ---- Start-card form state --------------------------------------------
  const [brandName, setBrandName] = useState(initialBrandName);
  const [objectiveHint, setObjectiveHint] = useState("");
  const [budgetHint, setBudgetHint] = useState<string>("");
  const [mode, setMode] = useState<RunMode>("auto");

  // ---- Run state ---------------------------------------------------------
  const [runId, setRunId] = useState<string | null>(null);
  const [state, setState] = useState<RunStateDTO | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live, transient text streamed from the agent currently working.
  const [liveLog, setLiveLog] = useState<Partial<Record<AgentId, string>>>({});
  const [activating, setActivating] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [activateResult, setActivateResult] = useState<ActivateResponse | null>(null);

  // The single AbortController guarding the SSE reader. Never leak it.
  const abortRef = useRef<AbortController | null>(null);
  // Track which step we already auto-advanced, so we POST /advance once per step.
  const advancedRef = useRef<Set<string>>(new Set());

  const styles = useMemo(() => makeStyles(colors), [colors]);

  // ---- Abort helper: always clean the reader -----------------------------
  const abortStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  // ---- Refresh run state from the server (source of truth) ---------------
  const refreshState = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/search/runs/${id}`, {
        credentials: "include",
      });
      if (!r.ok) return;
      const next = (await r.json()) as RunStateDTO;
      setState(next);
    } catch {
      /* transient — the stream or a later refresh will recover */
    }
  }, []);

  // ---- Advance the pipeline (start / accept a step / run next) -----------
  const advance = useCallback(
    async (
      id: string,
      body?: { stepId?: string; userOverride?: unknown; action?: "accept" | "run_next" | "regenerate" },
    ) => {
      try {
        await fetch(`/api/search/runs/${id}/advance`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
      } catch {
        /* the stream/state poll will surface the real status */
      } finally {
        void refreshState(id);
      }
    },
    [refreshState],
  );

  // handleEvent (defined below) is always current via this ref, so openStream
  // can keep a stable identity and never re-subscribe the reader.
  const handleEventRef = useRef<(id: string, evt: StreamEvent) => void>(() => {});

  // ---- Open the SSE stream and tail it -----------------------------------
  const openStream = useCallback(
    (id: string) => {
      abortStream();
      const controller = new AbortController();
      abortRef.current = controller;

      (async () => {
        try {
          const res = await fetch(`/api/search/runs/${id}/stream`, {
            credentials: "include",
            headers: { Accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!res.body) {
            await refreshState(id);
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          // Read the stream until it closes or is aborted.
          // SSE frames are separated by a blank line; fields are "type:" / "data:".
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let sep: number;
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              const evt = parseFrame(frame);
              if (evt) handleEventRef.current(id, evt);
            }
          }
        } catch (e) {
          // Aborts are expected on unmount/reset — ignore them.
          if ((e as Error)?.name === "AbortError") return;
          // Any other failure: fall back to the server state.
          await refreshState(id);
        } finally {
          // Stream closed cleanly: reconcile with the source of truth.
          void refreshState(id);
        }
      })();
    },
    [abortStream, refreshState],
  );

  // ---- Handle one parsed SSE event ---------------------------------------
  const handleEvent = useCallback(
    (id: string, evt: StreamEvent) => {
      const agent = pickAgent(evt.data);
      switch (evt.type) {
        case "run_status":
        case "gate":
        case "step_completed":
        case "step_started":
          // Structural change → re-read full state for the timeline.
          void refreshState(id);
          if (evt.type === "step_completed" && agent) {
            setLiveLog((prev) => ({ ...prev, [agent]: "" }));
          }
          break;
        case "decision":
        case "step_progress":
        case "token": {
          const text = pickText(evt.data);
          if (text && agent) {
            setLiveLog((prev) => ({
              ...prev,
              [agent]: ((prev[agent] ?? "") + text).slice(-1200),
            }));
          }
          break;
        }
        case "error": {
          const text = pickText(evt.data);
          if (text) setError(text);
          void refreshState(id);
          break;
        }
        default:
          break;
      }
    },
    [refreshState],
  );

  // Keep openStream pointing at the latest handleEvent without re-subscribing.
  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  // ---- Cleanup on unmount: NEVER leak the reader -------------------------
  useEffect(() => {
    return () => abortStream();
  }, [abortStream]);

  // ---- AUTO mode: auto-advance any step left awaiting approval -----------
  useEffect(() => {
    if (!runId || !state) return;
    if (state.run.status !== "awaiting_approval") return;
    if (state.run.mode !== "auto") return;
    // Don't auto-advance the activation gate — that's the user's one click.
    if (isActivationGate(state)) return;

    const step = currentAwaitingStep(state);
    if (!step) return;
    if (advancedRef.current.has(step.id)) return;
    advancedRef.current.add(step.id);
    void advance(runId, { stepId: step.id, action: "accept" });
  }, [runId, state, advance]);

  // ---- Start a run -------------------------------------------------------
  async function startRun() {
    setError(null);
    setStarting(true);
    advancedRef.current = new Set();
    setLiveLog({});
    setActivateResult(null);
    try {
      const seed: StartRunRequest["seed"] = {
        brandId,
        brandName: brandName.trim() || initialBrandName,
        ...(brandWebsite ? { brandWebsite, landingPageUrl: brandWebsite } : {}),
        ...(objectiveHint.trim() ? { objectiveHint: objectiveHint.trim() } : {}),
        ...(parseBudget(budgetHint) != null
          ? { budgetHintUsd: parseBudget(budgetHint)! }
          : {}),
      };
      const payload: StartRunRequest = { brandId, mode, seed };
      const r = await fetch("/api/search/runs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await r.json()) as StartRunResponse & { error?: string };
      if (!r.ok || data.error || !data.runId) {
        throw new Error(data.error || "No se pudo crear la campaña. Inténtalo de nuevo.");
      }
      setRunId(data.runId);
      // Open the live stream first, then kick the pipeline off.
      openStream(data.runId);
      await advance(data.runId, { action: "run_next" });
      await refreshState(data.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Algo salió mal al empezar.");
    } finally {
      setStarting(false);
    }
  }

  // ---- Accept a step in ASISTIDO mode ------------------------------------
  async function acceptStep(stepId: string, userOverride?: unknown) {
    if (!runId) return;
    advancedRef.current.add(stepId);
    await advance(runId, { stepId, action: "accept", userOverride });
  }

  // ---- Activation chokepoint (the ONE place a run gets activated) --------
  async function activateCampaign() {
    if (!runId) return;
    setActivating(true);
    setError(null);
    try {
      const r = await fetch(`/api/search/runs/${runId}/activate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await r.json()) as ActivateResponse;
      if (!r.ok || data.error) {
        throw new Error(data.error || "No se pudo crear la campaña en Google Ads.");
      }
      setActivateResult(data);
      await refreshState(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo activar.");
    } finally {
      setActivating(false);
    }
  }

  // ---- Enable a paused campaign (guarded /enable) ------------------------
  async function enableCampaign() {
    if (!runId) return;
    setEnabling(true);
    setError(null);
    try {
      const r = await fetch(`/api/search/runs/${runId}/enable`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await r.json()) as ActivateResponse;
      if (!r.ok || data.error) {
        throw new Error(data.error || "No se pudo poner en marcha.");
      }
      setActivateResult(data);
      await refreshState(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo poner en marcha.");
    } finally {
      setEnabling(false);
    }
  }

  // ---- Full reset / retry ------------------------------------------------
  function reset() {
    abortStream();
    advancedRef.current = new Set();
    setRunId(null);
    setState(null);
    setLiveLog({});
    setError(null);
    setActivateResult(null);
    setActivating(false);
    setEnabling(false);
  }

  // -----------------------------------------------------------------------
  // RENDER
  // -----------------------------------------------------------------------
  const showStart = !runId;
  const failed = state?.run.status === "failed";
  const activationGate = !!state && isActivationGate(state) && !activateResult?.ok;
  const enabledNow = activateResult?.enabled === true;
  const pausedDone = activateResult?.ok === true && !enabledNow;

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Brands", href: "/brands" },
          { label: brandName, href: `/brands/${brandId}/citations` },
          { label: "Campaña de Búsqueda" },
        ]}
      />

      <main className="max-w-3xl mx-auto px-6 py-8">
        {/* ---------------- START CARD ---------------- */}
        {showStart && (
          <div>
            <h1 className="text-2xl font-bold mb-1">Nueva campaña de búsqueda</h1>
            <p style={{ color: colors.textMuted, marginBottom: 24, fontSize: 14 }}>
              Cuéntanos qué quieres y 6 ayudantes preparan tu campaña en Google. Tú
              solo das el visto bueno.
            </p>

            <div style={styles.card}>
              <div style={{ marginBottom: 18 }}>
                <label style={styles.lbl}>Nombre de tu marca</label>
                <input
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="Mi negocio"
                  style={styles.inp}
                />
              </div>

              <div style={{ marginBottom: 18 }}>
                <label style={styles.lbl}>¿Qué quieres conseguir?</label>
                <textarea
                  value={objectiveHint}
                  onChange={(e) => setObjectiveHint(e.target.value)}
                  rows={3}
                  placeholder="Ej.: Quiero más reservas para mi restaurante en Madrid"
                  style={{ ...styles.inp, resize: "vertical" }}
                />
                <p style={styles.hint}>
                  Escríbelo con tus palabras. No hace falta nada técnico.
                </p>
              </div>

              <div style={{ marginBottom: 22 }}>
                <label style={styles.lbl}>Presupuesto al día (opcional, en $)</label>
                <input
                  type="number"
                  min={BUDGET.minDailyUsd}
                  step={1}
                  value={budgetHint}
                  onChange={(e) => setBudgetHint(e.target.value)}
                  placeholder="Ej.: 10"
                  style={styles.inp}
                />
                <p style={styles.hint}>
                  Si lo dejas vacío, lo proponemos por ti. Mínimo ${BUDGET.minDailyUsd} al día.
                </p>
              </div>

              {/* MODE TOGGLE — big and visual */}
              <label style={styles.lbl}>¿Cómo quieres hacerlo?</label>
              <div style={{ display: "flex", gap: 12, marginTop: 8, marginBottom: 8 }}>
                <ModeCard
                  active={mode === "auto"}
                  onClick={() => setMode("auto")}
                  emoji="🚀"
                  title="Automático (un clic)"
                  desc="Los 6 ayudantes lo hacen todo y te enseñan el resultado para activar."
                  colors={colors}
                />
                <ModeCard
                  active={mode === "assisted"}
                  onClick={() => setMode("assisted")}
                  emoji="✍️"
                  title="Asistido (paso a paso)"
                  desc="Revisas y ajustas cada paso antes de continuar al siguiente."
                  colors={colors}
                />
              </div>
            </div>

            {error && <ErrorBox>{error}</ErrorBox>}

            <button
              onClick={startRun}
              disabled={starting}
              style={{
                ...styles.primaryBtn,
                marginTop: 20,
                width: "100%",
                opacity: starting ? 0.7 : 1,
                cursor: starting ? "not-allowed" : "pointer",
              }}
            >
              {starting ? "Empezando…" : "Crear mi campaña"}
            </button>
          </div>
        )}

        {/* ---------------- RUN VIEW ---------------- */}
        {!showStart && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-2xl font-bold">{brandName}</h1>
                <p style={{ color: colors.textMuted, fontSize: 13 }}>
                  {state?.run.mode === "auto"
                    ? "Modo automático — preparando tu campaña…"
                    : "Modo asistido — revisa cada paso."}
                </p>
              </div>
              <button onClick={reset} style={styles.ghostBtn}>
                Empezar de nuevo
              </button>
            </div>

            {/* FAILED state */}
            {failed && (
              <div style={{ marginBottom: 24 }}>
                <ErrorBox>
                  {state?.run.error || "La campaña no se pudo completar."}
                </ErrorBox>
                <button
                  onClick={reset}
                  style={{ ...styles.primaryBtn, marginTop: 12 }}
                >
                  Reintentar
                </button>
              </div>
            )}

            {/* TIMELINE */}
            <Timeline
              state={state}
              liveLog={liveLog}
              colors={colors}
              styles={styles}
              onAccept={acceptStep}
              activationGate={activationGate}
            />

            {/* ACTIVATION GATE — final review + one big button */}
            {activationGate && (
              <ActivationReview
                state={state!}
                colors={colors}
                styles={styles}
                activating={activating}
                onActivate={activateCampaign}
              />
            )}

            {/* SUCCESS after activation */}
            {activateResult?.ok && (
              <div style={{ ...styles.card, marginTop: 24, textAlign: "center" }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>
                  {enabledNow ? "🟢" : "⏸️"}
                </div>
                <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
                  {enabledNow
                    ? "¡Tu campaña está en marcha!"
                    : "¡Campaña creada en Google Ads!"}
                </h2>
                {activateResult.googleCampaignId && (
                  <p style={{ fontSize: 12, color: colors.textFaint, marginBottom: 8 }}>
                    ID de Google Ads: {activateResult.googleCampaignId}
                  </p>
                )}
                {pausedDone && (
                  <>
                    <p
                      style={{
                        fontSize: 14,
                        color: "#FBBF24",
                        fontWeight: 600,
                        marginBottom: 16,
                      }}
                    >
                      Está en PAUSA. No se gasta nada hasta que la pongas en marcha.
                    </p>
                    <button
                      onClick={enableCampaign}
                      disabled={enabling}
                      style={{
                        ...styles.secondaryBtn,
                        opacity: enabling ? 0.7 : 1,
                        cursor: enabling ? "not-allowed" : "pointer",
                      }}
                    >
                      {enabling ? "Poniendo en marcha…" : "Ponerla en marcha"}
                    </button>
                  </>
                )}
                {enabledNow && (
                  <p style={{ fontSize: 14, color: colors.accent, fontWeight: 600 }}>
                    Ya está activa y mostrándose en Google.
                  </p>
                )}
              </div>
            )}

            {error && !failed && (
              <div style={{ marginTop: 16 }}>
                <ErrorBox>{error}</ErrorBox>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ===========================================================================
// SUB-COMPONENTS
// ===========================================================================

function ModeCard({
  active,
  onClick,
  emoji,
  title,
  desc,
  colors,
}: {
  active: boolean;
  onClick: () => void;
  emoji: string;
  title: string;
  desc: string;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        textAlign: "left",
        padding: 16,
        borderRadius: 12,
        cursor: "pointer",
        background: active ? "rgba(16,185,129,0.10)" : colors.bg,
        border: `2px solid ${active ? colors.accent : colors.border}`,
        transition: "all 0.15s",
      }}
    >
      <div style={{ fontSize: 24, marginBottom: 6 }}>{emoji}</div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: active ? colors.accent : colors.text,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 12, color: colors.textMuted, lineHeight: 1.4 }}>
        {desc}
      </div>
    </button>
  );
}

function Timeline({
  state,
  liveLog,
  colors,
  styles,
  onAccept,
  activationGate,
}: {
  state: RunStateDTO | null;
  liveLog: Partial<Record<AgentId, string>>;
  colors: ReturnType<typeof useTheme>["colors"];
  styles: Styles;
  onAccept: (stepId: string, userOverride?: unknown) => void;
  activationGate: boolean;
}) {
  // Build a row per pipeline agent, merged with whatever the server reports.
  const stepByAgent = new Map<AgentId, StepDTO>();
  for (const s of state?.steps ?? []) stepByAgent.set(s.agent, s);

  const awaitingStep = state ? currentAwaitingStep(state) : null;

  return (
    <div style={{ position: "relative" }}>
      {PIPELINE.map((agent, i) => {
        const step = stepByAgent.get(agent);
        const dot = dotStateFor(step);
        const isLast = i === PIPELINE.length - 1;
        const live = liveLog[agent];
        // Show the inline approval block only in ASISTIDO and not at the
        // activation gate (that has its own big review card below).
        const isAwaiting =
          !!awaitingStep &&
          awaitingStep.agent === agent &&
          state?.run.mode === "assisted" &&
          !activationGate;

        return (
          <div key={agent} style={{ display: "flex", gap: 14, position: "relative" }}>
            {/* Dot + connecting line */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: 24,
              }}
            >
              <Dot state={dot} colors={colors} />
              {!isLast && (
                <div
                  style={{
                    flex: 1,
                    width: 2,
                    minHeight: 24,
                    background:
                      dot === "done" ? colors.accent : colors.border,
                    marginTop: 2,
                    marginBottom: 2,
                  }}
                />
              )}
            </div>

            {/* Content */}
            <div style={{ flex: 1, paddingBottom: 22 }}>
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 15 }}>{AGENT_EMOJI[agent]}</span>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color:
                      dot === "pending" ? colors.textMuted : colors.text,
                  }}
                >
                  {AGENT_TITLES[agent]}
                </span>
                <StatusPill state={dot} colors={colors} />
              </div>
              <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 2 }}>
                {AGENT_BLURB[agent]}
              </p>

              {/* Live streamed text while working */}
              {dot === "working" && live && (
                <pre style={styles.liveLog}>{live}</pre>
              )}

              {/* Friendly summary once done */}
              {dot === "done" && step && (
                <AgentSummary agent={agent} step={step} colors={colors} styles={styles} />
              )}

              {/* ASISTIDO approval block */}
              {isAwaiting && step && (
                <ApprovalBlock
                  step={step}
                  colors={colors}
                  styles={styles}
                  onAccept={onAccept}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Dot({
  state,
  colors,
}: {
  state: DotState;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  const base = {
    width: 18,
    height: 18,
    borderRadius: 99,
    flexShrink: 0,
    border: `2px solid ${colors.border}`,
  } as const;
  if (state === "done")
    return (
      <div
        style={{
          ...base,
          background: colors.accent,
          borderColor: colors.accent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
    );
  if (state === "working")
    return (
      <div
        className="animate-pulse"
        style={{ ...base, background: "#3B82F6", borderColor: "#3B82F6" }}
      />
    );
  if (state === "failed")
    return <div style={{ ...base, background: "#EF4444", borderColor: "#EF4444" }} />;
  return <div style={{ ...base, background: colors.bg }} />;
}

function StatusPill({
  state,
  colors,
}: {
  state: DotState;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  const map: Record<DotState, { t: string; bg: string; c: string }> = {
    pending: { t: "Pendiente", bg: "rgba(161,161,170,0.12)", c: colors.textMuted },
    working: { t: "Trabajando…", bg: "rgba(59,130,246,0.15)", c: "#60A5FA" },
    done: { t: "Listo", bg: "rgba(16,185,129,0.15)", c: colors.accent },
    failed: { t: "Error", bg: "rgba(239,68,68,0.15)", c: "#F87171" },
  };
  const s = map[state];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 99,
        background: s.bg,
        color: s.c,
      }}
    >
      {s.t}
    </span>
  );
}

// Friendly per-agent summary of its proposal.
function AgentSummary({
  agent,
  step,
  colors,
  styles,
}: {
  agent: AgentId;
  step: StepDTO;
  colors: ReturnType<typeof useTheme>["colors"];
  styles: Styles;
}) {
  const out = (step.userOverride ?? step.output) as unknown;
  const lines = summarizeAgent(agent, out);
  if (lines.length === 0) {
    if (!step.rationale) return null;
    return <p style={styles.summary}>{step.rationale}</p>;
  }
  return (
    <div style={styles.summaryCard}>
      {lines.map((l, i) => (
        <div key={i} style={{ fontSize: 13, color: colors.text, marginBottom: 3 }}>
          {l}
        </div>
      ))}
    </div>
  );
}

// ASISTIDO inline approval: friendly fields for the planner, textarea fallback
// for the rest.
function ApprovalBlock({
  step,
  colors,
  styles,
  onAccept,
}: {
  step: StepDTO;
  colors: ReturnType<typeof useTheme>["colors"];
  styles: Styles;
  onAccept: (stepId: string, userOverride?: unknown) => void;
}) {
  const out = (step.userOverride ?? step.output) as unknown;

  // Planner gets friendly fields (presupuesto + objetivo).
  const isPlanner = step.agent === "planner";
  const planner = isPlanner ? (out as PlannerOutput | null) : null;
  const [budget, setBudget] = useState<string>(
    planner?.budget?.dailyUsd != null ? String(planner.budget.dailyUsd) : "",
  );
  const [objective, setObjective] = useState<string>(
    planner?.objectiveSummary ?? "",
  );

  // Generic "Ajustar" fallback (editable JSON-ish textarea) for other steps.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(() => prettyJson(out));
  const [parseError, setParseError] = useState<string | null>(null);

  function acceptPlanner() {
    if (!planner) {
      onAccept(step.id);
      return;
    }
    const override: PlannerOutput = {
      ...planner,
      objectiveSummary: objective.trim() || planner.objectiveSummary,
      budget: {
        ...planner.budget,
        dailyUsd: parseBudget(budget) ?? planner.budget.dailyUsd,
      },
    };
    onAccept(step.id, override);
  }

  function acceptEdited() {
    try {
      const parsed = JSON.parse(draft);
      setParseError(null);
      onAccept(step.id, parsed);
    } catch {
      setParseError("No pudimos leer los cambios. Revisa el formato.");
    }
  }

  return (
    <div style={styles.approval}>
      <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
        ¿Te parece bien? Puedes aceptarlo o ajustarlo.
      </p>

      {isPlanner && planner && !editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={styles.lbl}>Tu objetivo</label>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={2}
              style={{ ...styles.inp, resize: "vertical" }}
            />
          </div>
          <div>
            <label style={styles.lbl}>Presupuesto al día ($)</label>
            <input
              type="number"
              min={BUDGET.minDailyUsd}
              step={1}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              style={styles.inp}
            />
          </div>
        </div>
      )}

      {editing && (
        <div style={{ marginBottom: 12 }}>
          <label style={styles.lbl}>Ajustes (avanzado)</label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            style={{ ...styles.inp, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
          />
          {parseError && (
            <p style={{ fontSize: 12, color: "#F87171", marginTop: 4 }}>{parseError}</p>
          )}
        </div>
      )}

      <div className="flex gap-3 items-center" style={{ flexWrap: "wrap" }}>
        <button
          onClick={
            editing ? acceptEdited : isPlanner ? acceptPlanner : () => onAccept(step.id)
          }
          style={styles.primaryBtn}
        >
          Aceptar
        </button>
        {!editing ? (
          <button
            onClick={() => {
              setDraft(prettyJson(out));
              setEditing(true);
            }}
            style={styles.linkBtn}
          >
            Ajustar
          </button>
        ) : (
          <button onClick={() => setEditing(false)} style={styles.linkBtn}>
            Cancelar ajustes
          </button>
        )}
        <span style={{ fontSize: 11, color: colors.textFaint }}>
          Nada se publica todavía.
        </span>
      </div>
    </div>
  );
}

// Big final review before the single activation click.
function ActivationReview({
  state,
  colors,
  styles,
  activating,
  onActivate,
}: {
  state: RunStateDTO;
  colors: ReturnType<typeof useTheme>["colors"];
  styles: Styles;
  activating: boolean;
  onActivate: () => void;
}) {
  const structure = readStep<StructureOutput>(state, "structure_architect");
  const rsa = readStep<RSAOutput>(state, "rsa_copywriter");
  const planner = readStep<PlannerOutput>(state, "planner");
  const keywords = readStep<KeywordResearchOutput>(state, "keyword_researcher");

  const adGroupCount = structure?.adGroups?.length ?? 0;
  const keywordCount =
    structure?.adGroups?.reduce((n, g) => n + (g.keywords?.length ?? 0), 0) ??
    keywords?.keywords?.length ??
    0;
  const sampleAd: AdGroupAds | undefined = rsa?.ads?.[0];
  const campaignName = structure?.campaignName ?? `${state.run.id.slice(0, 6)}`;

  return (
    <div style={{ ...styles.card, marginTop: 12, borderColor: colors.accent }}>
      <h2 style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>
        Todo listo para activar 🎉
      </h2>
      <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>
        Este es el resumen de tu campaña. Revísalo y actívala cuando quieras.
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <Stat label="Campaña" value={campaignName} colors={colors} wide />
        <Stat label="Grupos de anuncios" value={String(adGroupCount)} colors={colors} />
        <Stat label="Palabras clave" value={String(keywordCount)} colors={colors} />
        {planner?.budget?.dailyUsd != null && (
          <Stat
            label="Presupuesto"
            value={`$${planner.budget.dailyUsd}/día`}
            colors={colors}
          />
        )}
      </div>

      {sampleAd && (
        <div style={{ marginBottom: 16 }}>
          <p style={styles.lbl}>Ejemplo de anuncio</p>
          <div style={styles.adPreview}>
            <div style={{ fontSize: 14, color: "#60A5FA", fontWeight: 600 }}>
              {sampleAd.headlines
                .slice(0, 3)
                .map((h) => h.text)
                .join(" | ")}
            </div>
            <div style={{ fontSize: 12, color: colors.accent, marginTop: 2 }}>
              {sampleAd.finalUrl}
            </div>
            <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>
              {sampleAd.descriptions
                .slice(0, 2)
                .map((d) => d.text)
                .join(" ")}
            </div>
          </div>
        </div>
      )}

      <button
        onClick={onActivate}
        disabled={activating}
        style={{
          ...styles.primaryBtn,
          width: "100%",
          fontSize: 16,
          padding: "14px 24px",
          opacity: activating ? 0.7 : 1,
          cursor: activating ? "not-allowed" : "pointer",
        }}
      >
        {activating ? "Creando en Google Ads…" : "Activar campaña"}
      </button>
      <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 10, textAlign: "center" }}>
        Se crea en Google Ads en PAUSA; tú decides cuándo ponerla en marcha.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  colors,
  wide,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useTheme>["colors"];
  wide?: boolean;
}) {
  return (
    <div
      style={{
        flex: wide ? "1 1 100%" : "1 1 120px",
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        padding: 12,
      }}
    >
      <p
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          color: colors.textMuted,
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        {label}
      </p>
      <p style={{ fontSize: wide ? 16 : 20, fontWeight: 700 }}>{value}</p>
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 8,
        background: "rgba(248,113,113,0.1)",
        border: "1px solid rgba(248,113,113,0.3)",
        color: "#F87171",
        fontSize: 13,
        whiteSpace: "pre-wrap",
      }}
    >
      {children}
    </div>
  );
}

// ===========================================================================
// HELPERS (pure)
// ===========================================================================

function parseBudget(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(BUDGET.minDailyUsd, Math.round(n));
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

// Parse a single SSE frame ("type: x\ndata: {...}") into an event.
function parseFrame(frame: string): StreamEvent | null {
  let type = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("type:")) type = line.slice(5).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0 && type === "message") return null;
  const raw = dataLines.join("\n");
  let data: unknown = raw;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  // Some servers put the event type inside the data payload.
  if (type === "message" && isRecord(data) && typeof data.type === "string") {
    type = data.type;
  }
  return { type, data };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function pickAgent(data: unknown): AgentId | null {
  if (!isRecord(data)) return null;
  const a = data.agent ?? data.agentId;
  if (typeof a === "string" && (PIPELINE as string[]).includes(a)) return a as AgentId;
  return null;
}

function pickText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (!isRecord(data)) return null;
  const t = data.text ?? data.message ?? data.decision ?? data.detail ?? data.delta;
  return typeof t === "string" ? t : null;
}

function dotStateFor(step: StepDTO | undefined): DotState {
  if (!step) return "pending";
  switch (step.status) {
    case "COMPLETED":
      return "done";
    case "RUNNING":
      return "working";
    case "AWAITING_APPROVAL":
      return "working";
    case "FAILED":
      return "failed";
    default:
      return "pending";
  }
}

function currentAwaitingStep(state: RunStateDTO): StepDTO | null {
  return (
    state.steps.find((s) => s.status === "AWAITING_APPROVAL") ?? null
  );
}

// The activation gate: the run is awaiting approval and the only remaining
// work is the activator (everything before it is done).
function isActivationGate(state: RunStateDTO): boolean {
  if (state.run.status !== "awaiting_approval") return false;
  const awaiting = currentAwaitingStep(state);
  if (awaiting && awaiting.agent === "activator") return true;
  // Or: every non-activator step is completed and the activator hasn't run.
  const nonActivatorDone = state.steps
    .filter((s) => s.agent !== "activator")
    .every((s) => s.status === "COMPLETED");
  const activator = state.steps.find((s) => s.agent === "activator");
  const activatorPending =
    !activator ||
    activator.status === "NOT_STARTED" ||
    activator.status === "AWAITING_APPROVAL";
  return nonActivatorDone && activatorPending && state.steps.length > 0;
}

function readStep<T>(state: RunStateDTO, agent: AgentId): T | null {
  const step = state.steps.find((s) => s.agent === agent);
  if (!step) return null;
  return ((step.userOverride ?? step.output) as T) ?? null;
}

// Plain-Spanish bullet summary per agent.
function summarizeAgent(agent: AgentId, out: unknown): string[] {
  if (!isRecord(out)) return [];
  switch (agent) {
    case "planner": {
      const o = out as Partial<PlannerOutput>;
      const lines: string[] = [];
      if (o.objectiveSummary) lines.push(`🎯 ${o.objectiveSummary}`);
      if (o.geo?.locations?.length)
        lines.push(`📍 Zona: ${o.geo.locations.join(", ")}`);
      if (o.budget?.dailyUsd != null)
        lines.push(`💶 Presupuesto: $${o.budget.dailyUsd} al día`);
      if (o.themes?.length)
        lines.push(`🗂️ Temas: ${o.themes.map((t) => t.name).join(", ")}`);
      return lines;
    }
    case "keyword_researcher": {
      const o = out as Partial<KeywordResearchOutput>;
      const lines: string[] = [];
      if (o.keywords?.length)
        lines.push(`🔑 ${o.keywords.length} palabras clave encontradas`);
      if (o.negatives?.length)
        lines.push(`🚫 ${o.negatives.length} palabras a evitar`);
      const sample = o.keywords?.slice(0, 4).map((k) => k.text);
      if (sample?.length) lines.push(`Ejemplos: ${sample.join(", ")}`);
      return lines;
    }
    case "structure_architect": {
      const o = out as Partial<StructureOutput>;
      const lines: string[] = [];
      if (o.campaignName) lines.push(`📛 Campaña: ${o.campaignName}`);
      if (o.adGroups?.length)
        lines.push(`🧩 ${o.adGroups.length} grupos de anuncios`);
      const names = o.adGroups?.slice(0, 4).map((g) => g.name);
      if (names?.length) lines.push(`Grupos: ${names.join(", ")}`);
      return lines;
    }
    case "rsa_copywriter": {
      const o = out as Partial<RSAOutput>;
      const lines: string[] = [];
      if (o.ads?.length) lines.push(`✍️ Anuncios para ${o.ads.length} grupos`);
      const first = o.ads?.[0]?.headlines?.slice(0, 2).map((h) => h.text);
      if (first?.length) lines.push(`Ejemplo: "${first.join(" · ")}"`);
      return lines;
    }
    case "policy_qa": {
      const o = out as { verdict?: string; issues?: unknown[] };
      const lines: string[] = [];
      const verdictMap: Record<string, string> = {
        pass: "✅ Todo correcto, listo para publicar",
        fix: "⚠️ Pequeños ajustes recomendados",
        block: "⛔ Hay algo que corregir antes de publicar",
      };
      if (o.verdict) lines.push(verdictMap[o.verdict] ?? `Resultado: ${o.verdict}`);
      if (o.issues?.length) lines.push(`${o.issues.length} cosas revisadas`);
      return lines;
    }
    case "activator": {
      const o = out as { status?: string; keywordsAdded?: number; adsCreated?: number };
      const lines: string[] = [];
      if (o.status) lines.push(`Estado en Google Ads: ${o.status}`);
      if (o.adsCreated != null) lines.push(`📢 ${o.adsCreated} anuncios creados`);
      if (o.keywordsAdded != null)
        lines.push(`🔑 ${o.keywordsAdded} palabras clave añadidas`);
      return lines;
    }
    default:
      return [];
  }
}

// ===========================================================================
// STYLES
// ===========================================================================

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  const inp = {
    width: "100%" as const,
    background: colors.bg,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: "10px 14px",
    fontSize: 14,
    color: colors.text,
    outline: "none",
    boxSizing: "border-box" as const,
  };
  const lbl = {
    display: "block" as const,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.08em",
    color: colors.textMuted,
    marginBottom: 7,
    textTransform: "uppercase" as const,
  };
  return {
    inp,
    lbl,
    hint: { fontSize: 11.5, color: colors.textFaint, marginTop: 5 },
    card: {
      background: colors.bgCard,
      border: `1px solid ${colors.border}`,
      borderRadius: 14,
      padding: 22,
    },
    primaryBtn: {
      padding: "11px 22px",
      borderRadius: 10,
      background: colors.accent,
      color: "#000",
      fontWeight: 700,
      fontSize: 14,
      border: "none",
      cursor: "pointer",
    },
    secondaryBtn: {
      padding: "10px 20px",
      borderRadius: 10,
      background: "transparent",
      border: `1px solid ${colors.accent}`,
      color: colors.accent,
      fontWeight: 600,
      fontSize: 14,
      cursor: "pointer",
    },
    ghostBtn: {
      padding: "7px 14px",
      borderRadius: 8,
      background: "transparent",
      border: `1px solid ${colors.border}`,
      color: colors.textMuted,
      fontSize: 12.5,
      cursor: "pointer",
    },
    linkBtn: {
      padding: "8px 14px",
      borderRadius: 8,
      background: "transparent",
      border: `1px solid ${colors.border}`,
      color: colors.text,
      fontSize: 13,
      cursor: "pointer",
    },
    liveLog: {
      marginTop: 8,
      padding: "8px 10px",
      borderRadius: 8,
      background: colors.bg,
      border: `1px solid ${colors.border}`,
      color: colors.textMuted,
      fontSize: 11.5,
      fontFamily: "monospace",
      whiteSpace: "pre-wrap" as const,
      maxHeight: 120,
      overflow: "auto" as const,
    },
    summary: { fontSize: 13, color: colors.textMuted, marginTop: 8 },
    summaryCard: {
      marginTop: 8,
      padding: "10px 12px",
      borderRadius: 8,
      background: colors.bg,
      border: `1px solid ${colors.border}`,
    },
    approval: {
      marginTop: 12,
      padding: 14,
      borderRadius: 10,
      background: "rgba(59,130,246,0.06)",
      border: "1px solid rgba(59,130,246,0.25)",
    },
    adPreview: {
      padding: 12,
      borderRadius: 8,
      background: colors.bg,
      border: `1px solid ${colors.border}`,
    },
  };
}
