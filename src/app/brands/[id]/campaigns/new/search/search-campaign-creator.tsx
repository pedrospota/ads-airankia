"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";
import {
  BUDGET,
  PIPELINE,
  type ActivateResponse,
  type AdGroupAds,
  type AgentId,
  type KeywordIdea,
  type KeywordResearchOutput,
  type MatchType,
  type NegativeKeywordIdea,
  type ObjectiveType,
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
  planner: "Sets your goal, where to advertise, and how much to spend per day.",
  keyword_researcher: "Finds the words your customer types into Google.",
  structure_architect: "Organizes everything into groups so each ad fits.",
  rsa_copywriter: "Writes the headlines and text for your ads.",
  policy_qa: "Checks that everything follows Google's rules before publishing.",
  activator: "Creates the campaign in Google Ads (always paused).",
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
  planner: "Your plan",
  keyword_researcher: "What your customer searches for",
  structure_architect: "How your ads are organized",
  rsa_copywriter: "Your ads",
  policy_qa: "Final review",
  activator: "Create in Google Ads",
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
          let msg = "We couldn't continue. Please try again in a moment.";
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
            "We couldn't continue. Check your connection and try again.",
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
          data.error || "We couldn't fill it in with AI. Please try again.",
        );
      }
      if (data.objective) setObjectiveHint(data.objective);
      if (data.budgetDailyUsd != null) setBudgetHint(String(data.budgetDailyUsd));
      if (data.reason) setBudgetReason(data.reason);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setSuggestError(
        e instanceof Error ? e.message : "We couldn't fill it in with AI.",
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
        throw new Error(data.error || "We couldn't create the campaign. Please try again.");
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
      setError(e instanceof Error ? e.message : "Something went wrong getting started.");
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
        "We're going to create your campaign in your Google Ads account.\n\nIt will stay PAUSED, so nothing is spent yet: you decide when to turn it on.\n\nShall we continue?",
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
        throw new Error(data.error || "We couldn't create the campaign in Google Ads.");
      }
      setActivateResult(data);
      await refreshState(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't activate it.");
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
        "Your campaign will become ACTIVE: it will start showing on Google and spending up to your daily budget.\n\nAre you sure you want to turn it on now?",
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
        throw new Error(data.error || "We couldn't turn it on.");
      }
      setActivateResult(data);
      await refreshState(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't turn it on.");
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
        "We're going to delete this campaign from your Google Ads account.\n\nNothing has been spent (it was paused) and you can create another one whenever you want.\n\nAre you sure you want to discard it?",
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
        throw new Error(data.error || "We couldn't discard the campaign.");
      }
      // Clean slate — the discarded run is gone; let them start over.
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't discard it.");
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
        "Are you sure you want to start over? You'll lose the campaign the AI has prepared.",
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
          { label: "Brands", href: "/brands" },
          { label: brandName, href: `/brands/${brandId}/citations` },
          { label: "Search Campaign" },
        ]}
      />

      <main className="max-w-3xl mx-auto px-6 py-8">
        {/* ---------------- START CARD ---------------- */}
        {showStart && (
          <div>
            <h1 className="text-2xl font-bold mb-1">New Search campaign</h1>
            <p style={{ color: colors.textMuted, marginBottom: 24, fontSize: 14 }}>
              You don't need to fill in anything: the AI uses your business info
              to prepare the campaign. If you want, tweak something before you start.
            </p>

            <div style={styles.card}>
              <div style={{ marginBottom: 18 }}>
                <label htmlFor="campaign-brand-name" style={styles.lbl}>
                  Your brand name
                </label>
                <input
                  id="campaign-brand-name"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="My business"
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
                    What do you want to achieve? (optional)
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
                    {suggesting ? "Thinking…" : "✨ Fill in with AI"}
                  </button>
                </div>
                <textarea
                  id="campaign-objective"
                  value={objectiveHint}
                  onChange={(e) => setObjectiveHint(e.target.value)}
                  rows={3}
                  placeholder="E.g.: I want more bookings for my restaurant in Madrid"
                  style={{ ...styles.inp, resize: "vertical" }}
                />
                <p style={styles.hint}>
                  You don't have to fill in anything: if you leave it blank, the AI
                  decides the goal, the area, and the budget, and shows you its
                  proposal before activating. Or press “✨ Fill in with AI”.
                </p>
                {suggestError && (
                  <p role="alert" style={{ ...styles.hint, color: "#ef4444" }}>
                    {suggestError}
                  </p>
                )}
              </div>

              <div style={{ marginBottom: 22 }}>
                <label htmlFor="campaign-budget" style={styles.lbl}>
                  Daily budget (optional)
                </label>
                <input
                  id="campaign-budget"
                  type="number"
                  min={BUDGET.minDailyUsd}
                  step={1}
                  value={budgetHint}
                  onChange={(e) => setBudgetHint(e.target.value)}
                  placeholder="E.g.: 10"
                  style={styles.inp}
                />
                <p style={styles.hint}>
                  If you leave it blank, we'll suggest one for you. Minimum {BUDGET.minDailyUsd} {CURRENCY} per day.
                </p>
                {budgetReason && (
                  <p style={{ ...styles.hint, marginTop: 6, color: "#0f766e" }}>
                    ✨ {budgetReason}
                  </p>
                )}
              </div>

              {/* MODE TOGGLE — big and visual */}
              <div style={styles.lbl} id="campaign-mode-label">
                How do you want to do it?
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
                  title="Automatic (one click)"
                  desc="The 6 helpers do everything and show you the result to activate."
                  recommended
                  colors={colors}
                />
                <ModeCard
                  active={mode === "assisted"}
                  onClick={() => setMode("assisted")}
                  emoji="✍️"
                  title="Step by step"
                  desc="You review and tweak each step before moving on to the next."
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
              {starting ? "Starting…" : "Create my campaign"}
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
                    ? "Automatic mode — preparing your campaign…"
                    : "Step-by-step mode — review each step."}
                </p>
              </div>
              <div className="flex items-center" style={{ gap: 8 }}>
                <Link
                  href={`/brands/${brandId}/citations`}
                  style={{ ...styles.ghostBtn, textDecoration: "none" }}
                >
                  ← Back to brand
                </Link>
                <button onClick={confirmReset} style={styles.ghostBtn}>
                  Start over
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
                  Preparing your campaign… this only takes a few seconds.
                </span>
              </div>
            )}

            {/* FAILED state */}
            {failed && (
              <div style={{ marginBottom: 24 }}>
                <ErrorBox>
                  {state?.run.error || "The campaign couldn't be completed."}
                </ErrorBox>
                <button
                  onClick={reset}
                  style={{ ...styles.primaryBtn, marginTop: 12 }}
                >
                  Try again
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
                    ? "Your campaign is live!"
                    : "Campaign created in Google Ads!"}
                </h2>
                {activateResult.googleCampaignId && (
                  <p style={{ fontSize: 12, color: colors.textFaint, marginBottom: 8 }}>
                    Google Ads ID: {activateResult.googleCampaignId}
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
                      Here's what we created in your campaign:
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
                      <li>{activateResult.summary.adGroupsCount} ad groups</li>
                      <li>{activateResult.summary.keywordsCount} keywords</li>
                      <li>
                        {activateResult.summary.negativesCount} negative
                        keywords (to avoid overspending)
                      </li>
                      <li>{activateResult.summary.adsCount} ads</li>
                      {activateResult.summary.assetsCount > 0 && (
                        <li>
                          {activateResult.summary.assetsCount} extensions
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
                      View in Google Ads ↗
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
                  const what = labels.length > 0 ? labels.join(" and ") : "your results";

                  if (rung === "R3") {
                    return (
                      <div style={greenBox}>
                        <p style={textStyle}>
                          ✓ Your campaign already looks for customers, not just
                          visits. Your account is properly measuring {what}
                          —things that really happen— and we've told Google to
                          prioritize getting more. Anything you measure but hasn't
                          happened yet, we'll add automatically as soon as it
                          starts happening. You don't have to touch a thing.
                        </p>
                      </div>
                    );
                  }
                  if (rung === "R2") {
                    return (
                      <div style={amberBox}>
                        <p style={textStyle}>
                          Your account is already set up to measure results, but
                          there isn't enough data yet to optimize safely. In the
                          meantime, your campaign gets the most quality visits it
                          can with your budget, and we keep counting every result.
                          As soon as there's enough data, we'll switch to looking
                          for customers on our own. You don't have to do anything.
                        </p>
                      </div>
                    );
                  }
                  if (rung === "R1") {
                    return (
                      <div style={amberBox}>
                        <p style={textStyle}>
                          Your account isn't measuring any results yet (sign-ups,
                          sales, contacts...), so we can't optimize for getting
                          customers yet. For now your campaign gets the most
                          quality visits it can with your budget. Once you start
                          measuring, it'll switch to looking for customers on its
                          own. You don't have to decide anything.
                        </p>
                      </div>
                    );
                  }
                  // Fallback for runs created before the rung existed: original
                  // binary copy, so already-activated campaigns never break.
                  return activateResult.conversionTrackingEnabled ? (
                    <div style={greenBox}>
                      <p style={textStyle}>
                        ✓ Your campaign already measures real results (sales or
                        contacts), not just visits. We'll optimize it toward what
                        truly matters to you.
                      </p>
                    </div>
                  ) : (
                    <div style={amberBox}>
                      <p style={textStyle}>
                        For now your site isn't measuring results yet (sales or
                        contacts), so we bid for clicks so your ad shows from day
                        one. Later we'll be able to measure those results and
                        optimize toward them: we'll set it up for you, without you
                        having to touch a thing.
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
                      It's paused. Nothing is spent until you turn it on.
                    </p>
                    <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>
                      When you turn it on, it'll start showing on Google and
                      spending up to your daily budget. You can pause it again
                      whenever you want, at no cost.
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
                      {enabling ? "Turning it on…" : "Turn it on"}
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
                          ? "Discarding…"
                          : "Discard this campaign (removes it from Google Ads)"}
                      </button>
                    </div>
                  </>
                )}
                {enabledNow && (
                  <>
                    <p style={{ fontSize: 14, color: colors.accent, fontWeight: 600 }}>
                      It's now active and showing on Google.
                    </p>
                    <p style={{ fontSize: 13, color: colors.textMuted, marginTop: 8 }}>
                      From now on it can spend up to your daily budget. If you
                      want to stop it, go into your Google Ads account and pause
                      it whenever you want.
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
                    Next steps:
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
                        <li>⏱️ Check your first clicks in 24-48 hours.</li>
                        <li>📊 See whether quality customers are coming in.</li>
                        <li>
                          🔧 If needed, adjust your keywords or your budget.
                        </li>
                      </>
                    ) : (
                      <>
                        <li>
                          👀 Review the proposal at your own pace: the name, the
                          keywords, and the ads.
                        </li>
                        <li>
                          ▶️ When you're ready, press “Turn it on” to start
                          showing it on Google.
                        </li>
                        <li>
                          📊 As soon as it gets its first clicks, I'll help you
                          improve it.
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
  ES: { name: "Spain", flag: "🇪🇸" },
  MX: { name: "Mexico", flag: "🇲🇽" },
  AR: { name: "Argentina", flag: "🇦🇷" },
  CO: { name: "Colombia", flag: "🇨🇴" },
  CL: { name: "Chile", flag: "🇨🇱" },
  PE: { name: "Peru", flag: "🇵🇪" },
  US: { name: "United States", flag: "🇺🇸" },
  GB: { name: "United Kingdom", flag: "🇬🇧" },
  FR: { name: "France", flag: "🇫🇷" },
  DE: { name: "Germany", flag: "🇩🇪" },
  IT: { name: "Italy", flag: "🇮🇹" },
  PT: { name: "Portugal", flag: "🇵🇹" },
};

const LANGUAGE_LABELS: Record<string, string> = {
  es: "Spanish",
  en: "English",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
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

// ── Objetivo de la campaña: nombres amables en español ───────────────────────
// La IA elige el objetivo por defecto según la web de la marca; aquí solo lo
// enseñamos claro y dejamos que el usuario lo cambie con un clic si quiere.
// Las claves coinciden con ObjectiveType de src/lib/engine/types.ts.
const OBJECTIVE_LABELS: Record<ObjectiveType, string> = {
  leads: "Get contacts (potential customers)",
  sales: "Sell or get purchases on your website",
  calls: "Get phone calls",
  traffic: "Bring more visitors to your website",
  awareness: "Get your brand known",
};

function objectiveLabel(type?: string): string {
  const t = (type ?? "").toLowerCase();
  return OBJECTIVE_LABELS[t as ObjectiveType] ?? (type || "—");
}

const OBJECTIVE_OPTIONS = Object.entries(OBJECTIVE_LABELS).map(
  ([code, name]) => ({ code, name }),
);

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
          🌍 We're detecting your brand's country…
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
        <span style={{ fontSize: 12.5, color: colors.textMuted }}>Your campaign targets</span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          {primary.flag} {primary.name}
          {extra > 0 ? ` +${extra}` : ""}
        </span>
        <span style={{ fontSize: 12.5, color: colors.textMuted }}>
          · ads in {lang}
        </span>
      </div>
      <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 5 }}>
        The AI chose this based on your brand's website, which is why the keywords
        come out in {lang.toLowerCase()}. If it's not right, you can change it in «
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
    ? "Your campaign is ready. Review the summary and activate it whenever you want."
    : state?.run.status === "failed"
      ? "There was a problem preparing the campaign."
      : workingAgent
        ? `Preparing: ${STEP_TITLE[workingAgent]}.`
        : "Preparing your campaign…";

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
    pending: { t: "Pending", bg: "rgba(161,161,170,0.12)", c: colors.textMuted },
    working: { t: "Working…", bg: "rgba(59,130,246,0.15)", c: "#60A5FA" },
    done: { t: "Ready", bg: "rgba(16,185,129,0.15)", c: colors.accent },
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
// ----------------------------------------------------------------------------
// Keyword metric display (surfaces a2's real numbers). a2 attaches real Google
// Keyword Planner metrics (search volume / competition / top-of-page CPC) when
// Google returns them, or LLM estimates otherwise. These helpers render them
// read-only so a non-expert can see the demand behind each keyword. Every helper
// degrades to "—"/null on missing data (metrics are optional and absent on
// estimate rows) — never "€NaN"/"undefinedK".
// ----------------------------------------------------------------------------

function fmtVolume(n?: number): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

function fmtMicros(micros?: number): string | null {
  if (micros == null || !Number.isFinite(micros) || micros <= 0) return null;
  const v = micros / 1_000_000;
  return `${CURRENCY}${v.toFixed(v >= 10 ? 0 : 2)}`;
}

function fmtCpcRange(lowMicros?: number, highMicros?: number): string {
  const lo = fmtMicros(lowMicros);
  const hi = fmtMicros(highMicros);
  if (lo && hi) return lo === hi ? lo : `${lo}–${hi}`;
  return lo || hi || "—";
}

function fmtScore(score?: number): string | null {
  if (score == null || !Number.isFinite(score)) return null;
  return String(score <= 1 ? Math.round(score * 100) : Math.round(score));
}

function competitionChip(
  level?: "LOW" | "MEDIUM" | "HIGH"
): { bg: string; border: string; label: string } | null {
  if (level === "LOW")
    return { bg: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.35)", label: "Low" };
  if (level === "MEDIUM")
    return { bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.35)", label: "Medium" };
  if (level === "HIGH")
    return { bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.35)", label: "High" };
  return null;
}

// AI default ordering: highest composite score first; rows with no score sink to
// the bottom (estimates often lack one). MUST be applied to the underlying state
// ONCE (not a per-render derived view) wherever rows are edited by index, or
// index-based edits target the wrong row.
function sortKeywordsByScore(keywords: KeywordIdea[]): KeywordIdea[] {
  return keywords.slice().sort((a, b) => {
    const sa = a.score ?? -1;
    const sb = b.score ?? -1;
    if (sb !== sa) return sb - sa;
    return (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1);
  });
}

function MetricsSourceBadge({
  source,
  colors,
}: {
  source?: KeywordResearchOutput["metricsSource"];
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  const real = source === "google_keyword_planner";
  return (
    <span
      title={
        real
          ? "Search volume, competition and CPC come straight from Google's Keyword Planner."
          : "Google didn't return data for these terms, so the numbers are AI estimates."
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 99,
        whiteSpace: "nowrap",
        background: real ? "rgba(16,185,129,0.12)" : "rgba(148,163,184,0.14)",
        border: `1px solid ${real ? "rgba(16,185,129,0.35)" : "rgba(148,163,184,0.35)"}`,
        color: real ? "#10B981" : colors.textMuted,
      }}
    >
      {real ? "Real Google data ✓" : "AI estimate"}
    </span>
  );
}

// Compact, read-only metric chips shown next to a keyword. Renders nothing when
// the keyword has no metrics at all (so estimate rows don't show empty boxes).
function KeywordMetricChips({
  k,
  colors,
}: {
  k: KeywordIdea;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  const vol = fmtVolume(k.avgMonthlySearches);
  const comp = competitionChip(k.competition);
  const cpc = fmtCpcRange(k.topOfPageBidLowMicros, k.topOfPageBidHighMicros);
  const score = fmtScore(k.score);
  if (vol === "—" && !comp && cpc === "—" && !score) return null;

  const pill: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: 11,
    padding: "2px 7px",
    borderRadius: 99,
    background: "rgba(148,163,184,0.10)",
    border: `1px solid ${colors.border}`,
    color: colors.textMuted,
    whiteSpace: "nowrap",
  };
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      {vol !== "—" && (
        <span style={pill} title="Average monthly searches on Google">
          🔍 {vol}/mo
        </span>
      )}
      {comp && (
        <span
          style={{ ...pill, background: comp.bg, border: `1px solid ${comp.border}`, color: colors.text }}
          title="How many advertisers compete for this term"
        >
          {comp.label} comp.
        </span>
      )}
      {cpc !== "—" && (
        <span style={pill} title="Estimated top-of-page bid (cost per click)">
          {cpc} CPC
        </span>
      )}
      {score && (
        <span style={pill} title="Priority score = volume × intent × relevance × affordability">
          ★ {score}
        </span>
      )}
    </span>
  );
}

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
          ? "Hide the full list"
          : `See the full list (${keywords.length + negatives.length})`}
      </button>
      {open && (
        <div style={{ marginTop: 10, maxHeight: 320, overflow: "auto" }}>
          {keywords.length > 0 && (
            <div style={{ marginBottom: negatives.length ? 14 : 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <p
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: colors.textMuted,
                    margin: 0,
                  }}
                >
                  🔑 Keywords you&apos;ll show up for ({keywords.length})
                </p>
                <MetricsSourceBadge source={data.metricsSource} colors={colors} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {sortKeywordsByScore(keywords).map((k, i) => (
                  <div
                    key={"kw" + i + k.text}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 6,
                    }}
                  >
                    {chip(k.text, "kw")}
                    <KeywordMetricChips k={k} colors={colors} />
                  </div>
                ))}
              </div>
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
                🚫 Keywords we'll avoid ({negatives.length})
              </p>
              <div>{negatives.map((n) => chip(n.text, "neg"))}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Match-type options shared by the keyword editor (plain labels, no jargon).
const MATCH_OPTIONS: { value: MatchType; label: string }[] = [
  { value: "PHRASE", label: "Phrase" },
  { value: "EXACT", label: "Exact" },
  { value: "BROAD", label: "Broad" },
];

// Friendly, NO-JSON editor for the keyword step. The AI already chose every
// keyword; this just lets a non-expert tweak the text, switch the match type with
// a dropdown, remove, or add — with one click. Edits flow up via onChange so the
// parent sends them as the step's userOverride. A newly-added keyword inherits a
// real theme/intent from an existing one so the next step (which groups keywords
// by theme) never silently drops it.
function KeywordEditor({
  value,
  colors,
  styles,
  onChange,
}: {
  value: KeywordResearchOutput;
  colors: ReturnType<typeof useTheme>["colors"];
  styles: Styles;
  onChange: (v: KeywordResearchOutput) => void;
}) {
  // Seed sorted by score ONCE (not a per-render derived view): the rows below are
  // edited by array index, so the underlying state itself must be in display order
  // or an edit would target the wrong row.
  const [kws, setKws] = useState<KeywordIdea[]>(
    () => sortKeywordsByScore(value.keywords ?? [])
  );
  const [negs, setNegs] = useState<NegativeKeywordIdea[]>(
    () => value.negatives ?? []
  );

  function commit(nextKws: KeywordIdea[], nextNegs: NegativeKeywordIdea[]) {
    setKws(nextKws);
    setNegs(nextNegs);
    onChange({ ...value, keywords: nextKws, negatives: nextNegs });
  }

  function addKw() {
    const base = kws[0];
    commit(
      [
        ...kws,
        {
          text: "",
          matchType: "PHRASE",
          theme: base?.theme ?? "",
          intent: base?.intent ?? "commercial",
          source: "manual",
        },
      ],
      negs
    );
  }
  function addNeg() {
    const base = negs[0];
    commit(kws, [
      ...negs,
      {
        text: "",
        matchType: "PHRASE",
        negativeClass: base?.negativeClass ?? "wrong_intent",
      },
    ]);
  }

  const rowStyle: CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "center",
    marginBottom: 8,
  };
  const matchSelect: CSSProperties = {
    ...styles.inp,
    width: 104,
    flex: "0 0 auto",
    padding: "8px 10px",
  };
  const textInput: CSSProperties = { ...styles.inp, flex: 1, minWidth: 0 };
  const removeBtn: CSSProperties = {
    flex: "0 0 auto",
    width: 32,
    height: 32,
    borderRadius: 8,
    cursor: "pointer",
    background: "transparent",
    border: `1px solid ${colors.border}`,
    color: "#F87171",
    fontSize: 18,
    lineHeight: 1,
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <p style={{ ...styles.lbl, margin: 0 }}>
          🔑 Keywords you&apos;ll show up for ({kws.length})
        </p>
        <MetricsSourceBadge source={value.metricsSource} colors={colors} />
      </div>
      <div style={{ maxHeight: 280, overflow: "auto", paddingRight: 4 }}>
        {kws.map((k, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ ...rowStyle, marginBottom: 0 }}>
            <input
              value={k.text}
              onChange={(e) =>
                commit(
                  kws.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                  negs
                )
              }
              style={textInput}
              placeholder="keyword"
            />
            <select
              value={k.matchType}
              onChange={(e) =>
                commit(
                  kws.map((x, j) =>
                    j === i ? { ...x, matchType: e.target.value as MatchType } : x
                  ),
                  negs
                )
              }
              style={matchSelect}
              aria-label="Match type"
            >
              {MATCH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => commit(kws.filter((_, j) => j !== i), negs)}
              style={removeBtn}
              aria-label="Remove keyword"
            >
              ×
            </button>
            </div>
            <div style={{ marginTop: 5, paddingLeft: 2 }}>
              <KeywordMetricChips k={k} colors={colors} />
            </div>
          </div>
        ))}
      </div>
      <button type="button" onClick={addKw} style={{ ...styles.ghostBtn, marginTop: 4 }}>
        + Add keyword
      </button>

      <p style={{ ...styles.lbl, marginTop: 18, marginBottom: 8 }}>
        🚫 Keywords we&apos;ll avoid ({negs.length})
      </p>
      <div style={{ maxHeight: 200, overflow: "auto", paddingRight: 4 }}>
        {negs.map((n, i) => (
          <div key={i} style={rowStyle}>
            <input
              value={n.text}
              onChange={(e) =>
                commit(
                  kws,
                  negs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x))
                )
              }
              style={textInput}
              placeholder="keyword to avoid"
            />
            <select
              value={n.matchType}
              onChange={(e) =>
                commit(
                  kws,
                  negs.map((x, j) =>
                    j === i ? { ...x, matchType: e.target.value as MatchType } : x
                  )
                )
              }
              style={matchSelect}
              aria-label="Match type"
            >
              {MATCH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => commit(kws, negs.filter((_, j) => j !== i))}
              style={removeBtn}
              aria-label="Remove keyword to avoid"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={addNeg} style={{ ...styles.ghostBtn, marginTop: 4 }}>
        + Add a keyword to avoid
      </button>
      <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 10 }}>
        Match type: <strong>Phrase</strong> and <strong>Exact</strong> keep you
        tightly on-topic; <strong>Broad</strong> reaches more but needs results
        data first.
      </p>
    </div>
  );
}

