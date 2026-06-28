"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";
import type {
  BenchmarkReport,
  BenchmarkCompetitor,
  KeywordGap,
  BenchmarkKeyword,
  CompetitorAd,
} from "@/lib/benchmark/types";

// ----------------------------------------------------------------------------
// Props (from the server page)
// ----------------------------------------------------------------------------
interface Props {
  brandId: string;
  brandName: string;
  brandWebsite: string | null;
  knownCompetitors: string[];
}

type EntryMode = "auto" | "keyword" | "domain";

interface RunListItem {
  id: string;
  status: string;
  entryMode: string;
  stage: string | null;
  progress: number;
  liveEnabled: boolean;
  error: string | null;
  createdAt: string | null;
  finishedAt: string | null;
}

// Display currency symbol (account currency; display only, Google bills in its own).
const CUR = "€";

// ----------------------------------------------------------------------------
// Formatters
// ----------------------------------------------------------------------------
function fmtVol(n: number): string {
  if (!n) return "0";
  return n.toLocaleString("en-US");
}
function fmtCpc(low?: number, high?: number): string | null {
  const l = low != null ? low / 1_000_000 : null;
  const h = high != null ? high / 1_000_000 : null;
  if (l == null && h == null) return null;
  if (l != null && h != null)
    return `${CUR}${l.toFixed(2)}–${CUR}${h.toFixed(2)}`;
  const v = (l ?? h) as number;
  return `${CUR}${v.toFixed(2)}`;
}
function compStyle(comp: string): { label: string; color: string; bg: string } {
  const c = (comp || "").toUpperCase();
  if (c === "LOW") return { label: "Low", color: "#4ADE80", bg: "rgba(74,222,128,0.12)" };
  if (c === "MEDIUM") return { label: "Medium", color: "#FBBF24", bg: "rgba(251,191,36,0.12)" };
  if (c === "HIGH") return { label: "High", color: "#F87171", bg: "rgba(248,113,113,0.12)" };
  return { label: "—", color: "rgba(255,255,255,0.4)", bg: "rgba(255,255,255,0.05)" };
}
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

