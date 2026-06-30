"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

// ----------------------------------------------------------------------------
// Types (mirror the admin API responses)
// ----------------------------------------------------------------------------

interface ORModel {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  created: number | null;
  supportsTools: boolean;
  description: string | null;
}

// Shape returned by POST /api/admin/model-bench (one entry per model).
interface BenchResult {
  model: string;
  ok: boolean;
  status: number;
  ms: number;
  finishReason: string | null;
  truncated: boolean;
  chars: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  output: string;
  error: string | null;
}

interface BenchResp {
  maxTokens: number;
  task: string;
  ranAt: string;
  results: BenchResult[];
}

interface SettingsResp {
  provider: "anthropic" | "openrouter";
  defaultModel: string | null;
  perAgent: Record<string, string>;
  openrouterKeySet: boolean;
  openrouterKeyFromEnv: boolean;
}

// Default head-to-head line-up. These exact ids start checked even if a given
// one isn't in the live catalogue — the bench endpoint accepts raw model ids.
const DEFAULT_IDS = [
  "qwen/qwen3.7-plus",
  "qwen/qwen3.6-plus",
  "deepseek/deepseek-v3.2",
  "qwen/qwen3-235b-a22b-2507",
  "google/gemini-2.5-pro",
];

const MAX_SELECT = 10;

// ----------------------------------------------------------------------------
// Styles (match the app's dark theme — same objects as admin-model-settings)
// ----------------------------------------------------------------------------

const card: React.CSSProperties = {
  padding: 20,
  borderRadius: 12,
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  marginBottom: 16,
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "#FAFAFA",
  fontSize: 14,
};

const th: React.CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  opacity: 0.5,
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  fontSize: 13,
  padding: "10px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  verticalAlign: "top",
};

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

function priceShort(m: ORModel): string {
  if (m.promptPrice === 0 && m.completionPrice === 0) return "free";
  if (m.promptPrice == null || m.completionPrice == null) return "";
  const inM = (m.promptPrice * 1_000_000).toFixed(2);
  const outM = (m.completionPrice * 1_000_000).toFixed(2);
  return `$${inM}/$${outM} per 1M`;
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(c: number | null): string {
  return c == null ? "—" : `$${c.toFixed(4)}`;
}

function badge(color: string): React.CSSProperties {
  return {
    fontSize: 10,
    color,
    border: `1px solid ${color}33`,
    borderRadius: 999,
    padding: "1px 7px",
    display: "inline-block",
  };
}

// best-first ordering: complete < truncated < failed, then faster first.
function rankTier(r: BenchResult): number {
  if (!r.ok) return 3;
  if (r.truncated) return 2;
  return 1;
}

// ----------------------------------------------------------------------------
// Status cell — ✅ complete / ⚠️ truncated / ❌ failed + badges.
// ----------------------------------------------------------------------------

function StatusCell({ r }: { r: BenchResult }) {
  if (!r.ok) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ color: "#F87171", fontWeight: 600 }}>❌ failed</span>
        {r.error && (
          <span
            style={{
              ...badge("#F87171"),
              whiteSpace: "normal",
              maxWidth: 280,
            }}
          >
            {r.error}
          </span>
        )}
      </div>
    );
  }
  if (r.truncated) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ color: "#FBBF24", fontWeight: 600 }}>⚠️ truncated</span>
        <span style={badge("#FBBF24")}>truncated (reasoned too much)</span>
      </div>
    );
  }
  return <span style={{ color: "#4ADE80", fontWeight: 600 }}>✅ complete</span>;
}

// ----------------------------------------------------------------------------
// Add-a-model picker (search box + native select) — same pattern as the
// settings panel, but it ADDS the chosen model to the comparison line-up.
// ----------------------------------------------------------------------------

