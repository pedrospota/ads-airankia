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
  SpendEstimate,
  SpendSummary,
  ForecastProjection,
} from "@/lib/benchmark/types";

// ----------------------------------------------------------------------------
// Props (from the server page)
// ----------------------------------------------------------------------------
interface Props {
  brandId: string;
  brandName: string;
  brandWebsite: string | null;
  knownCompetitors: string[];
  /** True when a SearchApi key is configured → the paid "live ads" toggle works. */
  adSpyAvailable: boolean;
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
// Compact money: 1234 → €1.2K, 45000 → €45K, 1200000 → €1.2M.
function fmtMoney(n: number, cur = CUR): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 1_000_000) return `${cur}${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${cur}${Math.round(v / 1000)}K`;
  if (v >= 1000) return `${cur}${(v / 1000).toFixed(1)}K`;
  return `${cur}${v.toLocaleString("en-US")}`;
}
function fmtCpc(low?: number, high?: number, cur = CUR): string | null {
  const l = low != null ? low / 1_000_000 : null;
  const h = high != null ? high / 1_000_000 : null;
  if (l == null && h == null) return null;
  if (l != null && h != null)
    return `${cur}${l.toFixed(2)}–${cur}${h.toFixed(2)}`;
  const v = (l ?? h) as number;
  return `${cur}${v.toFixed(2)}`;
}
// Whole numbers with thousands separators (impressions, clicks, conversions).
function fmtInt(n: number): string {
  return Math.round(Math.max(0, n)).toLocaleString("en-US");
}
// Fraction → percent (CTR, conversion rate). 0.0432 → "4.3%".
function fmtPct(frac: number): string {
  if (!isFinite(frac) || frac <= 0) return "0%";
  return `${(frac * 100).toFixed(frac < 0.1 ? 1 : 1)}%`;
}
// Micros → exact unit price (CPC, CPA). 1_850_000 → "€1.85".
function fmtPriceMicros(micros: number, cur = CUR): string {
  return `${cur}${(Math.max(0, micros) / 1_000_000).toFixed(2)}`;
}
// Micros → compact money (cost). 4_200_000 → "€4.2K".
function fmtMoneyMicros(micros: number, cur = CUR): string {
  return fmtMoney(Math.max(0, micros) / 1_000_000, cur);
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
  adSpyAvailable,
}: Props) {
  const { colors } = useTheme();

  // ---- entry control --------------------------------------------------------
  const [entryMode, setEntryMode] = useState<EntryMode>("auto");
  const [manualKeyword, setManualKeyword] = useState("");
  const [manualDomain, setManualDomain] = useState("");
  // Per-run opt-in to PAID live competitor-ad spying + keyword-advertiser
  // discovery. OFF by default — a free run never spends.
  const [adSpy, setAdSpy] = useState(false);
  // Optional market/language override. Empty = auto-detect from the brand (the
  // default — the user never has to choose).
  const [marketOverride, setMarketOverride] = useState("");
  const [langOverride, setLangOverride] = useState("");
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
          // Only send the paid opt-in when a key is actually available.
          adSpy: adSpyAvailable ? adSpy : undefined,
          countryCode: marketOverride || undefined,
          languageCode: langOverride || undefined,
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
  }, [
    brandId,
    entryMode,
    manualKeyword,
    manualDomain,
    adSpy,
    adSpyAvailable,
    marketOverride,
    langOverride,
    openStream,
    loadRuns,
  ]);

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
          adSpy={adSpy}
          setAdSpy={setAdSpy}
          adSpyAvailable={adSpyAvailable}
          marketOverride={marketOverride}
          setMarketOverride={setMarketOverride}
          langOverride={langOverride}
          setLangOverride={setLangOverride}
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