// Friendly, NO-JSON editor for the ads (RSA) step: edit each headline and
// description's text inline, with a live character counter and Google's limits
// enforced (15 headlines max / 90-char descriptions, etc.). Pinning, paths and
// the destination URL are preserved untouched. Edits flow up via onChange.
function RsaEditor({
  value,
  colors,
  styles,
  onChange,
}: {
  value: RSAOutput;
  colors: ReturnType<typeof useTheme>["colors"];
  styles: Styles;
  onChange: (v: RSAOutput) => void;
}) {
  const [ads, setAds] = useState<AdGroupAds[]>(() => value.ads ?? []);

  function commit(next: AdGroupAds[]) {
    setAds(next);
    onChange({ ...value, ads: next });
  }
  function updateAd(ai: number, patch: Partial<AdGroupAds>) {
    commit(ads.map((a, j) => (j === ai ? { ...a, ...patch } : a)));
  }

  const HEADLINE_MAX = 30;
  const DESC_MAX = 90;
  const rowStyle: CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "center",
    marginBottom: 8,
  };
  const removeBtn: CSSProperties = {
    flex: "0 0 auto",
    width: 32,
    height: 32,
    borderRadius: 8,
    cursor: "pointer",
    background: "transparent",
    border: `1px solid ${colors.border}`,
    color: "#F87171",
    fontSize: 18,
    lineHeight: 1,
  };
  const counter = (len: number, max: number): CSSProperties => ({
    flex: "0 0 auto",
    width: 48,
    textAlign: "right",
    fontSize: 11,
    color: len > max ? "#F87171" : colors.textFaint,
  });

  return (
    <div style={{ marginBottom: 12 }}>
      {ads.map((ad, ai) => (
        <div
          key={ai}
          style={{
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
            {ad.adGroupName}
          </p>

          <p style={{ ...styles.lbl, marginBottom: 8 }}>
            Headlines ({ad.headlines.length}/15)
          </p>
          {ad.headlines.map((h, hi) => (
            <div key={hi} style={rowStyle}>
              <input
                value={h.text}
                maxLength={HEADLINE_MAX}
                onChange={(e) =>
                  updateAd(ai, {
                    headlines: ad.headlines.map((x, j) =>
                      j === hi ? { ...x, text: e.target.value } : x
                    ),
                  })
                }
                style={{ ...styles.inp, flex: 1, minWidth: 0 }}
                placeholder="headline"
              />
              <span style={counter(h.text.length, HEADLINE_MAX)}>
                {h.text.length}/{HEADLINE_MAX}
              </span>
              <button
                type="button"
                onClick={() =>
                  ad.headlines.length > 3 &&
                  updateAd(ai, {
                    headlines: ad.headlines.filter((_, j) => j !== hi),
                  })
                }
                disabled={ad.headlines.length <= 3}
                style={{
                  ...removeBtn,
                  opacity: ad.headlines.length <= 3 ? 0.35 : 1,
                  cursor: ad.headlines.length <= 3 ? "not-allowed" : "pointer",
                }}
                aria-label="Remove headline"
              >
                ×
              </button>
            </div>
          ))}
          {ad.headlines.length < 15 && (
            <button
              type="button"
              onClick={() =>
                updateAd(ai, {
                  headlines: [...ad.headlines, { text: "" }],
                })
              }
              style={{ ...styles.ghostBtn, marginTop: 2, marginBottom: 6 }}
            >
              + Add headline
            </button>
          )}

          <p style={{ ...styles.lbl, marginTop: 12, marginBottom: 8 }}>
            Descriptions ({ad.descriptions.length}/4)
          </p>
          {ad.descriptions.map((d, di) => (
            <div key={di} style={rowStyle}>
              <input
                value={d.text}
                maxLength={DESC_MAX}
                onChange={(e) =>
                  updateAd(ai, {
                    descriptions: ad.descriptions.map((x, j) =>
                      j === di ? { ...x, text: e.target.value } : x
                    ),
                  })
                }
                style={{ ...styles.inp, flex: 1, minWidth: 0 }}
                placeholder="description"
              />
              <span style={counter(d.text.length, DESC_MAX)}>
                {d.text.length}/{DESC_MAX}
              </span>
              <button
                type="button"
                onClick={() =>
                  ad.descriptions.length > 2 &&
                  updateAd(ai, {
                    descriptions: ad.descriptions.filter((_, j) => j !== di),
                  })
                }
                disabled={ad.descriptions.length <= 2}
                style={{
                  ...removeBtn,
                  opacity: ad.descriptions.length <= 2 ? 0.35 : 1,
                  cursor: ad.descriptions.length <= 2 ? "not-allowed" : "pointer",
                }}
                aria-label="Remove description"
              >
                ×
              </button>
            </div>
          ))}
          {ad.descriptions.length < 4 && (
            <button
              type="button"
              onClick={() =>
                updateAd(ai, {
                  descriptions: [...ad.descriptions, { text: "" }],
                })
              }
              style={{ ...styles.ghostBtn, marginTop: 2 }}
            >
              + Add description
            </button>
          )}
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
  // Objetivo de la campaña: la IA lo eligió; aquí dejamos cambiarlo con un clic.
  const [objectiveType, setObjectiveType] = useState<string>(
    planner?.objectiveType?.toLowerCase() ?? "",
  );
  // País + idioma: la IA ya los eligió; aquí solo dejamos cambiarlos con un clic.
  const [country, setCountry] = useState<string>(
    planner?.geo?.countryCodes?.[0]?.toUpperCase() ?? "",
  );
  const [language, setLanguage] = useState<string>(
    planner?.geo?.languageCode?.toLowerCase() ?? "",
  );

  // Friendly, no-JSON editors for the two steps a user most wants to tweak:
  // the keyword list and the ad copy. The AI already filled both; this just
  // makes editing one-click (a dropdown + text fields) instead of touching JSON.
  const isKeyword = step.agent === "keyword_researcher";
  const isRsa = step.agent === "rsa_copywriter";
  const canEditFriendly = isKeyword || isRsa;
  const [showEditor, setShowEditor] = useState(false);
  // Holds the user's edits (full output object) so they ride along as the
  // step's userOverride on accept. Null until they actually change something.
  const [editedOutput, setEditedOutput] = useState<unknown>(null);

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
        setParseError("We couldn't read the changes. Check the format.");
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
        objectiveType:
          (objectiveType as ObjectiveType) || planner.objectiveType,
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
    // Friendly editors (keywords / ad copy): if the user changed anything, send
    // their edited version as the override; otherwise accept the AI's output.
    if (canEditFriendly && editedOutput != null) {
      cb(step.id, editedOutput);
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
        Does this look right? You can accept it or tweak it.
      </p>

      {isPlanner && planner && !editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
          <div>
            <label htmlFor="planner-objective-type" style={styles.lbl}>
              What do you want to achieve?
            </label>
            <select
              id="planner-objective-type"
              value={objectiveType}
              onChange={(e) => setObjectiveType(e.target.value)}
              style={styles.inp}
            >
              {objectiveType && !OBJECTIVE_LABELS[objectiveType as ObjectiveType] && (
                <option value={objectiveType}>{objectiveType}</option>
              )}
              {OBJECTIVE_OPTIONS.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </select>
            <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 6 }}>
              The AI chose this for you by looking at your website. If you change
              it, it'll adjust the ads and the bidding for that goal.
            </p>
          </div>
          <div>
            <label htmlFor="planner-objective" style={styles.lbl}>
              In your own words (optional)
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
              Daily budget ({CURRENCY})
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
              Target country
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
              Ad language
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
              If you change the country or the language, the AI will look for
              keywords for that area and in that language.
            </p>
          </div>
        </div>
      )}

      {canEditFriendly && !editing && (
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            onClick={() => setShowEditor((v) => !v)}
            style={{ ...styles.ghostBtn, marginBottom: showEditor ? 12 : 0 }}
          >
            {showEditor
              ? "✓ Done editing"
              : isKeyword
                ? "✏️ Edit keywords"
                : "✏️ Edit the ads"}
          </button>
          {showEditor && isKeyword && isRecord(out) && (
            <KeywordEditor
              value={out as unknown as KeywordResearchOutput}
              colors={colors}
              styles={styles}
              onChange={setEditedOutput}
            />
          )}
          {showEditor && isRsa && isRecord(out) && (
            <RsaEditor
              value={out as unknown as RSAOutput}
              colors={colors}
              styles={styles}
              onChange={setEditedOutput}
            />
          )}
        </div>
      )}

      {editing && (
        <div style={{ marginBottom: 12 }}>
          <label style={styles.lbl}>Settings (advanced)</label>
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
          {accepting ? "Accepting…" : "Accept and continue"}
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
          ✨ Accept and let the AI finish the rest
        </button>
      </div>
      <div style={{ marginTop: 8 }}>
        {canEditFriendly && (
          <span style={{ fontSize: 11.5, color: colors.textFaint }}>
            {isKeyword ? "Edit keywords" : "Edit the ads"} above with one click,
            or just accept what the AI prepared.{" "}
          </span>
        )}
        {!isPlanner && !canEditFriendly && (
          <span style={{ fontSize: 11.5, color: colors.textFaint }}>
            Want to change it? Press “Start over” and adjust your details; the AI
            will redo it for you.{" "}
          </span>
        )}
        <span style={{ fontSize: 11, color: colors.textFaint }}>
          Nothing is published yet. With “let the AI finish” it'll prepare
          everything and stop at the last step so you can decide whether to
          activate it.
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
  const campaignName = structure?.campaignName?.trim() || "Search Campaign";

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
          Almost there: something needs fixing before publishing ⚠️
        </h2>
        <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>
          The final review found{" "}
          {shown.length === 1 ? "one item" : `${shown.length} items`} worth fixing
          to comply with Google's rules. To be safe, we won't publish it until
          it's right. Nothing has been created in Google.
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
                  How to fix it: {issue.suggestion}
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
          Start over
        </button>
        <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 10, textAlign: "center" }}>
          Create it again by adjusting the details (for example, the website or the budget).
        </p>
      </div>
    );
  }

  return (
    <div style={{ ...styles.card, marginTop: 12, borderColor: colors.accent }}>
      <h2 style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>
        All set to activate 🎉
      </h2>
      <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>
        Here's the summary of your campaign. Review it and activate it whenever you want.
      </p>

      {/* Editable campaign name — pre-filled with the AI's choice. */}
      <div style={{ marginBottom: 16 }}>
        <label style={styles.lbl} htmlFor="campaign-name">
          Campaign name
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
          We named it for you. You can change it or leave it as is — it's just so
          you recognize it; your customers don't see it.
        </p>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <Stat label="Ad groups" value={String(adGroupCount)} colors={colors} />
        <Stat label="Keywords" value={String(keywordCount)} colors={colors} />
        {planner?.geo?.countryCodes?.[0] && (
          <Stat
            label="Country"
            value={`${countryLabel(planner.geo.countryCodes[0]).flag} ${
              countryLabel(planner.geo.countryCodes[0]).name
            }`}
            colors={colors}
          />
        )}
        {planner?.budget?.dailyUsd != null && (
          <Stat
            label="Budget"
            value={`${planner.budget.dailyUsd} ${CURRENCY}/day`}
            colors={colors}
          />
        )}
      </div>

      {sampleAd && (
        <div style={{ marginBottom: 16 }}>
          <p style={styles.lbl}>Sample ad</p>
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
            Suggestions to improve it (optional):
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
        {activating ? "Creating in Google Ads…" : "Activate campaign"}
      </button>
      <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 10, textAlign: "center" }}>
        It's created in Google Ads PAUSED; you decide when to turn it on.
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
  if (typeof data.adGroup === "string") return `Creating group: ${data.adGroup}`;
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
      if (o.objectiveType)
        lines.push(`🎯 Goal: ${objectiveLabel(o.objectiveType)}`);
      if (o.objectiveSummary) lines.push(`💬 ${o.objectiveSummary}`);
      if (o.geo?.countryCodes?.length) {
        const c = countryLabel(o.geo.countryCodes[0]);
        const more = o.geo.countryCodes.length - 1;
        lines.push(
          `📍 Country: ${c.flag} ${c.name}${more > 0 ? ` +${more}` : ""} · ads in ${languageLabel(o.geo.languageCode)}`,
        );
      } else if (o.geo?.locations?.length) {
        lines.push(`📍 Area: ${o.geo.locations.join(", ")}`);
      }
      if (o.budget?.dailyUsd != null)
        lines.push(`💰 Budget: ${o.budget.dailyUsd} ${CURRENCY} per day`);
      if (o.themes?.length)
        lines.push(`🗂️ Themes: ${o.themes.map((t) => t.name).join(", ")}`);
      return lines;
    }
    case "keyword_researcher": {
      const o = out as Partial<KeywordResearchOutput>;
      const lines: string[] = [];
      if (o.keywords?.length)
        lines.push(`🔑 ${o.keywords.length} keywords found`);
      if (o.negatives?.length)
        lines.push(`🚫 ${o.negatives.length} negative keywords`);
      // At-a-glance: total real demand behind the keyword set + where the numbers
      // came from (Google Keyword Planner vs AI estimate).
      const withVol =
        o.keywords?.filter((k) => (k.avgMonthlySearches ?? 0) > 0) ?? [];
      if (withVol.length) {
        const total = withVol.reduce(
          (s, k) => s + (k.avgMonthlySearches ?? 0),
          0
        );
        const src =
          o.metricsSource === "google_keyword_planner"
            ? "real Google data"
            : "AI estimates";
        lines.push(`📊 ~${fmtVolume(total)} searches/mo total (${src})`);
      }
      // The full, scrollable list is rendered separately by <KeywordDetails>
      // (Pedro asked to see EVERY keyword, not just a few examples).
      return lines;
    }
    case "structure_architect": {
      const o = out as Partial<StructureOutput>;
      const lines: string[] = [];
      if (o.campaignName) lines.push(`📛 Campaign: ${o.campaignName}`);
      if (o.adGroups?.length)
        lines.push(`🧩 ${o.adGroups.length} ad groups`);
      const names = o.adGroups?.slice(0, 4).map((g) => g.name);
      if (names?.length) lines.push(`Groups: ${names.join(", ")}`);
      return lines;
    }
    case "rsa_copywriter": {
      const o = out as Partial<RSAOutput>;
      const lines: string[] = [];
      if (o.ads?.length) lines.push(`✍️ Ads for ${o.ads.length} groups`);
      const first = o.ads?.[0]?.headlines?.slice(0, 2).map((h) => h.text);
      if (first?.length) lines.push(`Example: "${first.join(" · ")}"`);
      return lines;
    }
    case "policy_qa": {
      const o = out as { verdict?: string; issues?: unknown[] };
      const lines: string[] = [];
      const verdictMap: Record<string, string> = {
        pass: "✅ All good, ready to publish",
        fix: "⚠️ Small tweaks recommended",
        block: "⛔ Something needs fixing before publishing",
      };
      if (o.verdict) lines.push(verdictMap[o.verdict] ?? `Result: ${o.verdict}`);
      if (o.issues?.length) lines.push(`${o.issues.length} things checked`);
      return lines;
    }
    case "activator": {
      const o = out as { status?: string; keywordsAdded?: number; adsCreated?: number };
      const lines: string[] = [];
      if (o.status) {
        const statusMap: Record<string, string> = {
          PAUSED: "Paused (ready, not spending yet)",
          ENABLED: "Active (can now show)",
          REMOVED: "Removed",
        };
        lines.push(`Status: ${statusMap[o.status] ?? o.status}`);
      }
      if (o.adsCreated != null) lines.push(`📢 ${o.adsCreated} ads created`);
      if (o.keywordsAdded != null)
        lines.push(`🔑 ${o.keywordsAdded} keywords added`);
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