function AddModel({
  models,
  exclude,
  disabled,
  onAdd,
}: {
  models: ORModel[];
  exclude: Set<string>;
  disabled: boolean;
  onAdd: (id: string) => void;
}) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    let list = models.filter((m) => !exclude.has(m.id));
    if (t) {
      list = list.filter(
        (m) => m.id.toLowerCase().includes(t) || m.name.toLowerCase().includes(t)
      );
    }
    return list.slice(0, 300);
  }, [q, models, exclude]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <input
        style={inputStyle}
        placeholder="Search a model to add (e.g. gemini, kimi, glm)…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        disabled={disabled}
      />
      <select
        style={inputStyle}
        value=""
        disabled={disabled}
        onChange={(e) => {
          const id = e.target.value;
          if (id) {
            onAdd(id);
            setQ("");
          }
        }}
      >
        <option value="">
          {disabled
            ? `Max ${MAX_SELECT} models selected`
            : "+ Add a model to compare…"}
        </option>
        {filtered.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.supportsTools ? " 🔧" : ""}
            {priceShort(m) ? ` · ${priceShort(m)}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Main panel
// ----------------------------------------------------------------------------

export function AdminModelLab() {
  const [models, setModels] = useState<ORModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Candidate line-up (rows shown as checkboxes) + the currently-checked set.
  const [candidates, setCandidates] = useState<string[]>(DEFAULT_IDS);
  const [selected, setSelected] = useState<Set<string>>(new Set(DEFAULT_IDS));

  const [running, setRunning] = useState(false);
  const [benchError, setBenchError] = useState<string | null>(null);
  const [bench, setBench] = useState<BenchResp | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Per-row "set as default" status.
  const [defaultStatus, setDefaultStatus] = useState<
    Record<string, { saving?: boolean; done?: boolean; error?: string }>
  >({});

  // Track in-flight requests so we can cancel on unmount / refetch.
  const modelsAbort = useRef<AbortController | null>(null);
  const benchAbort = useRef<AbortController | null>(null);
  const settingsAbort = useRef<AbortController | null>(null);

  // ---- load models ---------------------------------------------------------
  const loadModels = useCallback(async () => {
    modelsAbort.current?.abort();
    const ac = new AbortController();
    modelsAbort.current = ac;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const res = await fetch("/api/admin/models", { signal: ac.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      // Drop OpenRouter's auto-"latest" alias models (ids prefixed with "~") —
      // they're unstable pointers and can silently break a run.
      setModels(
        ((data.models ?? []) as ORModel[]).filter((m) => !m.id.startsWith("~"))
      );
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setModelsError(
        e instanceof Error ? e.message : "Could not load the model list"
      );
    } finally {
      if (modelsAbort.current === ac) setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
    // Cancel everything on unmount.
    return () => {
      modelsAbort.current?.abort();
      benchAbort.current?.abort();
      settingsAbort.current?.abort();
    };
  }, [loadModels]);

  // ---- model id → catalogue entry -----------------------------------------
  const byId = useMemo(() => {
    const m = new Map<string, ORModel>();
    for (const x of models) m.set(x.id, x);
    return m;
  }, [models]);

  // ---- selection -----------------------------------------------------------
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= MAX_SELECT) return prev; // cap
        next.add(id);
      }
      return next;
    });
  }, []);

  const addCandidate = useCallback((id: string) => {
    setCandidates((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setSelected((prev) => {
      if (prev.has(id) || prev.size >= MAX_SELECT) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ---- run the comparison --------------------------------------------------
  const runComparison = useCallback(async () => {
    benchAbort.current?.abort();
    const ac = new AbortController();
    benchAbort.current = ac;
    setRunning(true);
    setBenchError(null);
    try {
      const res = await fetch("/api/admin/model-bench", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ models: Array.from(selected) }),
        credentials: "same-origin",
        signal: ac.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setBench(data as BenchResp);
      setExpanded(new Set());
      setDefaultStatus({});
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setBenchError(
        e instanceof Error ? e.message : "Could not run the comparison"
      );
    } finally {
      if (benchAbort.current === ac) setRunning(false);
    }
  }, [selected]);

  // ---- set a model as the default (without clobbering per-agent overrides) -
  const setAsDefault = useCallback(async (id: string) => {
    settingsAbort.current?.abort();
    const ac = new AbortController();
    settingsAbort.current = ac;
    setDefaultStatus((p) => ({ ...p, [id]: { saving: true } }));
    try {
      // 1) Read current settings so we can preserve the per-agent overrides.
      const getRes = await fetch("/api/admin/settings", {
        credentials: "same-origin",
        signal: ac.signal,
      });
      const cur = await getRes.json();
      if (!getRes.ok) throw new Error(cur?.error ?? `Error ${getRes.status}`);
      const perAgent = (cur as SettingsResp).perAgent ?? {};

      // 2) Write the new default model back, keeping perAgent intact.
      const postRes = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "openrouter",
          defaultModel: id,
          perAgent,
        }),
        credentials: "same-origin",
        signal: ac.signal,
      });
      const data = await postRes.json();
      if (!postRes.ok) throw new Error(data?.error ?? `Error ${postRes.status}`);
      setDefaultStatus((p) => ({ ...p, [id]: { done: true } }));
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        // This row's request was superseded by another "Set as default" click
        // (shared abort ref). Clear its stuck "Saving…" flag so the button resets.
        setDefaultStatus((p) => {
          if (!p[id]?.saving) return p;
          const next = { ...p };
          delete next[id];
          return next;
        });
        return;
      }
      setDefaultStatus((p) => ({
        ...p,
        [id]: { error: e instanceof Error ? e.message : "Could not set default" },
      }));
    }
  }, []);

  // ---- sorted results (best-first) ----------------------------------------
  const sorted = useMemo(() => {
    if (!bench) return null;
    return [...bench.results].sort((a, b) => {
      const ta = rankTier(a);
      const tb = rankTier(b);
      if (ta !== tb) return ta - tb;
      return a.ms - b.ms; // faster first
    });
  }, [bench]);

  const atCap = selected.size >= MAX_SELECT;

  return (
    <div style={card}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
        🧪 Model Lab — compare models head-to-head
      </h2>
      <p style={{ opacity: 0.5, fontSize: 13, marginBottom: 16 }}>
        Run the same real report task across models and see latency, truncation,
        quality and cost side by side.
      </p>

      {modelsError && (
        <div
          style={{
            ...card,
            background: "rgba(248,113,113,0.1)",
            border: "1px solid rgba(248,113,113,0.2)",
            color: "#F87171",
          }}
        >
          {modelsError}{" "}
          <button
            onClick={loadModels}
            style={{ textDecoration: "underline", cursor: "pointer" }}
          >
            retry
          </button>
        </div>
      )}

      {/* PICK MODELS --------------------------------------------------------- */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>Models to compare</span>
          <span style={{ fontSize: 12, opacity: 0.5 }}>
            {selected.size} selected · max {MAX_SELECT}
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 8,
            marginBottom: 12,
          }}
        >
          {candidates.map((id) => {
            const m = byId.get(id);
            const checked = selected.has(id);
            const capped = !checked && atCap;
            return (
              <label
                key={id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: checked
                    ? "rgba(99,102,241,0.12)"
                    : "rgba(255,255,255,0.03)",
                  border: `1px solid ${
                    checked ? "#6366F1" : "rgba(255,255,255,0.08)"
                  }`,
                  cursor: capped ? "default" : "pointer",
                  opacity: capped ? 0.45 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={capped}
                  onChange={() => toggleSelect(id)}
                />
                <div style={{ display: "grid", minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m ? m.name : id}
                    {m?.supportsTools ? " 🔧" : ""}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      opacity: 0.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {id}
                    {m && priceShort(m) ? ` · ${priceShort(m)}` : ""}
                    {!m ? " · custom id (not in live list)" : ""}
                  </span>
                </div>
              </label>
            );
          })}
        </div>

        <AddModel
          models={models}
          exclude={new Set(candidates)}
          disabled={atCap || modelsLoading}
          onAdd={addCandidate}
        />
        {modelsLoading && (
          <div style={{ opacity: 0.5, fontSize: 12, marginTop: 6 }}>
            Loading OpenRouter models…
          </div>
        )}
      </div>

      {/* RUN ----------------------------------------------------------------- */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button
          onClick={runComparison}
          disabled={running || selected.size === 0}
          style={{
            padding: "12px 28px",
            borderRadius: 10,
            background:
              running || selected.size === 0
                ? "rgba(99,102,241,0.5)"
                : "#6366F1",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            cursor: running || selected.size === 0 ? "default" : "pointer",
            border: "none",
          }}
        >
          {running ? "Running… (up to ~60s)" : "Run comparison"}
        </button>
        {running && (
          <span style={{ fontSize: 13, opacity: 0.6 }}>
            Querying {selected.size} model{selected.size === 1 ? "" : "s"} in
            parallel…
          </span>
        )}
      </div>

      {benchError && (
        <div
          style={{
            ...card,
            marginTop: 16,
            marginBottom: 0,
            background: "rgba(248,113,113,0.1)",
            border: "1px solid rgba(248,113,113,0.2)",
            color: "#F87171",
          }}
        >
          {benchError}
        </div>
      )}

      {/* RESULTS ------------------------------------------------------------- */}
      {sorted && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, opacity: 0.45, marginBottom: 8 }}>
            {bench
              ? `Task: ${bench.task} · ${bench.maxTokens} max tokens · ran ${new Date(
                  bench.ranAt
                ).toLocaleString()} · sorted best-first`
              : ""}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Model</th>
                  <th style={th}>Time</th>
                  <th style={th}>Status</th>
                  <th style={th}>Quality (chars)</th>
                  <th style={th}>Out tokens</th>
                  <th style={th}>Cost</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const m = byId.get(r.model);
                  const isOpen = expanded.has(r.model);
                  const ds = defaultStatus[r.model];
                  return (
                    <Fragment key={r.model}>
                      <tr
                        onClick={() => toggleExpand(r.model)}
                        style={{ cursor: "pointer" }}
                      >
                        <td style={td}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <span style={{ opacity: 0.5 }}>
                              {isOpen ? "▾" : "▸"}
                            </span>
                            <div style={{ display: "grid", minWidth: 0 }}>
                              <span
                                style={{ fontWeight: 600 }}
                                title={r.model}
                              >
                                {m ? m.name : r.model}
                              </span>
                              <span
                                style={{ fontSize: 11, opacity: 0.45 }}
                                title={r.model}
                              >
                                {r.model}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td style={td}>{fmtSeconds(r.ms)}</td>
                        <td style={td}>
                          <StatusCell r={r} />
                        </td>
                        <td style={td}>{r.chars.toLocaleString()}</td>
                        <td style={td}>{r.tokensOut.toLocaleString()}</td>
                        <td style={td}>{fmtCost(r.costUsd)}</td>
                        <td style={td}>
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                              alignItems: "flex-start",
                            }}
                          >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setAsDefault(r.model);
                              }}
                              disabled={ds?.saving}
                              style={{
                                padding: "6px 12px",
                                borderRadius: 8,
                                background: "rgba(255,255,255,0.04)",
                                border: "1px solid rgba(255,255,255,0.12)",
                                color: "#FAFAFA",
                                fontSize: 12,
                                fontWeight: 600,
                                cursor: ds?.saving ? "default" : "pointer",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {ds?.saving ? "Saving…" : "Set as default"}
                            </button>
                            {ds?.done && (
                              <span style={{ color: "#4ADE80", fontSize: 11 }}>
                                ✓ set as default
                              </span>
                            )}
                            {ds?.error && (
                              <span
                                style={{
                                  color: "#F87171",
                                  fontSize: 11,
                                  whiteSpace: "normal",
                                  maxWidth: 160,
                                }}
                              >
                                {ds.error}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td
                            colSpan={7}
                            style={{
                              ...td,
                              background: "rgba(0,0,0,0.25)",
                            }}
                          >
                            {r.output ? (
                              <pre
                                style={{
                                  margin: 0,
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                                  fontSize: 12,
                                  lineHeight: 1.5,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  maxHeight: 420,
                                  overflowY: "auto",
                                  color: "#E5E7EB",
                                }}
                              >
                                {r.output}
                              </pre>
                            ) : (
                              <span style={{ opacity: 0.5, fontSize: 12 }}>
                                {r.error
                                  ? `No output — ${r.error}`
                                  : "No output."}
                              </span>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