// ============================================================================
// Suite
// ============================================================================
export function BenchmarkSuite({
  brandId,
  brandName,
  brandWebsite,
  knownCompetitors,
}: Props) {
  const { colors } = useTheme();

  // ---- entry control --------------------------------------------------------
  const [entryMode, setEntryMode] = useState<EntryMode>("auto");
  const [manualKeyword, setManualKeyword] = useState("");
  const [manualDomain, setManualDomain] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- live run state -------------------------------------------------------
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [stage, setStage] = useState<string>("");
  const [progress, setProgress] = useState(0);
  const [liveCompetitors, setLiveCompetitors] = useState<BenchmarkCompetitor[]>([]);
  const [report, setReport] = useState<BenchmarkReport | null>(null);

  // ---- history --------------------------------------------------------------
  const [pastRuns, setPastRuns] = useState<RunListItem[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const startAbort = useRef<AbortController | null>(null);
  const reportAbort = useRef<AbortController | null>(null);
  const runsAbort = useRef<AbortController | null>(null);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  // ---- load history ---------------------------------------------------------
  const loadRuns = useCallback(async () => {
    runsAbort.current?.abort();
    const ac = new AbortController();
    runsAbort.current = ac;
    try {
      const res = await fetch(`/api/benchmark/runs?brandId=${brandId}`, {
        signal: ac.signal,
      });
      if (!res.ok) return;
      const data = (await res.json()) as { runs: RunListItem[] };
      setPastRuns(data.runs ?? []);
    } catch {
      /* non-fatal */
    }
  }, [brandId]);

  // ---- fetch the finished report -------------------------------------------
  const fetchReport = useCallback(async (id: string) => {
    reportAbort.current?.abort();
    const ac = new AbortController();
    reportAbort.current = ac;
    try {
      const res = await fetch(`/api/benchmark/runs/${id}`, { signal: ac.signal });
      if (!res.ok) return;
      const data = (await res.json()) as {
        run: { status: string; result: BenchmarkReport | null; error: string | null };
      };
      setStatus(data.run.status);
      if (data.run.result) setReport(data.run.result);
      if (data.run.status === "failed" && data.run.error) setError(data.run.error);
    } catch {
      /* non-fatal */
    }
  }, []);

  // ---- open the SSE stream for a run ---------------------------------------
  const openStream = useCallback(
    (id: string) => {
      closeStream();
      const es = new EventSource(`/api/benchmark/runs/${id}/stream`);
      esRef.current = es;
      es.onmessage = (ev) => {
        let msg: { type: string; data?: unknown; status?: string };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "stage") {
          const d = (msg.data ?? {}) as { stage?: string; progress?: number };
          if (typeof d.stage === "string") setStage(d.stage);
          if (typeof d.progress === "number") setProgress(d.progress);
        } else if (msg.type === "partial") {
          const d = (msg.data ?? {}) as {
            kind?: string;
            competitor?: BenchmarkCompetitor;
          };
          if (d.kind === "competitor" && d.competitor) {
            const c = d.competitor;
            setLiveCompetitors((prev) =>
              prev.some((p) => p.domain === c.domain) ? prev : [...prev, c]
            );
          }
        } else if (msg.type === "error") {
          const d = (msg.data ?? {}) as { message?: string };
          setError(d.message ?? "The analysis failed.");
          setStatus("failed");
          closeStream();
        } else if (msg.type === "done" || msg.type === "run_status") {
          const st = msg.status ?? (msg.data as { status?: string })?.status;
          closeStream();
          setProgress(100);
          if (st === "failed") setStatus("failed");
          fetchReport(id);
          loadRuns();
        }
      };
      es.onerror = () => {
        // Connection dropped (or closed by the server at terminal). Reconcile
        // by fetching the run's final state directly.
        closeStream();
        fetchReport(id);
      };
    },
    [closeStream, fetchReport, loadRuns]
  );

  // ---- start a run ----------------------------------------------------------
  const start = useCallback(async () => {
    startAbort.current?.abort();
    const ac = new AbortController();
    startAbort.current = ac;
    setStarting(true);
    setError(null);
    setReport(null);
    setLiveCompetitors([]);
    setStage("Starting…");
    setProgress(0);
    setStatus("running");
    try {
      const res = await fetch(`/api/benchmark/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        signal: ac.signal,
        body: JSON.stringify({
          brandId,
          entryMode,
          manualKeyword: entryMode === "keyword" ? manualKeyword.trim() : undefined,
          manualDomain: entryMode === "domain" ? manualDomain.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setRunId(data.runId);
      openStream(data.runId);
      loadRuns();
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Could not start the analysis.");
      setStatus(null);
    } finally {
      if (startAbort.current === ac) setStarting(false);
    }
  }, [brandId, entryMode, manualKeyword, manualDomain, openStream, loadRuns]);

  // ---- open a past run ------------------------------------------------------
  const openPastRun = useCallback(
    (run: RunListItem) => {
      setRunId(run.id);
      setError(null);
      setReport(null);
      setLiveCompetitors([]);
      setStatus(run.status);
      setStage(run.stage ?? "");
      setProgress(run.progress);
      if (run.status === "completed" || run.status === "failed") {
        fetchReport(run.id);
      } else {
        openStream(run.id);
      }
    },
    [fetchReport, openStream]
  );

  // ---- lifecycle ------------------------------------------------------------
  useEffect(() => {
    loadRuns();
    return () => {
      closeStream();
      startAbort.current?.abort();
      reportAbort.current?.abort();
      runsAbort.current?.abort();
    };
  }, [loadRuns, closeStream]);

  const running = status === "running" || status === "queued";
  const canStart =
    !starting &&
    !running &&
    (entryMode === "auto" ||
      (entryMode === "keyword" && manualKeyword.trim().length > 0) ||
      (entryMode === "domain" && manualDomain.trim().length > 0));

  // ==========================================================================
  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Brands", href: "/brands" },
          { label: brandName || "Brand", href: `/brands/${brandId}/citations` },
          { label: "Competitor benchmark" },
        ]}
        action={
          <a
            href={`/brands/${brandId}/campaigns`}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              border: `1px solid ${colors.border}`,
              color: colors.text,
              fontWeight: 600,
              fontSize: 13,
              textDecoration: "none",
            }}
          >
            ← Campaigns
          </a>
        }
      />

      <main className="max-w-5xl mx-auto px-6 py-8">
        {/* HERO ------------------------------------------------------------ */}
        <div style={{ marginBottom: 24 }}>
          <div
            style={{
              display: "inline-block",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: colors.accent,
              marginBottom: 8,
            }}
          >
            Competitor intelligence
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 6, lineHeight: 1.15 }}>
            Spy on your competitors&apos; Google Ads
          </h1>
          <p style={{ fontSize: 15, color: colors.textMuted, maxWidth: 640 }}>
            We cross real Keyword Planner search volumes with each competitor&apos;s
            landing pages, their marketing stack and tracking, and turn it into a
            clear plan of what to do next. You don&apos;t have to set anything —
            just press start.
          </p>
        </div>

        {/* ENTRY PANEL ----------------------------------------------------- */}
        <EntryPanel
          colors={colors}
          entryMode={entryMode}
          setEntryMode={setEntryMode}
          manualKeyword={manualKeyword}
          setManualKeyword={setManualKeyword}
          manualDomain={manualDomain}
          setManualDomain={setManualDomain}
          knownCompetitors={knownCompetitors}
          brandWebsite={brandWebsite}
          canStart={canStart}
          starting={starting}
          running={running}
          onStart={start}
        />

        {error && (
          <div
            style={{
              marginTop: 16,
              padding: "12px 16px",
              borderRadius: 12,
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.25)",
              color: "#F87171",
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        {/* LIVE PROGRESS --------------------------------------------------- */}
        {running && (
          <ProgressPanel
            colors={colors}
            stage={stage}
            progress={progress}
            liveCompetitors={liveCompetitors}
          />
        )}

        {/* REPORT ---------------------------------------------------------- */}
        {report && status !== "running" && (
          <ReportView colors={colors} report={report} />
        )}

        {/* HISTORY --------------------------------------------------------- */}
        {pastRuns.length > 0 && (
          <HistoryPanel
            colors={colors}
            runs={pastRuns}
            activeId={runId}
            onOpen={openPastRun}
          />
        )}
      </main>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Entry control panel — the user keeps control of the entry point, but "auto"
// is the prominent default (the AI decides). Manual is an explicit opt-in.
// ----------------------------------------------------------------------------
type Colors = ReturnType<typeof useTheme>["colors"];

function EntryPanel({
  colors,
  entryMode,
  setEntryMode,
  manualKeyword,
  setManualKeyword,
  manualDomain,
  setManualDomain,
  knownCompetitors,
  brandWebsite,
  canStart,
  starting,
  running,
  onStart,
}: {
  colors: Colors;
  entryMode: EntryMode;
  setEntryMode: (m: EntryMode) => void;
  manualKeyword: string;
  setManualKeyword: (s: string) => void;
  manualDomain: string;
  setManualDomain: (s: string) => void;
  knownCompetitors: string[];
  brandWebsite: string | null;
  canStart: boolean;
  starting: boolean;
  running: boolean;
  onStart: () => void;
}) {
  const modes: { id: EntryMode; icon: string; title: string; sub: string }[] = [
    { id: "auto", icon: "✨", title: "Automatic", sub: "We pick the competitors and keywords for you" },
    { id: "keyword", icon: "🔑", title: "By a keyword", sub: "Start from a search term you care about" },
    { id: "domain", icon: "🌐", title: "By a competitor", sub: "Point at one specific competitor domain" },
  ];

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 10,
    background: colors.bgInput,
    border: `1px solid ${colors.border}`,
    color: colors.text,
    fontSize: 14,
  };

  return (
    <div
      style={{
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        padding: 22,
      }}
    >
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        {modes.map((m) => {
          const active = entryMode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => setEntryMode(m.id)}
              disabled={running}
              style={{
                textAlign: "left",
                padding: 16,
                borderRadius: 12,
                cursor: running ? "not-allowed" : "pointer",
                background: active ? "rgba(16,185,129,0.1)" : colors.bgInput,
                border: `1.5px solid ${active ? colors.accent : colors.border}`,
                color: colors.text,
              }}
            >
              <div style={{ fontSize: 22, marginBottom: 8 }}>{m.icon}</div>
              <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 3 }}>
                {m.title}
                {m.id === "auto" && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                      color: colors.accent,
                    }}
                  >
                    Recommended
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: colors.textMuted, lineHeight: 1.35 }}>
                {m.sub}
              </div>
            </button>
          );
        })}
      </div>

      {/* manual inputs */}
      {entryMode === "keyword" && (
        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 13, color: colors.textMuted, display: "block", marginBottom: 6 }}>
            Which keyword should we start from?
          </label>
          <input
            style={inputStyle}
            placeholder="e.g. boutique hotel barcelona"
            value={manualKeyword}
            onChange={(e) => setManualKeyword(e.target.value)}
            disabled={running}
          />
        </div>
      )}
      {entryMode === "domain" && (
        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 13, color: colors.textMuted, display: "block", marginBottom: 6 }}>
            Which competitor do you want to inspect?
          </label>
          <input
            style={inputStyle}
            placeholder="e.g. competitor.com"
            value={manualDomain}
            onChange={(e) => setManualDomain(e.target.value)}
            disabled={running}
          />
          {knownCompetitors.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              {knownCompetitors.slice(0, 8).map((c) => (
                <button
                  key={c}
                  onClick={() => setManualDomain(c)}
                  disabled={running}
                  style={{
                    padding: "5px 11px",
                    borderRadius: 999,
                    fontSize: 12,
                    cursor: running ? "not-allowed" : "pointer",
                    background: "transparent",
                    border: `1px solid ${colors.border}`,
                    color: colors.textMuted,
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {entryMode === "auto" && (
        <div style={{ marginTop: 14, fontSize: 13, color: colors.textFaint }}>
          {brandWebsite ? (
            <>
              We&apos;ll analyze <strong style={{ color: colors.textMuted }}>{brandWebsite}</strong>
              {knownCompetitors.length > 0
                ? ` against ${knownCompetitors.length} competitor${knownCompetitors.length === 1 ? "" : "s"} on file.`
                : " and the competitors we can detect."}
            </>
          ) : (
            "We'll detect competitors from your brand profile."
          )}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 20 }}>
        <button
          onClick={onStart}
          disabled={!canStart}
          style={{
            padding: "13px 30px",
            borderRadius: 12,
            background: canStart ? colors.accent : "rgba(16,185,129,0.3)",
            color: canStart ? "#000" : colors.textFaint,
            fontWeight: 800,
            fontSize: 15,
            border: "none",
            cursor: canStart ? "pointer" : "not-allowed",
          }}
        >
          {starting || running ? "Analyzing…" : "Start the analysis"}
        </button>
        <span style={{ fontSize: 12.5, color: colors.textFaint }}>
          Free · uses real Google Keyword Planner data
        </span>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Live progress
// ----------------------------------------------------------------------------
function ProgressPanel({
  colors,
  stage,
  progress,
  liveCompetitors,
}: {
  colors: Colors;
  stage: string;
  progress: number;
  liveCompetitors: BenchmarkCompetitor[];
}) {
  return (
    <div
      style={{
        marginTop: 20,
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        padding: 22,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{stage || "Working…"}</span>
        <span style={{ fontSize: 13, color: colors.textMuted, fontVariantNumeric: "tabular-nums" }}>
          {Math.round(progress)}%
        </span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 999,
          background: colors.bgInput,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.max(4, Math.min(100, progress))}%`,
            background: colors.accent,
            borderRadius: 999,
            transition: "width 0.4s ease",
          }}
        />
      </div>
      {liveCompetitors.length > 0 && (
        <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {liveCompetitors.map((c) => (
            <span
              key={c.domain}
              style={{
                fontSize: 12.5,
                padding: "5px 11px",
                borderRadius: 999,
                background: "rgba(16,185,129,0.1)",
                border: `1px solid ${colors.accent}`,
                color: colors.accent,
                fontWeight: 600,
              }}
            >
              ✓ {c.domain} · {fmtVol(c.totalVolume)} vol
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Report
// ----------------------------------------------------------------------------
function ReportView({ colors, report }: { colors: Colors; report: BenchmarkReport }) {
  const sectionTitle: React.CSSProperties = {
    fontSize: 18,
    fontWeight: 800,
    marginBottom: 14,
    marginTop: 28,
  };
  return (
    <div style={{ marginTop: 24 }}>
      {/* meta strip */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <Stat colors={colors} label="Competitors" value={String(report.meta.domainsAnalyzed)} />
        <Stat colors={colors} label="Keywords found" value={fmtVol(report.meta.keywordsDiscovered)} />
        <Stat colors={colors} label="Gaps" value={String(report.keywordGaps.length)} />
        <Stat colors={colors} label="Market" value={report.country} />
        <Stat
          colors={colors}
          label="Ad-spy"
          value={report.meta.liveAdSpy ? "Live" : "Off"}
        />
      </div>

      {/* strategy */}
      <h2 style={sectionTitle}>🧠 Your strategy</h2>
      <StrategyCard colors={colors} report={report} />

      {/* keyword gaps */}
      <h2 style={sectionTitle}>🎯 Keyword gaps</h2>
      <p style={{ fontSize: 13.5, color: colors.textMuted, marginTop: -8, marginBottom: 14 }}>
        Searches your competitors are associated with that you don&apos;t appear
        to be — sorted by how many of them cover each one.
      </p>
      <KeywordGapTable colors={colors} gaps={report.keywordGaps} />

      {/* competitors */}
      <h2 style={sectionTitle}>🕵️ Competitor teardown</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {report.competitors.map((c) => (
          <CompetitorCard key={c.domain} colors={colors} c={c} />
        ))}
        {report.competitors.length === 0 && (
          <EmptyNote colors={colors}>
            No competitor domains could be analyzed. Add competitor websites to
            your brand profile, or start the analysis pointed at one domain.
          </EmptyNote>
        )}
      </div>

      {/* brand footprint */}
      <h2 style={sectionTitle}>📍 Your own keyword footprint</h2>
      <KeywordChips colors={colors} keywords={report.brandKeywords.slice(0, 30)} />

      <div style={{ marginTop: 24, fontSize: 12, color: colors.textFaint }}>
        Generated {fmtDate(report.generatedAt)} · content in{" "}
        {report.language.toUpperCase()}
      </div>
    </div>
  );
}

function Stat({ colors, label, value }: { colors: Colors; label: string; value: string }) {
  return (
    <div
      style={{
        flex: "1 1 120px",
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: "12px 14px",
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </div>
    </div>
  );
}

function StrategyCard({ colors, report }: { colors: Colors; report: BenchmarkReport }) {
  const s = report.strategy;
  const block = (title: string, items: string[], color: string) =>
    items.length > 0 ? (
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color, marginBottom: 8 }}>{title}</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((it, i) => (
            <li key={i} style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              {it}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <div
      style={{
        background: "linear-gradient(180deg, rgba(16,185,129,0.06), rgba(16,185,129,0))",
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        padding: 22,
      }}
    >
      <p style={{ fontSize: 15, lineHeight: 1.6, marginBottom: s.positioning ? 14 : 18 }}>
        {s.summary}
      </p>
      {s.positioning && (
        <p style={{ fontSize: 13.5, lineHeight: 1.6, color: colors.textMuted, marginBottom: 18 }}>
          <strong style={{ color: colors.text }}>Positioning. </strong>
          {s.positioning}
        </p>
      )}
      <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        {block("Opportunities", s.opportunities, "#4ADE80")}
        {block("Threats", s.threats, "#F87171")}
        {block("Keywords to prioritize", s.recommendedKeywords, colors.accent)}
        {block("Angles to test", s.recommendedAngles, "#A5B4FC")}
      </div>
    </div>
  );
}

function KeywordGapTable({ colors, gaps }: { colors: Colors; gaps: KeywordGap[] }) {
  const [showAll, setShowAll] = useState(false);
  if (gaps.length === 0) {
    return (
      <EmptyNote colors={colors}>
        No clear keyword gaps found — you already cover what your competitors do,
        or there wasn&apos;t enough competitor data this run.
      </EmptyNote>
    );
  }
  const shown = showAll ? gaps : gaps.slice(0, 12);
  const cell: React.CSSProperties = { padding: "10px 12px", fontSize: 13.5 };
  const head: React.CSSProperties = {
    ...cell,
    fontSize: 11.5,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: colors.textMuted,
    fontWeight: 700,
    textAlign: "left",
  };
  return (
    <div
      style={{
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              <th style={head}>Keyword</th>
              <th style={{ ...head, textAlign: "right" }}>Searches/mo</th>
              <th style={{ ...head, textAlign: "center" }}>Competition</th>
              <th style={{ ...head, textAlign: "right" }}>Top-of-page CPC</th>
              <th style={{ ...head, textAlign: "center" }}>Covered by</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((g, i) => {
              const cs = compStyle(g.competition);
              const cpc = fmtCpc(g.cpcLowMicros, g.cpcHighMicros);
              return (
                <tr key={g.text + i} style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <td style={{ ...cell, fontWeight: 600 }}>{g.text}</td>
                  <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {fmtVol(g.avgMonthlySearches)}
                  </td>
                  <td style={{ ...cell, textAlign: "center" }}>
                    <span
                      style={{
                        fontSize: 11.5,
                        fontWeight: 600,
                        padding: "3px 9px",
                        borderRadius: 999,
                        color: cs.color,
                        background: cs.bg,
                      }}
                    >
                      {cs.label}
                    </span>
                  </td>
                  <td style={{ ...cell, textAlign: "right", color: colors.textMuted, fontVariantNumeric: "tabular-nums" }}>
                    {cpc ?? "—"}
                  </td>
                  <td style={{ ...cell, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                    {g.competitorsCovering.length}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {gaps.length > 12 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          style={{
            width: "100%",
            padding: "10px",
            background: "transparent",
            border: "none",
            borderTop: `1px solid ${colors.border}`,
            color: colors.accent,
            fontWeight: 600,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {showAll ? "Show less" : `Show all ${gaps.length} gaps`}
        </button>
      )}
    </div>
  );
}

function CompetitorCard({ colors, c }: { colors: Colors; c: BenchmarkCompetitor }) {
  const [open, setOpen] = useState(false);
  const landing = c.landing;
  const tags: string[] = landing?.tracking.pixels ?? [];
  return (
    <div
      style={{
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: 20,
          cursor: "pointer",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <h3 style={{ fontSize: 17, fontWeight: 800 }}>{c.domain}</h3>
            <AdsBadge colors={colors} status={c.adsStatus} count={c.ads?.length ?? 0} />
          </div>
          {landing?.valueProposition ? (
            <p style={{ fontSize: 13.5, color: colors.textMuted, lineHeight: 1.5, maxWidth: 560 }}>
              {landing.valueProposition}
            </p>
          ) : (
            <p style={{ fontSize: 13, color: colors.textFaint }}>
              {landing ? "Landing page read, no clear value prop." : "Landing page couldn't be read."}
            </p>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            {fmtVol(c.totalVolume)}
          </div>
          <div style={{ fontSize: 11, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
            total volume
          </div>
          <div style={{ marginTop: 8, fontSize: 18, color: colors.textFaint }}>
            {open ? "▾" : "▸"}
          </div>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 20px 20px" }}>
          {/* top keywords */}
          {c.keywords.length > 0 && (
            <Detail colors={colors} title="Top keywords">
              <KeywordChips colors={colors} keywords={c.keywords.slice(0, 16)} />
            </Detail>
          )}

          {/* offers / ctas / trust */}
          {landing && (landing.offers.length > 0 || landing.ctas.length > 0 || landing.trustSignals.length > 0) && (
            <Detail colors={colors} title="On their landing page">
              <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
                <MiniList colors={colors} label="Offers" items={landing.offers} />
                <MiniList colors={colors} label="Calls to action" items={landing.ctas} />
                <MiniList colors={colors} label="Trust signals" items={landing.trustSignals} />
              </div>
              {landing.toneNotes && (
                <p style={{ fontSize: 13, color: colors.textMuted, marginTop: 12, lineHeight: 1.5 }}>
                  <strong style={{ color: colors.text }}>Tone. </strong>
                  {landing.toneNotes}
                </p>
              )}
            </Detail>
          )}

          {/* marketing stack */}
          {(tags.length > 0 || (landing?.tracking.utmParams.length ?? 0) > 0) && (
            <Detail colors={colors} title="Marketing & tracking stack">
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: landing?.tracking.utmParams.length ? 10 : 0 }}>
                {tags.map((t) => (
                  <span
                    key={t}
                    style={{
                      fontSize: 12,
                      padding: "4px 10px",
                      borderRadius: 999,
                      background: "rgba(165,180,252,0.1)",
                      border: "1px solid rgba(165,180,252,0.3)",
                      color: "#A5B4FC",
                      fontWeight: 600,
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
              {landing && landing.tracking.utmParams.length > 0 && (
                <div style={{ fontSize: 12.5, color: colors.textMuted }}>
                  <strong style={{ color: colors.text }}>UTM tags seen: </strong>
                  {landing.tracking.utmParams.map((u) => `${u.key}=${u.value}`).join(" · ")}
                </div>
              )}
            </Detail>
          )}

          {/* ad gallery (only present when the paid ad-spy was unlocked) */}
          {c.adsStatus === "ok" && c.ads && c.ads.length > 0 && (
            <Detail colors={colors} title="Running ads">
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                {c.ads.map((ad, i) => (
                  <AdCard key={i} colors={colors} ad={ad} />
                ))}
              </div>
            </Detail>
          )}
          {c.adsStatus === "off" && (
            <div style={{ marginTop: 14, fontSize: 12.5, color: colors.textFaint }}>
              🔒 Live ad-spy is off. An admin can switch it on to also pull this
              competitor&apos;s running ad creatives.
            </div>
          )}

          {/* notes */}
          {c.notes.length > 0 && (
            <div style={{ marginTop: 14, fontSize: 12, color: colors.textFaint }}>
              {c.notes.map((n, i) => (
                <div key={i}>· {n}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AdsBadge({
  colors,
  status,
  count,
}: {
  colors: Colors;
  status: BenchmarkCompetitor["adsStatus"];
  count: number;
}) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    ok: { label: `${count} ads`, color: "#4ADE80", bg: "rgba(74,222,128,0.12)" },
    empty: { label: "No ads found", color: colors.textMuted, bg: "rgba(255,255,255,0.05)" },
    error: { label: "Ad-spy error", color: "#FBBF24", bg: "rgba(251,191,36,0.12)" },
    off: { label: "Ad-spy off", color: colors.textFaint, bg: "rgba(255,255,255,0.04)" },
  };
  const m = map[status] ?? map.off;
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: 999,
        color: m.color,
        background: m.bg,
        whiteSpace: "nowrap",
      }}
    >
      {m.label}
    </span>
  );
}

function AdCard({ colors, ad }: { colors: Colors; ad: CompetitorAd }) {
  return (
    <div
      style={{
        background: colors.bgInput,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: 14,
      }}
    >
      {ad.headline && (
        <div style={{ fontSize: 14, fontWeight: 700, color: "#7DD3FC", marginBottom: 4 }}>
          {ad.headline}
        </div>
      )}
      {ad.body && (
        <div style={{ fontSize: 12.5, color: colors.textMuted, lineHeight: 1.45 }}>{ad.body}</div>
      )}
      {ad.destinationUrl && (
        <div style={{ fontSize: 11.5, color: "#4ADE80", marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {ad.destinationUrl}
        </div>
      )}
      {(ad.firstShown || ad.lastShown) && (
        <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 6 }}>
          {ad.firstShown ?? "?"} → {ad.lastShown ?? "now"}
        </div>
      )}
    </div>
  );
}

function Detail({ colors, title, children }: { colors: Colors; title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: colors.textMuted, marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function MiniList({ colors, label, items }: { colors: Colors; label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: colors.text, marginBottom: 6 }}>{label}</div>
      <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 4 }}>
        {items.slice(0, 6).map((it, i) => (
          <li key={i} style={{ fontSize: 12.5, color: colors.textMuted, lineHeight: 1.4 }}>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function KeywordChips({ colors, keywords }: { colors: Colors; keywords: BenchmarkKeyword[] }) {
  if (keywords.length === 0)
    return <span style={{ fontSize: 13, color: colors.textFaint }}>No keywords found.</span>;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {keywords.map((k, i) => (
        <span
          key={k.text + i}
          title={`${fmtVol(k.avgMonthlySearches)} searches/mo`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 12.5,
            padding: "5px 11px",
            borderRadius: 999,
            background: colors.bgInput,
            border: `1px solid ${colors.border}`,
            color: colors.text,
          }}
        >
          {k.text}
          <span style={{ fontSize: 11, color: colors.textMuted, fontVariantNumeric: "tabular-nums" }}>
            {fmtVol(k.avgMonthlySearches)}
          </span>
        </span>
      ))}
    </div>
  );
}

function EmptyNote({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: colors.bgCard,
        border: `1px dashed ${colors.border}`,
        borderRadius: 14,
        padding: 22,
        fontSize: 13.5,
        color: colors.textMuted,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function HistoryPanel({
  colors,
  runs,
  activeId,
  onOpen,
}: {
  colors: Colors;
  runs: RunListItem[];
  activeId: string | null;
  onOpen: (r: RunListItem) => void;
}) {
  const statusLabel: Record<string, { label: string; color: string }> = {
    completed: { label: "Done", color: "#4ADE80" },
    running: { label: "Running…", color: "#3B82F6" },
    queued: { label: "Queued", color: "#3B82F6" },
    failed: { label: "Failed", color: "#F87171" },
  };
  return (
    <div style={{ marginTop: 36 }}>
      <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 12 }}>Past analyses</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {runs.map((r) => {
          const s = statusLabel[r.status] ?? { label: r.status, color: colors.textMuted };
          const active = r.id === activeId;
          return (
            <button
              key={r.id}
              onClick={() => onOpen(r)}
              style={{
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "12px 16px",
                borderRadius: 12,
                background: active ? "rgba(16,185,129,0.08)" : colors.bgCard,
                border: `1px solid ${active ? colors.accent : colors.border}`,
                color: colors.text,
                cursor: "pointer",
              }}
            >
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {fmtDate(r.createdAt)} · {entryModeLabel(r.entryMode)}
                  {r.liveEnabled && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: "#A5B4FC" }}>· ad-spy</span>
                  )}
                </div>
                {r.status === "failed" && r.error && (
                  <div style={{ fontSize: 12, color: "#F87171", marginTop: 2 }}>{r.error}</div>
                )}
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: s.color, whiteSpace: "nowrap" }}>
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function entryModeLabel(m: string): string {
  if (m === "keyword") return "by keyword";
  if (m === "domain") return "by competitor";
  return "automatic";
}
