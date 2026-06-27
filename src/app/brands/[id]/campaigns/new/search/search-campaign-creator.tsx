"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";
import {
  BUDGET,
  PIPELINE,
  type ActivateResponse,
  type AdGroupAds,
  type AgentId,
  type KeywordResearchOutput,
  type PlannerOutput,
  type QAOutput,
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

// Short, friendly step titles for the timeline — no jargon, no anglicismos.
const STEP_TITLE: Record<AgentId, string> = {
  planner: "Tu plan",
  keyword_researcher: "Lo que busca tu cliente",
  structure_architect: "Organización de los anuncios",
  rsa_copywriter: "Tus anuncios",
  policy_qa: "Revisión final",
  activator: "Crear en Google Ads",
};

// Symbol shown next to budgets. Google Ads charges in the account's own
// currency; this is only what we DISPLAY. One place to switch it.
const CURRENCY = "€";

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
  const [budgetReason, setBudgetReason] = useState("");
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
  const [discarding, setDiscarding] = useState(false);
  const [activateResult, setActivateResult] = useState<ActivateResponse | null>(null);
  // When the user (in Asistido) presses "que la IA termine el resto", we flip
  // this on so the auto-advance effect drives every remaining step to the
  // activation gate — exactly like Automático, but decided mid-run. It never
  // crosses the activation gate (that stays the user's one deliberate click).
  const [autoFinish, setAutoFinish] = useState(false);
  // ---- AI auto-fill (start card) ----------------------------------------
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // The single AbortController guarding the SSE reader. Never leak it.
  const abortRef = useRef<AbortController | null>(null);
  // Track which step we already auto-advanced, so we POST /advance once per step.
  const advancedRef = useRef<Set<string>>(new Set());
  // Timestamp (ms) of the last stream event. Lets a 'running' run that has gone
  // silent (its server process likely died) be detected and nudged to resume.
  const lastProgressRef = useRef<number>(0);
  // Guards the one-shot "rellenar con IA" fetch on the start card.
  const suggestAbortRef = useRef<AbortController | null>(null);
  // Highest event seq seen, so a reconnect resumes with ?after=<seq> instead of
  // replaying the whole log from 0 (which flickered the live timeline). Reset to
  // 0 on a brand-new run so its first open streams the full history.
  const lastSeqRef = useRef<number>(0);

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
      opts?: { silent?: boolean },
    ) => {
      // `silent` is for the background resilience refire (a best-effort no-op
      // resend) — it must never flash an error. User-initiated calls (gate
      // accept, auto-advance) DO surface failures so the flow can't freeze in
      // silence with the user unsure whether anything is happening.
      if (!opts?.silent) setError(null);
      try {
        const r = await fetch(`/api/search/runs/${id}/advance`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
        if (!r.ok && !opts?.silent) {
          let msg = "No pudimos continuar. Inténtalo de nuevo en un momento.";
          try {
            const data = (await r.json()) as { error?: string };
            if (data?.error) msg = data.error;
          } catch {
            /* no JSON body — keep the friendly default */
          }
          setError(msg);
        }
      } catch {
        if (!opts?.silent) {
          setError(
            "No pudimos continuar. Revisa tu conexión e inténtalo de nuevo.",
          );
        }
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
          const res = await fetch(
            `/api/search/runs/${id}/stream?after=${lastSeqRef.current}`,
            {
              credentials: "include",
              headers: { Accept: "text/event-stream" },
              signal: controller.signal,
            },
          );
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
      // Any event = the server is alive and making progress; reset the silence
      // clock the resilience watcher below uses to detect a dead process.
      lastProgressRef.current = Date.now();
      // The stream serializes the whole EngineEvent ({ seq, type, stepId, data,
      // createdAt }), so the agent/text payload the agents emit lives one level
      // deeper, inside evt.data.data. Unwrap it — without this the live log was
      // permanently blank because pickAgent/pickText read the envelope instead.
      const payload =
        isRecord(evt.data) && "data" in (evt.data as Record<string, unknown>)
          ? (evt.data as { data: unknown }).data
          : evt.data;
      // Remember the high-water seq so a reconnect resumes after it.
      if (isRecord(evt.data) && typeof evt.data.seq === "number") {
        lastSeqRef.current = Math.max(lastSeqRef.current, evt.data.seq);
      }
      const agent = pickAgent(payload);
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
          const text = pickText(payload);
          if (text && agent) {
            setLiveLog((prev) => ({
              ...prev,
              [agent]: ((prev[agent] ?? "") + text).slice(-1200),
            }));
          }
          break;
        }
        case "error": {
          const text = pickText(payload);
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
    return () => {
      abortStream();
      suggestAbortRef.current?.abort();
    };
  }, [abortStream]);

  // ---- Resume a run after a reload -------------------------------------
  // The run id lives in the URL (?run=…), so a refresh, an accidental
  // back/forward, or sharing the link picks the campaign back up instead of
  // dropping the user on a blank start card while the server keeps working.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const existing = new URLSearchParams(window.location.search).get("run");
    if (!existing) return;
    setRunId(existing);
    openStream(existing);
    void refreshState(existing);
    // Run once on mount; openStream/refreshState are stable useCallbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- AUTO mode: auto-advance any step left awaiting approval -----------
  useEffect(() => {
    if (!runId || !state) return;
    if (state.run.status !== "awaiting_approval") return;
    // Drive the pipeline automatically when the run was created in Automático,
    // OR when the user pressed "que la IA termine el resto" mid-run (autoFinish).
    if (state.run.mode !== "auto" && !autoFinish) return;
    // Don't auto-advance the activation gate — that's the user's one click.
    if (isActivationGate(state)) return;

    const step = currentAwaitingStep(state);
    if (!step) return;
    if (advancedRef.current.has(step.id)) return;
    advancedRef.current.add(step.id);
    void advance(runId, { stepId: step.id, action: "accept" });
  }, [runId, state, advance, autoFinish]);

  // ---- Resilience: revive a 'running' run whose server process died ----------
  // In Automático the whole pipeline runs inside ONE /advance request. If that
  // process is killed (timeout, redeploy, crash), the run is stuck 'running' and
  // the SSE stream falls silent forever — an endless spinner. We watch for that
  // silence: every 30s we re-read state, and if no stream event has arrived for
  // SILENCE_MS we re-open the stream and re-POST /advance. The server treats the
  // refire as a safe no-op while a loop is still alive (it only takes over once
  // the run is truly stale), so this never double-drives a healthy run — it only
  // rescues a dead one. Keyed on the run STATUS (not the whole state object) so
  // the interval survives routine state refreshes instead of resetting on each.
  useEffect(() => {
    if (!runId) return;
    if (state?.run.status !== "running") return;
    lastProgressRef.current = Date.now();
    const SILENCE_MS = 90_000;
    const timer = setInterval(() => {
      void refreshState(runId);
      if (Date.now() - lastProgressRef.current < SILENCE_MS) return;
      lastProgressRef.current = Date.now();
      openStream(runId);
      void advance(runId, undefined, { silent: true });
    }, 30_000);
    return () => clearInterval(timer);
  }, [runId, state?.run.status, refreshState, openStream, advance]);

  // ---- AI auto-fill: draft objective + budget from the business context --
  async function requestSuggestion() {
    setSuggestError(null);
    setBudgetReason("");
    setSuggesting(true);
    suggestAbortRef.current?.abort();
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    try {
      const r = await fetch("/api/search/suggest", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId }),
        signal: controller.signal,
      });
      const data = (await r.json()) as {
        objective?: string;
        budgetDailyUsd?: number;
        reason?: string;
        error?: string;
      };
      if (!r.ok || data.error) {
        throw new Error(
          data.error || "No pudimos rellenarlo con IA. Inténtalo de nuevo.",
        );
      }
      if (data.objective) setObjectiveHint(data.objective);
      if (data.budgetDailyUsd != null) setBudgetHint(String(data.budgetDailyUsd));
      if (data.reason) setBudgetReason(data.reason);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setSuggestError(
        e instanceof Error ? e.message : "No pudimos rellenarlo con IA.",
      );
    } finally {
      setSuggesting(false);
    }
  }

  // ---- Start a run -------------------------------------------------------
  async function startRun() {
    setError(null);
    setSuggestError(null);
    setStarting(true);
    advancedRef.current = new Set();
    setAutoFinish(false);
    suggestAbortRef.current?.abort();
    setLiveLog({});
    lastSeqRef.current = 0;
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
      // Keep the run id in the URL so a reload resumes instead of losing it.
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", `?run=${data.runId}`);
      }
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

  // ---- Accept this step AND let the AI finish the rest (Asistido) ---------
  // Flip autoFinish on so the auto-advance effect carries the remaining steps
  // up to (but not through) the activation gate, then accept the current step.
  async function acceptAndFinishStep(stepId: string, userOverride?: unknown) {
    setAutoFinish(true);
    await acceptStep(stepId, userOverride);
  }

  // ---- Activation chokepoint (the ONE place a run gets activated) --------
  // `campaignNameOverride` is the (optional) friendlier name the user typed in
  // the review screen; blank/unchanged means keep the AI's chosen name.
  async function activateCampaign(campaignNameOverride?: string) {
    if (!runId) return;
    // Safety barrier before the first real write to Google Ads. It stays in
    // PAUSE (no spend yet), but we still confirm so a click is never an
    // accident — especially for someone doing this for the first time.
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "Vamos a crear tu campaña en tu cuenta de Google Ads.\n\nQuedará EN PAUSA, así que todavía NO se gasta nada: tú decides cuándo ponerla en marcha.\n\n¿Continuamos?",
      );
      if (!ok) return;
    }
    setActivating(true);
    setError(null);
    try {
      const r = await fetch(`/api/search/runs/${runId}/activate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          campaignNameOverride ? { campaignNameOverride } : {},
        ),
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
    // The real money barrier: enabling starts showing ads and spending budget.
    // Always confirm before crossing it.
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "Tu campaña pasará a estar ACTIVA: empezará a mostrarse en Google y a gastar como mucho tu presupuesto del día.\n\n¿Seguro que quieres ponerla en marcha ahora?",
      );
      if (!ok) return;
    }
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

  // ---- Discard / undo (remove a just-created campaign from Google) -------
  // Safe at any time: the campaign is PAUSED, so it has never spent. After
  // removing it from Google we wipe the local run and let the user start fresh.
  async function discardCampaign() {
    if (!runId) return;
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "Vamos a eliminar esta campaña de tu cuenta de Google Ads.\n\nNo se ha gastado nada (estaba en pausa) y podrás crear otra cuando quieras.\n\n¿Seguro que quieres descartarla?",
      );
      if (!ok) return;
    }
    setDiscarding(true);
    setError(null);
    try {
      const r = await fetch(`/api/search/runs/${runId}/discard`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !data.ok) {
        throw new Error(data.error || "No se pudo descartar la campaña.");
      }
      // Clean slate — the discarded run is gone; let them start over.
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo descartar.");
    } finally {
      setDiscarding(false);
    }
  }

  // ---- Full reset / retry ------------------------------------------------
  function reset() {
    abortStream();
    advancedRef.current = new Set();
    lastSeqRef.current = 0;
    setRunId(null);
    setState(null);
    setLiveLog({});
    setError(null);
    setActivateResult(null);
    setActivating(false);
    setEnabling(false);
    setDiscarding(false);
    setAutoFinish(false);
    // Drop the ?run= id so a later reload doesn't resurrect the old run.
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  // "Empezar de nuevo" throws away a campaign the AI already prepared, so make
  // an accidental click (easy on mobile) ask first. Retrying a FAILED run has
  // nothing to lose, so that path stays immediate.
  function confirmReset() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "¿Seguro que quieres empezar de cero? Se perderá la campaña que la IA ha preparado.",
      )
    ) {
      return;
    }
    reset();
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
          { label: "Marcas", href: "/brands" },
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
              No necesitas rellenar nada: la IA usa la información de tu negocio
              para preparar la campaña. Si quieres, ajusta algo antes de empezar.
            </p>

            <div style={styles.card}>
              <div style={{ marginBottom: 18 }}>
                <label htmlFor="campaign-brand-name" style={styles.lbl}>
                  Nombre de tu marca
                </label>
                <input
                  id="campaign-brand-name"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="Mi negocio"
                  style={styles.inp}
                />
              </div>

              <div style={{ marginBottom: 18 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    marginBottom: 7,
                  }}
                >
                  <label htmlFor="campaign-objective" style={{ ...styles.lbl, marginBottom: 0 }}>
                    ¿Qué quieres conseguir? (opcional)
                  </label>
                  <button
                    type="button"
                    onClick={requestSuggestion}
                    disabled={suggesting}
                    style={{
                      ...styles.secondaryBtn,
                      padding: "6px 12px",
                      fontSize: 13,
                      whiteSpace: "nowrap",
                      opacity: suggesting ? 0.7 : 1,
                      cursor: suggesting ? "not-allowed" : "pointer",
                    }}
                  >
                    {suggesting ? "Pensando…" : "✨ Rellenar con IA"}
                  </button>
                </div>
                <textarea
                  id="campaign-objective"
                  value={objectiveHint}
                  onChange={(e) => setObjectiveHint(e.target.value)}
                  rows={3}
                  placeholder="Ej.: Quiero más reservas para mi restaurante en Madrid"
                  style={{ ...styles.inp, resize: "vertical" }}
                />
                <p style={styles.hint}>
                  No hace falta que rellenes nada: si lo dejas vacío, la IA decide
                  el objetivo, la zona y el presupuesto, y te enseña su propuesta
                  antes de activar. O pulsa “✨ Rellenar con IA”.
                </p>
                {suggestError && (
                  <p role="alert" style={{ ...styles.hint, color: "#ef4444" }}>
                    {suggestError}
                  </p>
                )}
              </div>

              <div style={{ marginBottom: 22 }}>
                <label htmlFor="campaign-budget" style={styles.lbl}>
                  Presupuesto al día (opcional)
                </label>
                <input
                  id="campaign-budget"
                  type="number"
                  min={BUDGET.minDailyUsd}
                  step={1}
                  value={budgetHint}
                  onChange={(e) => setBudgetHint(e.target.value)}
                  placeholder="Ej.: 10"
                  style={styles.inp}
                />
                <p style={styles.hint}>
                  Si lo dejas vacío, lo proponemos por ti. Mínimo {BUDGET.minDailyUsd} {CURRENCY} al día.
                </p>
                {budgetReason && (
                  <p style={{ ...styles.hint, marginTop: 6, color: "#0f766e" }}>
                    ✨ {budgetReason}
                  </p>
                )}
              </div>

              {/* MODE TOGGLE — big and visual */}
              <div style={styles.lbl} id="campaign-mode-label">
                ¿Cómo quieres hacerlo?
              </div>
              <div
                role="group"
                aria-labelledby="campaign-mode-label"
                style={{ display: "flex", gap: 12, marginTop: 8, marginBottom: 8 }}
              >
                <ModeCard
                  active={mode === "auto"}
                  onClick={() => setMode("auto")}
                  emoji="🚀"
                  title="Automático (un clic)"
                  desc="Los 6 ayudantes lo hacen todo y te enseñan el resultado para activar."
                  recommended
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
            <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: "wrap" }}>
              <div>
                <h1 className="text-2xl font-bold">{brandName}</h1>
                <p style={{ color: colors.textMuted, fontSize: 13 }}>
                  {state?.run.mode === "auto"
                    ? "Modo automático — preparando tu campaña…"
                    : "Modo asistido — revisa cada paso."}
                </p>
              </div>
              <div className="flex items-center" style={{ gap: 8 }}>
                <Link
                  href={`/brands/${brandId}/citations`}
                  style={{ ...styles.ghostBtn, textDecoration: "none" }}
                >
                  ← Volver a la marca
                </Link>
                <button onClick={confirmReset} style={styles.ghostBtn}>
                  Empezar de nuevo
                </button>
              </div>
            </div>

            {/* First moments after starting: state is still null. Show a clear
                "we're on it" banner so it never looks frozen. */}
            {!state && !failed && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  ...styles.card,
                  marginBottom: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span
                  className="animate-pulse"
                  aria-hidden="true"
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 99,
                    background: "#3B82F6",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 13.5, color: colors.textMuted }}>
                  Preparando tu campaña… esto tarda solo unos segundos.
                </span>
              </div>
            )}

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
              onAcceptAndFinish={acceptAndFinishStep}
              autoFinish={autoFinish}
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
                onReset={reset}
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
                {activateResult.summary && (
                  <div
                    style={{
                      textAlign: "left",
                      margin: "8px auto 16px",
                      maxWidth: 360,
                      padding: 14,
                      borderRadius: 10,
                      background: "rgba(255,255,255,0.03)",
                      border: `1px solid ${colors.border}`,
                    }}
                  >
                    <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                      Esto es lo que creamos en tu campaña:
                    </p>
                    <ul
                      style={{
                        fontSize: 13,
                        color: colors.textMuted,
                        lineHeight: 1.7,
                        paddingLeft: 18,
                        margin: 0,
                      }}
                    >
                      <li>{activateResult.summary.adGroupsCount} grupos de anuncios</li>
                      <li>{activateResult.summary.keywordsCount} palabras clave</li>
                      <li>
                        {activateResult.summary.negativesCount} palabras clave
                        negativas (para no gastar de más)
                      </li>
                      <li>{activateResult.summary.adsCount} anuncios</li>
                      {activateResult.summary.assetsCount > 0 && (
                        <li>
                          {activateResult.summary.assetsCount} extensiones
                          {activateResult.summary.assetKinds.length > 0
                            ? ` (${activateResult.summary.assetKinds.join(", ")})`
                            : ""}
                        </li>
                      )}
                    </ul>
                  </div>
                )}
                {activateResult.googleAdsDeepLink && (
                  <p style={{ marginBottom: 16 }}>
                    <a
                      href={activateResult.googleAdsDeepLink}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        fontSize: 13,
                        color: colors.accent,
                        fontWeight: 600,
                        textDecoration: "underline",
                      }}
                    >
                      Ver en Google Ads ↗
                    </a>
                  </p>
                )}
                {(() => {
                  // Honest, plain-Spanish status per the rung the account landed
                  // on (decided automatically — the user never picked anything).
                  const boxBase = {
                    textAlign: "left" as const,
                    margin: "0 auto 16px",
                    maxWidth: 360,
                    padding: 14,
                    borderRadius: 10,
                  };
                  const greenBox = {
                    ...boxBase,
                    background: "rgba(16,185,129,0.08)",
                    border: "1px solid rgba(16,185,129,0.3)",
                  };
                  const amberBox = {
                    ...boxBase,
                    background: "rgba(251,191,36,0.08)",
                    border: "1px solid rgba(251,191,36,0.3)",
                  };
                  const textStyle = {
                    fontSize: 13,
                    color: colors.textMuted,
                    lineHeight: 1.5,
                  };
                  const rung = activateResult.biddingRung;
                  const labels = activateResult.optimizedObjectiveLabels ?? [];
                  const what = labels.length > 0 ? labels.join(" y ") : "tus resultados";

                  if (rung === "R3") {
                    return (
                      <div style={greenBox}>
                        <p style={textStyle}>
                          ✓ Tu campaña ya busca clientes, no solo visitas. Tu
                          cuenta mide bien {what} —cosas que de verdad ocurren— y
                          le hemos dicho a Google que dé prioridad a conseguir
                          más. Lo que mides pero aún no ha pasado nunca lo
                          añadiremos solos en cuanto empiece a ocurrir. No tienes
                          que tocar nada.
                        </p>
                      </div>
                    );
                  }
                  if (rung === "R2") {
                    return (
                      <div style={amberBox}>
                        <p style={textStyle}>
                          Tu cuenta ya está preparada para medir resultados, pero
                          todavía no hay datos suficientes para optimizar con
                          seguridad. Mientras tanto, tu campaña consigue el máximo
                          de visitas de calidad con tu presupuesto y seguimos
                          contando cada resultado. En cuanto haya datos,
                          cambiaremos solos a buscar clientes. No tienes que hacer
                          nada.
                        </p>
                      </div>
                    );
                  }
                  if (rung === "R1") {
                    return (
                      <div style={amberBox}>
                        <p style={textStyle}>
                          Tu cuenta todavía no mide ningún resultado (registros,
                          ventas, contactos...), así que aún no podemos optimizar
                          para conseguir clientes. Por ahora tu campaña consigue
                          el máximo de visitas de calidad con tu presupuesto.
                          Cuando empieces a medir, pasará sola a buscar clientes.
                          No tienes que decidir nada.
                        </p>
                      </div>
                    );
                  }
                  // Fallback for runs created before the rung existed: original
                  // binary copy, so already-activated campaigns never break.
                  return activateResult.conversionTrackingEnabled ? (
                    <div style={greenBox}>
                      <p style={textStyle}>
                        ✓ Tu campaña ya mide resultados de verdad (ventas o
                        contactos), no solo visitas. La optimizaremos hacia lo que
                        de verdad te importa.
                      </p>
                    </div>
                  ) : (
                    <div style={amberBox}>
                      <p style={textStyle}>
                        Por ahora tu web todavía no mide resultados (ventas o
                        contactos), así que pujamos por clics para que tu anuncio
                        se vea desde el primer día. Más adelante podremos medir
                        esos resultados y optimizar hacia ellos: lo dejaremos
                        listo por ti, sin que tengas que tocar nada.
                      </p>
                    </div>
                  );
                })()}
                {pausedDone && (
                  <>
                    <p
                      style={{
                        fontSize: 14,
                        color: "#FBBF24",
                        fontWeight: 600,
                        marginBottom: 8,
                      }}
                    >
                      Está en pausa. No se gasta nada hasta que la pongas en marcha.
                    </p>
                    <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>
                      Cuando la pongas en marcha, empezará a mostrarse en Google y
                      a gastar como mucho tu presupuesto del día. Puedes volver a
                      pausarla cuando quieras, sin coste.
                    </p>
                    <button
                      onClick={enableCampaign}
                      disabled={enabling || discarding}
                      style={{
                        ...styles.secondaryBtn,
                        opacity: enabling || discarding ? 0.7 : 1,
                        cursor: enabling || discarding ? "not-allowed" : "pointer",
                      }}
                    >
                      {enabling ? "Poniendo en marcha…" : "Ponerla en marcha"}
                    </button>
                    <div style={{ marginTop: 14 }}>
                      <button
                        onClick={discardCampaign}
                        disabled={discarding || enabling}
                        style={{
                          background: "none",
                          border: "none",
                          color: colors.textFaint,
                          fontSize: 12.5,
                          textDecoration: "underline",
                          cursor: discarding || enabling ? "not-allowed" : "pointer",
                          padding: 0,
                        }}
                      >
                        {discarding
                          ? "Descartando…"
                          : "Descartar esta campaña (la elimina de Google Ads)"}
                      </button>
                    </div>
                  </>
                )}
                {enabledNow && (
                  <>
                    <p style={{ fontSize: 14, color: colors.accent, fontWeight: 600 }}>
                      Ya está activa y mostrándose en Google.
                    </p>
                    <p style={{ fontSize: 13, color: colors.textMuted, marginTop: 8 }}>
                      A partir de ahora puede gastar como mucho tu presupuesto del
                      día. Si quieres pararla, entra en tu cuenta de Google Ads y
                      ponla en pausa cuando quieras.
                    </p>
                  </>
                )}
                <div
                  style={{
                    textAlign: "left",
                    margin: "20px auto 0",
                    maxWidth: 360,
                    paddingTop: 16,
                    borderTop: `1px solid ${colors.border}`,
                  }}
                >
                  <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                    Próximos pasos:
                  </p>
                  <ul
                    style={{
                      fontSize: 13,
                      color: colors.textMuted,
                      lineHeight: 1.7,
                      paddingLeft: 18,
                      margin: 0,
                    }}
                  >
                    {enabledNow ? (
                      <>
                        <li>⏱️ Revisa tus primeros clics en 24-48 horas.</li>
                        <li>📊 Fíjate en si te llegan clientes de calidad.</li>
                        <li>
                          🔧 Si hace falta, ajusta tus palabras clave o el
                          presupuesto.
                        </li>
                      </>
                    ) : (
                      <>
                        <li>
                          👀 Revisa la propuesta con calma: el nombre, las
                          palabras clave y los anuncios.
                        </li>
                        <li>
                          ▶️ Cuando estés listo, pulsa «Ponerla en marcha» para
                          empezar a mostrarla en Google.
                        </li>
                        <li>
                          📊 En cuanto reciba sus primeros clics, te ayudo a
                          mejorarla.
                        </li>
                      </>
                    )}
                  </ul>
                </div>
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
  recommended,
}: {
  active: boolean;
  onClick: () => void;
  emoji: string;
  title: string;
  desc: string;
  colors: ReturnType<typeof useTheme>["colors"];
  recommended?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        flex: 1,
        position: "relative",
        textAlign: "left",
        padding: 16,
        borderRadius: 12,
        cursor: "pointer",
        background: active ? "rgba(16,185,129,0.10)" : colors.bg,
        border: `2px solid ${active ? colors.accent : colors.border}`,
        transition: "all 0.15s",
      }}
    >
      {recommended && (
        <span
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            padding: "2px 7px",
            borderRadius: 99,
            background: "rgba(16,185,129,0.15)",
            color: colors.accent,
            border: "1px solid rgba(16,185,129,0.3)",
          }}
        >
          Recomendado
        </span>
      )}
      <div style={{ fontSize: 24, marginBottom: 6 }} aria-hidden="true">
        {emoji}
      </div>
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

// ── País / idioma: nombres amables en español ───────────────────────────────
// Alineado con GEO_TARGET_CONSTANTS / LANGUAGE_CONSTANTS de src/lib/google-ads.ts:
// solo mostramos (y dejamos elegir) países e idiomas que Google Ads sabe
// segmentar. La IA decide el valor por defecto; esto es solo para enseñarlo
// claro y dejar que el usuario lo corrija si hace falta.
const COUNTRY_LABELS: Record<string, { name: string; flag: string }> = {
  ES: { name: "España", flag: "🇪🇸" },
  MX: { name: "México", flag: "🇲🇽" },
  AR: { name: "Argentina", flag: "🇦🇷" },
  CO: { name: "Colombia", flag: "🇨🇴" },
  CL: { name: "Chile", flag: "🇨🇱" },
  PE: { name: "Perú", flag: "🇵🇪" },
  US: { name: "Estados Unidos", flag: "🇺🇸" },
  GB: { name: "Reino Unido", flag: "🇬🇧" },
  FR: { name: "Francia", flag: "🇫🇷" },
  DE: { name: "Alemania", flag: "🇩🇪" },
  IT: { name: "Italia", flag: "🇮🇹" },
  PT: { name: "Portugal", flag: "🇵🇹" },
};

const LANGUAGE_LABELS: Record<string, string> = {
  es: "Español",
  en: "Inglés",
  fr: "Francés",
  de: "Alemán",
  it: "Italiano",
  pt: "Portugués",
};

function countryLabel(code?: string): { name: string; flag: string } {
  const c = (code ?? "").toUpperCase();
  return COUNTRY_LABELS[c] ?? { name: code || "—", flag: "🌍" };
}

function languageLabel(code?: string): string {
  const l = (code ?? "").toLowerCase();
  return LANGUAGE_LABELS[l] ?? (code || "—");
}

const COUNTRY_OPTIONS = Object.entries(COUNTRY_LABELS).map(([code, v]) => ({
  code,
  ...v,
}));
const LANGUAGE_OPTIONS = Object.entries(LANGUAGE_LABELS).map(([code, name]) => ({
  code,
  name,
}));

// Prominent "this is the country/language we'll target" banner, shown at the
// very top of the run so the user SEES it before the heavy steps run (Pedro
// asked to show the country up front, per brand). It reads the planner's geo,
// which the AI decides automatically; the user can change it below in "Tu plan".
function GeoBanner({
  state,
  colors,
}: {
  state: RunStateDTO | null;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  const planner = state ? readStep<PlannerOutput>(state, "planner") : null;
  const geo = planner?.geo;

  // Until the planner has decided, reassure that we're working it out.
  if (!geo || !geo.countryCodes?.length) {
    return (
      <div
        style={{
          marginBottom: 18,
          padding: "10px 14px",
          borderRadius: 10,
          border: `1px solid ${colors.border}`,
        }}
      >
        <span style={{ fontSize: 13, color: colors.textMuted }}>
          🌍 Estamos detectando el país de tu marca…
        </span>
      </div>
    );
  }

  const primary = countryLabel(geo.countryCodes[0]);
  const extra = geo.countryCodes.length - 1;
  const lang = languageLabel(geo.languageCode);

  return (
    <div
      style={{
        marginBottom: 18,
        padding: "12px 14px",
        borderRadius: 10,
        border: `1px solid ${colors.accent}`,
        background: "rgba(16,185,129,0.06)",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontSize: 12.5, color: colors.textMuted }}>Tu campaña apunta a</span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          {primary.flag} {primary.name}
          {extra > 0 ? ` +${extra}` : ""}
        </span>
        <span style={{ fontSize: 12.5, color: colors.textMuted }}>
          · anuncios en {lang}
        </span>
      </div>
      <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 5 }}>
        Lo eligió la IA por la web de tu marca, y por eso las palabras clave salen
        en {lang.toLowerCase()}. Si no es correcto, puedes cambiarlo en «
        {STEP_TITLE.planner}».
      </p>
    </div>
  );
}

function Timeline({
  state,
  liveLog,
  colors,
  styles,
  onAccept,
  onAcceptAndFinish,
  autoFinish,
  activationGate,
}: {
  state: RunStateDTO | null;
  liveLog: Partial<Record<AgentId, string>>;
  colors: ReturnType<typeof useTheme>["colors"];
  styles: Styles;
  onAccept: (stepId: string, userOverride?: unknown) => void;
  onAcceptAndFinish: (stepId: string, userOverride?: unknown) => void;
  autoFinish: boolean;
  activationGate: boolean;
}) {
  // Build a row per pipeline agent, merged with whatever the server reports.
  const stepByAgent = new Map<AgentId, StepDTO>();
  for (const s of state?.steps ?? []) stepByAgent.set(s.agent, s);

  const awaitingStep = state ? currentAwaitingStep(state) : null;

  // A concise, screen-reader-only running commentary. We deliberately do NOT
  // wrap the whole timeline in aria-live (the streamed token text would spam
  // the reader); instead we announce just the current step and its state, so a
  // blind user knows the campaign is advancing and never feels stuck.
  const workingAgent = PIPELINE.find(
    (a) => dotStateFor(stepByAgent.get(a)) === "working",
  );
  const liveStatusText = activationGate
    ? "Tu campaña está lista. Revisa el resumen y actívala cuando quieras."
    : state?.run.status === "failed"
      ? "Hubo un problema al preparar la campaña."
      : workingAgent
        ? `Preparando: ${STEP_TITLE[workingAgent]}.`
        : "Preparando tu campaña…";

  return (
    <div style={{ position: "relative" }}>
      <span className="sr-only" role="status" aria-live="polite">
        {liveStatusText}
      </span>
      <GeoBanner state={state} colors={colors} />
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
          !autoFinish &&
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
                <span style={{ fontSize: 15 }} aria-hidden="true">
                  {AGENT_EMOJI[agent]}
                </span>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color:
                      dot === "pending" ? colors.textMuted : colors.text,
                  }}
                >
                  {STEP_TITLE[agent]}
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
                  onAcceptAndFinish={onAcceptAndFinish}
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
  // For the keyword step, show the full expandable list under the summary.
  const keywordDetail =
    agent === "keyword_researcher" && isRecord(out)
      ? (out as unknown as KeywordResearchOutput)
      : null;
  if (lines.length === 0 && !keywordDetail) {
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
      {keywordDetail && <KeywordDetails data={keywordDetail} colors={colors} />}
    </div>
  );
}

// Full, expandable keyword + negative list for the keyword step. Pedro asked to
// see EVERY keyword (not just a handful of examples), so the whole list is here
// behind one click — the timeline stays compact until you want the detail.
function KeywordDetails({
  data,
  colors,
}: {
  data: KeywordResearchOutput;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  const [open, setOpen] = useState(false);
  const keywords = data.keywords ?? [];
  const negatives = data.negatives ?? [];
  if (keywords.length === 0 && negatives.length === 0) return null;

  const chip = (text: string, kind: "kw" | "neg") => (
    <span
      key={kind + text}
      style={{
        display: "inline-block",
        fontSize: 12,
        padding: "3px 9px",
        borderRadius: 99,
        margin: "0 6px 6px 0",
        background:
          kind === "kw" ? "rgba(16,185,129,0.10)" : "rgba(248,113,113,0.10)",
        border: `1px solid ${
          kind === "kw" ? "rgba(16,185,129,0.3)" : "rgba(248,113,113,0.3)"
        }`,
        color: colors.text,
        wordBreak: "break-word",
      }}
    >
      {text}
    </span>
  );

  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: colors.accent,
          fontSize: 12.5,
          fontWeight: 600,
          textDecoration: "underline",
        }}
      >
        {open
          ? "Ocultar la lista completa"
          : `Ver la lista completa (${keywords.length + negatives.length})`}
      </button>
      {open && (
        <div style={{ marginTop: 10, maxHeight: 320, overflow: "auto" }}>
          {keywords.length > 0 && (
            <div style={{ marginBottom: negatives.length ? 14 : 0 }}>
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: colors.textMuted,
                  marginBottom: 6,
                }}
              >
                🔑 Palabras por las que aparecerás ({keywords.length})
              </p>
              <div>{keywords.map((k) => chip(k.text, "kw"))}</div>
            </div>
          )}
          {negatives.length > 0 && (
            <div>
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: colors.textMuted,
                  marginBottom: 6,
                }}
              >
                🚫 Palabras que evitaremos ({negatives.length})
              </p>
              <div>{negatives.map((n) => chip(n.text, "neg"))}</div>
            </div>
          )}
        </div>
      )}
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
  onAcceptAndFinish,
}: {
  step: StepDTO;
  colors: ReturnType<typeof useTheme>["colors"];
  styles: Styles;
  onAccept: (stepId: string, userOverride?: unknown) => void;
  onAcceptAndFinish: (stepId: string, userOverride?: unknown) => void;
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
  // País + idioma: la IA ya los eligió; aquí solo dejamos cambiarlos con un clic.
  const [country, setCountry] = useState<string>(
    planner?.geo?.countryCodes?.[0]?.toUpperCase() ?? "",
  );
  const [language, setLanguage] = useState<string>(
    planner?.geo?.languageCode?.toLowerCase() ?? "",
  );

  // Generic "Ajustar" fallback (editable JSON-ish textarea) for other steps.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(() => prettyJson(out));
  const [parseError, setParseError] = useState<string | null>(null);
  // Immediate feedback so a click on "Aceptar" never feels ignored.
  const [accepting, setAccepting] = useState(false);

  // Safety net: normally the block unmounts when the run advances, but if an
  // accept ever fails silently we must not leave the button disabled forever.
  useEffect(() => {
    if (!accepting) return;
    const t = setTimeout(() => setAccepting(false), 10000);
    return () => clearTimeout(t);
  }, [accepting]);

  // Resolve whatever the user accepts (plain output, planner override, or an
  // edited draft) and hand it to `cb` — which is either onAccept (advance one
  // step) or onAcceptAndFinish (let the AI carry the rest). Same logic, two
  // destinations, so the buttons can never drift apart.
  function runAccept(cb: (stepId: string, userOverride?: unknown) => void) {
    setAccepting(true);
    if (editing) {
      try {
        const parsed = JSON.parse(draft);
        setParseError(null);
        cb(step.id, parsed);
      } catch {
        setParseError("No pudimos leer los cambios. Revisa el formato.");
        setAccepting(false);
      }
      return;
    }
    if (isPlanner) {
      if (!planner) {
        cb(step.id);
        return;
      }
      const override: PlannerOutput = {
        ...planner,
        objectiveSummary: objective.trim() || planner.objectiveSummary,
        geo: {
          ...planner.geo,
          countryCodes: country ? [country] : planner.geo.countryCodes,
          // Keep the human-readable location label in step with the chosen
          // country so downstream agents and summaries read consistently.
          locations: country
            ? [countryLabel(country).name]
            : planner.geo.locations,
          languageCode: language || planner.geo.languageCode,
        },
        budget: {
          ...planner.budget,
          dailyUsd: parseBudget(budget) ?? planner.budget.dailyUsd,
        },
      };
      cb(step.id, override);
      return;
    }
    cb(step.id);
  }

  // The "Aceptar" button: advance just this one step. The block unmounts once
  // the server moves the run forward, so we never need to clear `accepting`.
  function handleAccept() {
    runAccept(onAccept);
  }

  // The "…y que la IA termine el resto" button: accept this step and let the
  // AI drive every remaining step up to the final activation review.
  function handleAcceptAndFinish() {
    runAccept(onAcceptAndFinish);
  }

  return (
    <div style={styles.approval}>
      <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
        ¿Te parece bien? Puedes aceptarlo o ajustarlo.
      </p>

      {isPlanner && planner && !editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
          <div>
            <label htmlFor="planner-objective" style={styles.lbl}>
              Tu objetivo
            </label>
            <textarea
              id="planner-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={2}
              style={{ ...styles.inp, resize: "vertical" }}
            />
          </div>
          <div>
            <label htmlFor="planner-budget" style={styles.lbl}>
              Presupuesto al día ({CURRENCY})
            </label>
            <input
              id="planner-budget"
              type="number"
              min={BUDGET.minDailyUsd}
              step={1}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              style={styles.inp}
            />
          </div>
          <div>
            <label htmlFor="planner-country" style={styles.lbl}>
              País al que apuntar
            </label>
            <select
              id="planner-country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              style={styles.inp}
            >
              {country && !COUNTRY_LABELS[country] && (
                <option value={country}>{country}</option>
              )}
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.flag} {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="planner-language" style={styles.lbl}>
              Idioma de los anuncios
            </label>
            <select
              id="planner-language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              style={styles.inp}
            >
              {language && !LANGUAGE_LABELS[language] && (
                <option value={language}>{language}</option>
              )}
              {LANGUAGE_OPTIONS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
            <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 6 }}>
              Si cambias el país o el idioma, la IA buscará las palabras clave
              para esa zona y en ese idioma.
            </p>
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
          onClick={handleAccept}
          disabled={accepting}
          style={{
            ...styles.primaryBtn,
            opacity: accepting ? 0.7 : 1,
            cursor: accepting ? "not-allowed" : "pointer",
          }}
        >
          {accepting ? "Aceptando…" : "Aceptar y continuar"}
        </button>
        <button
          onClick={handleAcceptAndFinish}
          disabled={accepting}
          style={{
            ...styles.secondaryBtn,
            opacity: accepting ? 0.7 : 1,
            cursor: accepting ? "not-allowed" : "pointer",
          }}
        >
          ✨ Acepta y que la IA termine el resto
        </button>
      </div>
      <div style={{ marginTop: 8 }}>
        {!isPlanner && (
          <span style={{ fontSize: 11.5, color: colors.textFaint }}>
            ¿Quieres cambiarlo? Pulsa “Empezar de nuevo” y ajusta tus datos; la IA
            lo rehará por ti.{" "}
          </span>
        )}
        <span style={{ fontSize: 11, color: colors.textFaint }}>
          Nada se publica todavía. Con “que la IA termine” preparará todo y se
          detendrá en el último paso para que tú decidas si activarla.
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
  onReset,
}: {
  state: RunStateDTO;
  colors: ReturnType<typeof useTheme>["colors"];
  styles: Styles;
  activating: boolean;
  onActivate: (campaignNameOverride?: string) => void;
  onReset: () => void;
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
  // The AI always names the campaign; the fallback only matters if the
  // structure step is somehow missing. Use a human label, never a raw run-id
  // slug (which would read as a meaningless code to the user).
  const campaignName = structure?.campaignName?.trim() || "Campaña de Búsqueda";

  // The user may rename the campaign before it's created (optional — it comes
  // pre-filled with the name the AI already chose, so doing nothing is fine).
  const [editedName, setEditedName] = useState(campaignName);
  const trimmedName = editedName.trim();
  // Only send an override when it's non-empty and actually different.
  const nameToSend =
    trimmedName && trimmedName !== campaignName ? trimmedName : undefined;

  const qa = readStep<QAOutput>(state, "policy_qa");
  const blockingIssues = (qa?.issues ?? []).filter((i) => i.severity === "block");
  const fixIssues = (qa?.issues ?? []).filter((i) => i.severity === "fix");

  // SAFETY: if the final review BLOCKED the plan, never offer activation.
  // Show what to fix and let the user start over (nothing is published).
  if (qa?.verdict === "block") {
    const shown = blockingIssues.length ? blockingIssues : fixIssues;
    return (
      <div style={{ ...styles.card, marginTop: 12, borderColor: "#F87171" }}>
        <h2 style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>
          Casi listo: hay que corregir algo antes de publicar ⚠️
        </h2>
        <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>
          La revisión final encontró{" "}
          {shown.length === 1 ? "un punto" : `${shown.length} puntos`} que conviene
          arreglar para cumplir las reglas de Google. Por seguridad, no la
          publicamos hasta que esté bien. No se ha creado nada en Google.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
          {shown.map((issue, i) => (
            <div
              key={i}
              style={{ ...styles.adPreview, borderColor: "rgba(248,113,113,0.4)" }}
            >
              <p style={{ fontSize: 13.5, fontWeight: 600, color: colors.text }}>
                {issue.message}
              </p>
              {issue.suggestion && (
                <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 4 }}>
                  Cómo arreglarlo: {issue.suggestion}
                </p>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={onReset}
          style={{
            ...styles.primaryBtn,
            width: "100%",
            fontSize: 15,
            padding: "13px 24px",
          }}
        >
          Empezar de nuevo
        </button>
        <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 10, textAlign: "center" }}>
          Vuelve a crearla ajustando los datos (por ejemplo, la web o el presupuesto).
        </p>
      </div>
    );
  }

  return (
    <div style={{ ...styles.card, marginTop: 12, borderColor: colors.accent }}>
      <h2 style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>
        Todo listo para activar 🎉
      </h2>
      <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>
        Este es el resumen de tu campaña. Revísalo y actívala cuando quieras.
      </p>

      {/* Editable campaign name — pre-filled with the AI's choice. */}
      <div style={{ marginBottom: 16 }}>
        <label style={styles.lbl} htmlFor="campaign-name">
          Nombre de la campaña
        </label>
        <input
          id="campaign-name"
          type="text"
          value={editedName}
          onChange={(e) => setEditedName(e.target.value)}
          maxLength={120}
          placeholder={campaignName}
          style={{
            width: "100%",
            padding: "11px 14px",
            borderRadius: 10,
            background: colors.bg,
            border: `1px solid ${colors.border}`,
            color: colors.text,
            fontSize: 15,
            fontWeight: 600,
          }}
        />
        <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 6 }}>
          Le pusimos este nombre por ti. Puedes cambiarlo o dejarlo como está —
          es solo para que la reconozcas; tus clientes no lo ven.
        </p>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <Stat label="Grupos de anuncios" value={String(adGroupCount)} colors={colors} />
        <Stat label="Palabras clave" value={String(keywordCount)} colors={colors} />
        {planner?.geo?.countryCodes?.[0] && (
          <Stat
            label="País"
            value={`${countryLabel(planner.geo.countryCodes[0]).flag} ${
              countryLabel(planner.geo.countryCodes[0]).name
            }`}
            colors={colors}
          />
        )}
        {planner?.budget?.dailyUsd != null && (
          <Stat
            label="Presupuesto"
            value={`${planner.budget.dailyUsd} ${CURRENCY}/día`}
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

      {fixIssues.length > 0 && (
        <div
          style={{
            marginBottom: 16,
            padding: 14,
            borderRadius: 10,
            background: "rgba(251,191,36,0.08)",
            border: "1px solid rgba(251,191,36,0.3)",
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            Sugerencias para mejorarla (opcionales):
          </p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {fixIssues.slice(0, 4).map((issue, i) => (
              <li
                key={i}
                style={{ fontSize: 12.5, color: colors.textMuted, marginBottom: 3 }}
              >
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        onClick={() => onActivate(nameToSend)}
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
  // `summary` is the field the agents actually emit on decision events — it was
  // missing here, so even once the payload is unwrapped the human-readable line
  // would never appear. Keep the others as fallbacks for token/progress events.
  const t =
    data.text ??
    data.message ??
    data.summary ??
    data.decision ??
    data.detail ??
    data.delta;
  if (typeof t === "string") return t;
  // The activator streams per-ad-group ticks carrying only the group name.
  if (typeof data.adGroup === "string") return `Creando grupo: ${data.adGroup}`;
  return null;
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
  // Future-proof: honour an explicit AWAITING_APPROVAL status if the engine
  // ever starts setting one on the step itself.
  const explicit = state.steps.find((s) => s.status === "AWAITING_APPROVAL");
  if (explicit) return explicit;
  // Today the engine parks the RUN at "awaiting_approval" after each assisted
  // step but leaves that step COMPLETED. Derive the step pending approval: the
  // last COMPLETED step that still has an un-run, non-activator step after it.
  if (state.run.status !== "awaiting_approval") return null;
  const nextPending = state.steps.find(
    (s) => s.agent !== "activator" && s.status === "NOT_STARTED",
  );
  if (!nextPending) return null; // only the activator remains → activation gate
  const idx = state.steps.indexOf(nextPending);
  for (let i = idx - 1; i >= 0; i--) {
    if (state.steps[i].status === "COMPLETED") return state.steps[i];
  }
  return null;
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
      if (o.geo?.countryCodes?.length) {
        const c = countryLabel(o.geo.countryCodes[0]);
        const more = o.geo.countryCodes.length - 1;
        lines.push(
          `📍 País: ${c.flag} ${c.name}${more > 0 ? ` +${more}` : ""} · anuncios en ${languageLabel(o.geo.languageCode)}`,
        );
      } else if (o.geo?.locations?.length) {
        lines.push(`📍 Zona: ${o.geo.locations.join(", ")}`);
      }
      if (o.budget?.dailyUsd != null)
        lines.push(`💰 Presupuesto: ${o.budget.dailyUsd} ${CURRENCY} al día`);
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
      // The full, scrollable list is rendered separately by <KeywordDetails>
      // (Pedro asked to see EVERY keyword, not just a few examples).
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
      if (o.status) {
        const statusMap: Record<string, string> = {
          PAUSED: "En pausa (lista, sin gastar todavía)",
          ENABLED: "Activa (ya puede mostrarse)",
          REMOVED: "Eliminada",
        };
        lines.push(`Estado: ${statusMap[o.status] ?? o.status}`);
      }
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