// Optional market / language overrides. "" = auto-detect from the brand (default).
const MARKET_OPTIONS: { code: string; label: string }[] = [
  { code: "", label: "Auto-detect (recommended)" },
  { code: "ES", label: "Spain" },
  { code: "MX", label: "Mexico" },
  { code: "AR", label: "Argentina" },
  { code: "CO", label: "Colombia" },
  { code: "CL", label: "Chile" },
  { code: "PE", label: "Peru" },
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "FR", label: "France" },
  { code: "DE", label: "Germany" },
  { code: "IT", label: "Italy" },
  { code: "PT", label: "Portugal" },
];

const LANG_OPTIONS: { code: string; label: string }[] = [
  { code: "", label: "Auto" },
  { code: "es", label: "Spanish" },
  { code: "en", label: "English" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
];

function EntryPanel({
  colors,
  entryMode,
  setEntryMode,
  manualKeyword,
  setManualKeyword,
  manualDomain,
  setManualDomain,
  adSpy,
  setAdSpy,
  adSpyAvailable,
  marketOverride,
  setMarketOverride,
  langOverride,
  setLangOverride,
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
  adSpy: boolean;
  setAdSpy: (b: boolean) => void;
  adSpyAvailable: boolean;
  marketOverride: string;
  setMarketOverride: (s: string) => void;
  langOverride: string;
  setLangOverride: (s: string) => void;
  knownCompetitors: string[];
  brandWebsite: string | null;
  canStart: boolean;
  starting: boolean;
  running: boolean;
  onStart: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
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

      {/* live competitor ads — PAID, per-run opt-in, OFF by default ---------- */}
      {adSpyAvailable && (
        <button
          type="button"
          onClick={() => !running && setAdSpy(!adSpy)}
          disabled={running}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            width: "100%",
            textAlign: "left",
            marginTop: 18,
            padding: 14,
            borderRadius: 12,
            cursor: running ? "not-allowed" : "pointer",
            background: adSpy ? "rgba(16,185,129,0.08)" : colors.bgInput,
            border: `1.5px solid ${adSpy ? colors.accent : colors.border}`,
            color: colors.text,
          }}
        >
          {/* switch */}
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              width: 38,
              height: 22,
              borderRadius: 999,
              background: adSpy ? colors.accent : colors.border,
              position: "relative",
              transition: "background 0.15s",
              marginTop: 1,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: adSpy ? 18 : 2,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: "#fff",
                transition: "left 0.15s",
              }}
            />
          </span>
          <span>
            <span style={{ fontSize: 14, fontWeight: 700, display: "block", marginBottom: 2 }}>
              Spy on live competitor ads{" "}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: colors.textFaint,
                }}
              >
                · paid
              </span>
            </span>
            <span style={{ fontSize: 12.5, color: colors.textMuted, lineHeight: 1.4, display: "block" }}>
              {entryMode === "keyword"
                ? "Pulls the real running ads from the Google Ads Transparency Center, and finds who actually advertises on your keyword (added to your competitor list)."
                : "Pulls the real running ads from the Google Ads Transparency Center for each competitor. Without it, the analysis is fully free."}
            </span>
          </span>
        </button>
      )}

      {/* market & language — auto by default, optional override ------------- */}
      <div style={{ marginTop: 14, fontSize: 12.5, color: colors.textFaint }}>
        You don&apos;t need to choose a country or language — we detect them
        automatically from your brand.{" "}
        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          disabled={running}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: colors.accent,
            cursor: running ? "not-allowed" : "pointer",
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          {showAdvanced ? "Hide options" : "Change them"}
        </button>
      </div>
      {showAdvanced && (
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            marginTop: 10,
          }}
        >
          <div>
            <label style={{ fontSize: 12.5, color: colors.textMuted, display: "block", marginBottom: 6 }}>
              Market
            </label>
            <select
              value={marketOverride}
              onChange={(e) => setMarketOverride(e.target.value)}
              disabled={running}
              style={{ ...inputStyle, cursor: running ? "not-allowed" : "pointer" }}
            >
              {MARKET_OPTIONS.map((o) => (
                <option key={o.code || "auto"} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12.5, color: colors.textMuted, display: "block", marginBottom: 6 }}>
              Language
            </label>
            <select
              value={langOverride}
              onChange={(e) => setLangOverride(e.target.value)}
              disabled={running}
              style={{ ...inputStyle, cursor: running ? "not-allowed" : "pointer" }}
            >
              {LANG_OPTIONS.map((o) => (
                <option key={o.code || "auto"} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
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
          {adSpyAvailable && adSpy
            ? "Includes live ad-spy · billed per competitor search"
            : "Free · uses real Google Keyword Planner data"}
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
              {c.spend ? ` · ~${fmtMoney(c.spend.monthlyMid, c.spend.currency)}/mo` : ""}
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
        {report.spendSummary && (
          <Stat
            colors={colors}
            label="Est. spend/mo"
            value={`~${fmtMoney(report.spendSummary.monthlyMid, report.spendSummary.currency)}`}
          />
        )}
        {report.forecast && report.forecast.clicks > 0 && (
          <Stat
            colors={colors}
            label="Proj. clicks/mo"
            value={`~${fmtInt(report.forecast.clicks)}`}
          />
        )}
        <Stat colors={colors} label="Market" value={report.country} />
        <Stat
          colors={colors}
          label="Ad-spy"
          value={report.meta.liveAdSpy ? "Live" : "Off"}
        />
      </div>

      {/* honest data-availability banner — why the numbers are / aren't here */}
      <DataAvailabilityBanner colors={colors} report={report} />

      {/* ===== Deterministic numbers first (the hero of the report) ===== */}

      {/* keyword gaps */}
      <h2 style={sectionTitle}>🎯 Keyword gaps</h2>
      <p style={{ fontSize: 13.5, color: colors.textMuted, marginTop: -8, marginBottom: 14 }}>
        Searches your competitors are associated with that you don&apos;t appear
        to be — sorted by how many of them cover each one.
      </p>
      <KeywordGapTable colors={colors} gaps={report.keywordGaps} cur={report.currency} />

      {/* projected results for the recommended plan */}
      {report.forecast && (
        <>
          <h2 style={sectionTitle}>📈 What the recommended plan could get you</h2>
          <p style={{ fontSize: 13.5, color: colors.textMuted, marginTop: -8, marginBottom: 14 }}>
            Google&apos;s own forecast if you ran the recommended keywords for a
            month — real numbers, not just advice.
          </p>
          <ForecastCard colors={colors} forecast={report.forecast} />
        </>
      )}

      {/* brand footprint */}
      <h2 style={sectionTitle}>📍 Your own keyword footprint</h2>
      <KeywordChips colors={colors} keywords={report.brandKeywords.slice(0, 30)} />

      {/* estimated investment */}
      {report.spendSummary && (
        <>
          <h2 style={sectionTitle}>💰 Estimated competitor investment</h2>
          <SpendPanel
            colors={colors}
            summary={report.spendSummary}
            competitors={report.competitors}
          />
        </>
      )}

      {/* competitors (qualitative facts) */}
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

      {/* ===== AI synthesis LAST — layered on top of the numbers above ===== */}
      <h2 style={sectionTitle}>🧠 AI strategy</h2>
      <p style={{ fontSize: 13.5, color: colors.textMuted, marginTop: -8, marginBottom: 14 }}>
        A synthesis of the numbers and teardowns above — the &quot;so what, do
        this&quot; layer, in your brand&apos;s language.
      </p>
      <StrategyCard colors={colors} report={report} />

      <div style={{ marginTop: 24, fontSize: 12, color: colors.textFaint }}>
        Generated {fmtDate(report.generatedAt)} · content in{" "}
        {report.language.toUpperCase()}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Honest data-availability banner — instead of silently showing zeros when the
// Keyword Planner can't be queried, we say exactly why the numbers are missing
// and what still IS real in the report. Only renders when data isn't fully "ok".
// ----------------------------------------------------------------------------
function DataAvailabilityBanner({ colors, report }: { colors: Colors; report: BenchmarkReport }) {
  const kd = report.meta.keywordData;
  // Older reports (pre-field) and fully-OK runs show no banner.
  if (!kd || kd.status === "ok") return null;

  const AMBER = "#FBBF24";
  const amberBg = "rgba(251,191,36,0.10)";
  const amberBorder = "rgba(251,191,36,0.30)";

  type Tone = { icon: string; color: string; bg: string; border: string; title: string; body: string };
  const tones: Record<typeof kd.status, Tone> = {
    no_access: {
      icon: "🔌",
      color: AMBER,
      bg: amberBg,
      border: amberBorder,
      title: "Real keyword numbers aren't connected yet",
      body:
        "Google's Keyword Planner needs Basic API access to return search volumes, CPC and the traffic forecast — the current token only has Test access, so those figures are empty below. Everything that doesn't depend on it (the competitor teardowns) is fully real. The moment Basic access (or the dedicated planner credential) is connected, this report fills with real numbers automatically — no re-setup needed.",
    },
    quota: {
      icon: "⏳",
      color: AMBER,
      bg: amberBg,
      border: amberBorder,
      title: "Daily Google Ads quota reached",
      body:
        "Google's free Keyword Planner quota for today is used up, so the search volumes and forecast below are empty. Re-run this benchmark tomorrow and the real numbers will populate.",
    },
    no_data: {
      icon: "🔍",
      color: colors.textMuted,
      bg: "rgba(255,255,255,0.04)",
      border: colors.border,
      title: "No Keyword Planner data for these seeds",
      body:
        "Google's Keyword Planner answered but had nothing for this brand/competitor and market. Try a broader seed keyword, a different competitor domain, or a larger market — the competitor teardowns below are still real.",
    },
    partial: {
      icon: "⚠️",
      color: AMBER,
      bg: amberBg,
      border: amberBorder,
      title: "Some keyword data is incomplete",
      body:
        "Most numbers came back, but at least one Keyword Planner call didn't — a few figures below may be missing or under-counted.",
    },
    error: {
      icon: "⚠️",
      color: AMBER,
      bg: amberBg,
      border: amberBorder,
      title: "Keyword data couldn't be loaded",
      body:
        "Something went wrong fetching the Keyword Planner numbers, so the volumes and forecast below are empty. The competitor teardowns are still real — re-run to try again.",
    },
  };

  const tone = tones[kd.status];

  return (
    <div
      style={{
        marginTop: 14,
        marginBottom: 4,
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div style={{ fontSize: 20, lineHeight: 1, flexShrink: 0 }}>{tone.icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: tone.color, marginBottom: 4 }}>
          {tone.title}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: colors.textMuted }}>{tone.body}</div>
        {kd.message && kd.status !== "no_data" && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11.5,
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              color: colors.textFaint,
              wordBreak: "break-word",
            }}
          >
            {kd.message}
          </div>
        )}
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

// ----------------------------------------------------------------------------
// Estimated investment — the headline range + a who-outspends-whom comparison.
// Framed honestly: nobody can see real competitor spend; this is modeled.
// ----------------------------------------------------------------------------
function SpendPanel({
  colors,
  summary,
  competitors,
}: {
  colors: Colors;
  summary: SpendSummary;
  competitors: BenchmarkCompetitor[];
}) {
  const [how, setHow] = useState(false);
  const cur = summary.currency;

  // Competitors with an estimate, biggest spenders first.
  const ranked = competitors
    .filter((c): c is BenchmarkCompetitor & { spend: SpendEstimate } => !!c.spend)
    .sort((a, b) => b.spend.monthlyMid - a.spend.monthlyMid);
  const maxMid = Math.max(1, ...ranked.map((c) => c.spend.monthlyMid));

  const confLabel =
    summary.confidence === "medium"
      ? { text: "Modeled + ad-spy", color: "#4ADE80", bg: "rgba(74,222,128,0.12)" }
      : { text: "Directional estimate", color: "#FBBF24", bg: "rgba(251,191,36,0.12)" };

  return (
    <div
      style={{
        background: "linear-gradient(180deg, rgba(251,191,36,0.05), rgba(251,191,36,0))",
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        padding: 22,
      }}
    >
      {/* headline range */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 12.5, color: colors.textMuted, marginBottom: 4 }}>
            Your competitors are investing an estimated
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>
            {fmtMoney(summary.monthlyLow, cur)}
            <span style={{ color: colors.textFaint, fontWeight: 600 }}> – </span>
            {fmtMoney(summary.monthlyHigh, cur)}
            <span style={{ fontSize: 15, fontWeight: 600, color: colors.textMuted }}> /mo</span>
          </div>
          <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 4 }}>
            combined, across {summary.competitorsEstimated} competitor
            {summary.competitorsEstimated === 1 ? "" : "s"} on Google Search
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: "5px 11px",
            borderRadius: 999,
            color: confLabel.color,
            background: confLabel.bg,
            whiteSpace: "nowrap",
          }}
        >
          {confLabel.text}
        </span>
      </div>

      {/* per-competitor comparison bars */}
      {ranked.length > 0 && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {ranked.map((c) => {
            const pct = Math.max(4, Math.round((c.spend.monthlyMid / maxMid) * 100));
            return (
              <div key={c.domain}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    marginBottom: 5,
                    gap: 10,
                  }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.domain}
                  </span>
                  <span style={{ fontSize: 12.5, color: colors.textMuted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                    ~{fmtMoney(c.spend.monthlyMid, cur)}/mo
                    <span style={{ color: colors.textFaint }}>
                      {" "}({fmtMoney(c.spend.monthlyLow, cur)}–{fmtMoney(c.spend.monthlyHigh, cur)})
                    </span>
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 999, background: colors.bgInput, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${pct}%`,
                      borderRadius: 999,
                      background:
                        c.spend.confidence === "medium"
                          ? "linear-gradient(90deg, #4ADE80, #10B981)"
                          : "linear-gradient(90deg, #FBBF24, #F59E0B)",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* honest methodology disclosure */}
      <button
        onClick={() => setHow((h) => !h)}
        style={{
          marginTop: 18,
          background: "transparent",
          border: "none",
          padding: 0,
          color: colors.accent,
          fontWeight: 600,
          fontSize: 12.5,
          cursor: "pointer",
        }}
      >
        {how ? "Hide how this is calculated" : "ℹ️ How is this estimated?"}
      </button>
      {how && (
        <div
          style={{
            marginTop: 10,
            fontSize: 12.5,
            color: colors.textMuted,
            lineHeight: 1.55,
            background: colors.bgInput,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 14,
          }}
        >
          Nobody can see a competitor&apos;s real Google Ads budget — it&apos;s
          private. Like SEMrush, SpyFu and Similarweb, we <strong style={{ color: colors.text }}>model</strong> it
          from public signals: for every keyword in their footprint we take the
          real Keyword Planner <strong style={{ color: colors.text }}>search volume × top-of-page CPC</strong>,
          then apply how often searchers click a paid ad and this advertiser&apos;s
          likely share of those clicks (by competition level). Summed across the
          footprint, that gives the range above.
          <div style={{ marginTop: 8 }}>
            Best read as <strong style={{ color: colors.text }}>who outspends whom</strong>, not
            an exact euro. {summary.confidence === "medium"
              ? "Live ad-spy is on, so real creatives and landing pages sharpen these numbers."
              : "Turning on live ad-spy (admin) sharpens it with real creatives, advertiser counts and landing pages."}
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Forecast — Google's own traffic projection for the recommended plan. The
// reliable metrics (impressions/clicks/CTR/CPC/cost) lead; conversions are
// shown separately and clearly flagged as an estimate (no conversion tracking).
// ----------------------------------------------------------------------------
function ForecastCard({
  colors,
  forecast,
}: {
  colors: Colors;
  forecast: ForecastProjection;
}) {
  const [how, setHow] = useState(false);
  const cur = forecast.currency;
  const showConv = forecast.conversions > 0;

  return (
    <div
      style={{
        background: "linear-gradient(180deg, rgba(59,130,246,0.07), rgba(59,130,246,0))",
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        padding: 22,
      }}
    >
      {/* headline */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 12.5, color: colors.textMuted, marginBottom: 4 }}>
            Projected for the recommended keywords, next ~{forecast.periodDays} days
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>
            ~{fmtInt(forecast.clicks)}
            <span style={{ fontSize: 15, fontWeight: 600, color: colors.textMuted }}> clicks</span>
            <span style={{ color: colors.textFaint, fontWeight: 600 }}> · </span>
            ~{fmtMoneyMicros(forecast.costMicros, cur)}
            <span style={{ fontSize: 15, fontWeight: 600, color: colors.textMuted }}> spend</span>
          </div>
          <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 4 }}>
            across {forecast.keywordCount} keyword
            {forecast.keywordCount === 1 ? "" : "s"} · phrase match
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: "5px 11px",
            borderRadius: 999,
            color: "#7DD3FC",
            background: "rgba(125,211,252,0.12)",
            whiteSpace: "nowrap",
          }}
        >
          Google Keyword Planner
        </span>
      </div>

      {/* reliable metric tiles */}
      <div
        style={{
          marginTop: 18,
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
        }}
      >
        <MetricTile colors={colors} label="Impressions" value={`~${fmtInt(forecast.impressions)}`} />
        <MetricTile colors={colors} label="Clicks" value={`~${fmtInt(forecast.clicks)}`} />
        <MetricTile colors={colors} label="CTR" value={fmtPct(forecast.ctr)} />
        <MetricTile colors={colors} label="Avg. CPC" value={fmtPriceMicros(forecast.avgCpcMicros, cur)} />
        <MetricTile colors={colors} label="Est. cost" value={`~${fmtMoneyMicros(forecast.costMicros, cur)}`} />
      </div>

      {/* conversions — clearly lower-confidence */}
      {showConv && (
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
              If conversions behave typically
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: 999,
                color: "#FBBF24",
                background: "rgba(251,191,36,0.12)",
              }}
            >
              Estimate
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            }}
          >
            <MetricTile colors={colors} label="Conversions" value={`~${fmtInt(forecast.conversions)}`} muted />
            <MetricTile colors={colors} label="Conv. rate" value={fmtPct(forecast.conversionRate)} muted />
            {forecast.cpaMicros > 0 && (
              <MetricTile colors={colors} label="Cost / conv." value={`~${fmtPriceMicros(forecast.cpaMicros, cur)}`} muted />
            )}
          </div>
        </div>
      )}

      {/* honest disclosure */}
      <button
        onClick={() => setHow((h) => !h)}
        style={{
          marginTop: 16,
          background: "transparent",
          border: "none",
          padding: 0,
          color: colors.accent,
          fontWeight: 600,
          fontSize: 12.5,
          cursor: "pointer",
        }}
      >
        {how ? "Hide how this is projected" : "ℹ️ How is this projected?"}
      </button>
      {how && (
        <div
          style={{
            marginTop: 10,
            fontSize: 12.5,
            color: colors.textMuted,
            lineHeight: 1.55,
            background: colors.bgInput,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 14,
          }}
        >
          {forecast.basis}
          <div style={{ marginTop: 8 }}>
            The forecast bids at{" "}
            <strong style={{ color: colors.text }}>
              {fmtPriceMicros(forecast.maxCpcMicros, cur)}
            </strong>{" "}
            max CPC (grounded in the real Keyword Planner CPC of these keywords).
            {showConv
              ? " Conversions assume Google's estimated typical conversion rate for this kind of traffic — connect conversion tracking to make them exact."
              : ""}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricTile({
  colors,
  label,
  value,
  muted,
}: {
  colors: Colors;
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div
      style={{
        background: colors.bgInput,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontSize: 19,
          fontWeight: 800,
          fontVariantNumeric: "tabular-nums",
          color: muted ? colors.textMuted : colors.text,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 }}>
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

function KeywordGapTable({ colors, gaps, cur = CUR }: { colors: Colors; gaps: KeywordGap[]; cur?: string }) {
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
              const cpc = fmtCpc(g.cpcLowMicros, g.cpcHighMicros, cur);
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
            <SourceBadge colors={colors} source={c.source} />
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
          {c.spend ? (
            <>
              <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: "#FBBF24" }}>
                ~{fmtMoney(c.spend.monthlyMid, c.spend.currency)}
              </div>
              <div style={{ fontSize: 11, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                est. spend/mo
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                {fmtVol(c.totalVolume)}
              </div>
              <div style={{ fontSize: 11, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                total volume
              </div>
            </>
          )}
          <div style={{ marginTop: 8, fontSize: 18, color: colors.textFaint }}>
            {open ? "▾" : "▸"}
          </div>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 20px 20px" }}>
          {/* estimated investment breakdown */}
          {c.spend && <SpendBreakdown colors={colors} spend={c.spend} />}

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

function SpendBreakdown({ colors, spend }: { colors: Colors; spend: SpendEstimate }) {
  const cur = spend.currency;
  const maxKw = Math.max(1, ...spend.topSpendKeywords.map((k) => k.estMonthlyMid));
  return (
    <Detail colors={colors} title="Estimated monthly investment">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <span style={{ fontSize: 22, fontWeight: 800, color: "#FBBF24", fontVariantNumeric: "tabular-nums" }}>
          {fmtMoney(spend.monthlyLow, cur)}–{fmtMoney(spend.monthlyHigh, cur)}
          <span style={{ fontSize: 13, fontWeight: 600, color: colors.textMuted }}> /mo</span>
        </span>
        <span style={{ fontSize: 12, color: colors.textFaint }}>
          {spend.commercialKeywords} monetizable keyword
          {spend.commercialKeywords === 1 ? "" : "s"}
          {spend.landingsDetected != null && ` · ${spend.landingsDetected} landing${spend.landingsDetected === 1 ? "" : "s"} detected`}
          {spend.activeCreatives != null && ` · ${spend.activeCreatives} live ad${spend.activeCreatives === 1 ? "" : "s"}`}
        </span>
      </div>

      {spend.topSpendKeywords.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11.5, color: colors.textMuted, marginBottom: 8 }}>
            Where their budget likely goes:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {spend.topSpendKeywords.map((k, i) => {
              const pct = Math.max(5, Math.round((k.estMonthlyMid / maxKw) * 100));
              const cpc = fmtCpc(k.cpcMicros, k.cpcMicros, cur);
              return (
                <div key={k.text + i}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 4 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {k.text}
                    </span>
                    <span style={{ fontSize: 12, color: colors.textMuted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                      ~{fmtMoney(k.estMonthlyMid, cur)}/mo
                      <span style={{ color: colors.textFaint }}>
                        {" "}· {fmtVol(k.estMonthlyClicks)} clicks{cpc ? ` · ${cpc}` : ""}
                      </span>
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 999, background: colors.bgInput, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, borderRadius: 999, background: "rgba(251,191,36,0.7)" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 12, lineHeight: 1.5 }}>
        {spend.basis}
      </p>
    </Detail>
  );
}

// Where this competitor came from — answers "did the system find it from my
// list or from the keyword?" at a glance.
function SourceBadge({
  colors,
  source,
}: {
  colors: Colors;
  source: BenchmarkCompetitor["source"];
}) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    derived: { label: "Found via keyword", color: "#7DD3FC", bg: "rgba(125,211,252,0.12)" },
    manual: { label: "You picked this", color: "#C4B5FD", bg: "rgba(196,181,253,0.12)" },
    brand_profile: { label: "From your list", color: colors.textMuted, bg: "rgba(255,255,255,0.05)" },
  };
  const m = map[source] ?? map.brand_profile;
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
