"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";
import {
  COUNTRIES,
  LANGUAGES,
  findCountry,
  languageName,
} from "@/lib/benchmark/countries";
import type {
  BenchmarkMode,
  LabAd,
  LabAdvertiser,
  LabCompetitorStat,
  LabReport,
  LabSource,
  LabStat,
  TransparencyParams,
} from "@/lib/benchmark/lab-types";

type Colors = ReturnType<typeof useTheme>["colors"];

interface Props {
  windmillConfigured: boolean;
  initialReport: LabReport;
}

const MODES: { key: BenchmarkMode; label: string; hint: string }[] = [
  { key: "keyword", label: "Keyword", hint: "Google Ads keyword search → advertisers + ads (Oxylabs)" },
  { key: "company", label: "Company", hint: "Google Transparency report for a specific domain (SerpApi)" },
  { key: "extended", label: "Extended", hint: "Keyword → domains → Transparency + OCR on all ad images" },
  { key: "extended_company", label: "Extended Company", hint: "Transparency + OCR only, no keyword search (domain input)" },
];

const STAGES = [
  "Discovering advertisers on your keywords · Oxylabs",
  "Pulling competitor ad creatives · Transparency Center",
  "Synthesizing the strategic teardown · AI",
];

// Ad-age bucket colours (recent → grey, long-lived → green = proven winner).
const AGE_COLORS = ["#9CA3AF", "#9CA3AF", "#FBBF24", "#34D399", "#4ADE80"];

// ----------------------------------------------------------------------------
// Formatters & tiny helpers
// ----------------------------------------------------------------------------
function fmtInt(n: number): string {
  return Math.round(Math.max(0, n)).toLocaleString("en-US");
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "—";
  }
}
function favicon(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}
function initialOf(s: string): string {
  return (s.replace(/^www\./, "")[0] || "?").toUpperCase();
}
function brandHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
function daysColor(days: number | null): string {
  if (days == null) return "#9CA3AF";
  if (days >= 365) return "#4ADE80";
  if (days >= 90) return "#FBBF24";
  return "#9CA3AF";
}
function formatColor(fmt: string | null): { color: string; bg: string } {
  const f = (fmt || "").toLowerCase();
  if (f === "video") return { color: "#F472B6", bg: "rgba(244,114,182,0.14)" };
  if (f === "image") return { color: "#60A5FA", bg: "rgba(96,165,250,0.14)" };
  return { color: "#34D399", bg: "rgba(52,211,153,0.14)" };
}

// ============================================================================
// Component
// ============================================================================
export function BenchmarkLab({ windmillConfigured, initialReport }: Props) {
  const { colors } = useTheme();

  const [keywords, setKeywords] = useState<string[]>(initialReport.query.keywords);
  const [kwInput, setKwInput] = useState("");
  const [countryCode, setCountryCode] = useState(initialReport.query.countryCode);
  const [language, setLanguage] = useState(initialReport.query.language);
  const [mode, setMode] = useState<BenchmarkMode>("keyword");
  const [numKeywords, setNumKeywords] = useState(10);
  const [numCompetitors, setNumCompetitors] = useState(6);
  const [transparency, setTransparency] = useState<TransparencyParams>({});

  const [loading, setLoading] = useState(false);
  const [stageIdx, setStageIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<LabReport>(initialReport);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [mounted, setMounted] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setMounted(true);
    return () => abortRef.current?.abort();
  }, []);

  // cosmetic stage cycler while a live run is in flight
  useEffect(() => {
    if (!loading) return;
    setStageIdx(0);
    const t = setInterval(() => setStageIdx((i) => Math.min(STAGES.length - 1, i + 1)), 2600);
    return () => clearInterval(t);
  }, [loading]);

  const selectCountry = useCallback((code: string) => {
    setCountryCode(code);
    setLanguage(findCountry(code).lang);
  }, []);

  const addKeywords = useCallback((raw: string) => {
    const parts = raw
      .split(/[\n,]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) return;
    setKeywords((prev) => [...new Set([...prev, ...parts])]);
  }, []);

  const removeKeyword = useCallback((kw: string) => {
    setKeywords((prev) => prev.filter((k) => k !== kw));
  }, []);

  const run = useCallback(async () => {
    const kws = [...keywords];
    if (kwInput.trim()) kws.push(...kwInput.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean));
    const finalKws = [...new Set(kws)];
    if (!finalKws.length) {
      setError("Add at least one keyword to benchmark.");
      return;
    }
    setKeywords(finalKws);
    setKwInput("");

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/benchmark/lab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        signal: ac.signal,
        body: JSON.stringify({ keywords: finalKws, countryCode, language, mode, numKeywords, numCompetitors, transparency }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      setReport(data.report as LabReport);
      setExpanded(new Set());
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      if (abortRef.current === ac) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  }, [keywords, kwInput, countryCode, language, mode, numKeywords, numCompetitors, transparency]);

  return (
    <div style={{ minHeight: "100vh", background: colors.bg }}>
      <style>{`
        @keyframes air-spin { to { transform: rotate(360deg); } }
        @keyframes air-pulse { 0%,100%{opacity:.35} 50%{opacity:1} }
        @keyframes air-rise { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform:none; } }
      `}</style>

      <Header breadcrumbs={[{ label: "Benchmark Lab" }]} />

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Hero */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: colors.accent }}>
              Competitor intelligence
            </span>
            <StatusPill live={windmillConfigured} colors={colors} />
          </div>
          <h1 style={{ fontSize: 30, fontWeight: 800, color: colors.text, lineHeight: 1.1, margin: 0 }}>
            Competitor Benchmark Lab
          </h1>
          <p style={{ fontSize: 14, color: colors.textMuted, marginTop: 8, maxWidth: 680, lineHeight: 1.6 }}>
            Drop in your keywords, pick a market, and see <strong style={{ color: colors.text }}>who is really running Google Ads</strong> on
            them — their oldest (most profitable) creatives, the angles they use, and where the gaps are.
          </p>
        </section>

        {/* Config */}
        <ConfigPanel
          colors={colors}
          keywords={keywords}
          kwInput={kwInput}
          setKwInput={setKwInput}
          addKeywords={addKeywords}
          removeKeyword={removeKeyword}
          countryCode={countryCode}
          selectCountry={selectCountry}
          language={language}
          setLanguage={setLanguage}
          mode={mode}
          setMode={setMode}
          numKeywords={numKeywords}
          setNumKeywords={setNumKeywords}
          numCompetitors={numCompetitors}
          setNumCompetitors={setNumCompetitors}
          transparency={transparency}
          setTransparency={setTransparency}
          loading={loading}
          onRun={run}
        />

        {error && (
          <div
            style={{
              marginTop: 16,
              padding: "12px 16px",
              borderRadius: 12,
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.3)",
              color: "#F87171",
              fontSize: 13.5,
            }}
          >
            {error}
          </div>
        )}

        {loading && <LoadingPanel colors={colors} stageIdx={stageIdx} />}

        {!loading && report && (
          <ReportView
            colors={colors}
            report={report}
            mounted={mounted}
            expanded={expanded}
            setExpanded={setExpanded}
          />
        )}
      </main>
    </div>
  );
}

// ============================================================================
// Config panel
// ============================================================================
function ConfigPanel(props: {
  colors: Colors;
  keywords: string[];
  kwInput: string;
  setKwInput: (s: string) => void;
  addKeywords: (s: string) => void;
  removeKeyword: (s: string) => void;
  countryCode: string;
  selectCountry: (c: string) => void;
  language: string;
  setLanguage: (l: string) => void;
  mode: BenchmarkMode;
  setMode: (m: BenchmarkMode) => void;
  numKeywords: number;
  setNumKeywords: (n: number) => void;
  numCompetitors: number;
  setNumCompetitors: (n: number) => void;
  transparency: TransparencyParams;
  setTransparency: (t: TransparencyParams) => void;
  loading: boolean;
  onRun: () => void;
}) {
  const { colors } = props;
  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: colors.textMuted,
    marginBottom: 8,
    display: "block",
  };
  const fieldStyle: React.CSSProperties = {
    width: "100%",
    background: colors.bgInput,
    border: `1px solid ${colors.border}`,
    borderRadius: 10,
    color: colors.text,
    fontSize: 14,
    padding: "10px 12px",
    outline: "none",
  };
  // company / extended_company are seeded with DOMAINS (Transparency only accepts
  // domains); keyword / extended are seeded with keywords (Oxylabs search).
  const isDomainInput = props.mode === "company" || props.mode === "extended_company";

  return (
    <div
      style={{
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        padding: 22,
      }}
    >
      {/* Keywords (or domains, for company / extended_company modes) */}
      <label style={labelStyle}>{isDomainInput ? "Competitor domains" : "Keywords"}</label>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          background: colors.bgInput,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          padding: 8,
          minHeight: 46,
        }}
      >
        {props.keywords.map((kw) => (
          <span
            key={kw}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "rgba(16,185,129,0.12)",
              border: "1px solid rgba(16,185,129,0.3)",
              color: colors.accent,
              borderRadius: 8,
              padding: "5px 8px",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {kw}
            <button
              onClick={() => props.removeKeyword(kw)}
              aria-label={`Remove ${kw}`}
              style={{ background: "none", border: "none", color: colors.accent, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={props.kwInput}
          onChange={(e) => props.setKwInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              props.addKeywords(props.kwInput);
              props.setKwInput("");
            } else if (e.key === "Backspace" && !props.kwInput && props.keywords.length) {
              props.removeKeyword(props.keywords[props.keywords.length - 1]);
            }
          }}
          onBlur={() => {
            if (props.kwInput.trim()) {
              props.addKeywords(props.kwInput);
              props.setKwInput("");
            }
          }}
          placeholder={
            props.keywords.length
              ? "Add another…"
              : isDomainInput
                ? "e.g. semrush.com, jasper.ai"
                : "e.g. ai seo tools, keyword research"
          }
          style={{ flex: 1, minWidth: 160, background: "transparent", border: "none", outline: "none", color: colors.text, fontSize: 14, padding: "5px 4px" }}
        />
      </div>
      <span style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 6, display: "block" }}>
        Press Enter or comma to add. Smart defaults are set — tweak only if you want.
      </span>

      {/* Row: country / language / mode */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginTop: 18 }}>
        <div>
          <label style={labelStyle}>Country</label>
          <select value={props.countryCode} onChange={(e) => props.selectCountry(e.target.value)} style={fieldStyle}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.flag} {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Language</label>
          <select value={props.language} onChange={(e) => props.setLanguage(e.target.value)} style={fieldStyle}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Mode</label>
          <div style={{ display: "flex", gap: 6, background: colors.bgInput, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 4 }}>
            {MODES.map((m) => {
              const active = props.mode === m.key;
              return (
                <button
                  key={m.key}
                  title={m.hint}
                  onClick={() => props.setMode(m.key)}
                  style={{
                    flex: 1,
                    padding: "7px 6px",
                    borderRadius: 7,
                    border: "none",
                    cursor: "pointer",
                    fontSize: 12.5,
                    fontWeight: 600,
                    background: active ? colors.accent : "transparent",
                    color: active ? "#06281D" : colors.textMuted,
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Advanced: manual Transparency-Center parameters (company / extended modes) */}
      {props.mode !== "keyword" && (
        <details style={{ marginTop: 18 }}>
          <summary
            style={{
              cursor: "pointer",
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: colors.textMuted,
            }}
          >
            Transparency parameters · manual (optional)
          </summary>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginTop: 14 }}>
            <div>
              <label style={labelStyle}>Region (geo code)</label>
              <input
                value={props.transparency.region ?? ""}
                onChange={(e) => props.setTransparency({ ...props.transparency, region: e.target.value })}
                placeholder="empty = global · e.g. 2840"
                style={fieldStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Platform</label>
              <select
                value={props.transparency.platform ?? ""}
                onChange={(e) => props.setTransparency({ ...props.transparency, platform: e.target.value || null })}
                style={fieldStyle}
              >
                <option value="">All platforms</option>
                <option value="SEARCH">Search</option>
                <option value="MAPS">Maps</option>
                <option value="YOUTUBE">YouTube</option>
                <option value="GOOGLEPLAY">Google Play</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Creative format</label>
              <select
                value={props.transparency.creativeFormat ?? ""}
                onChange={(e) => props.setTransparency({ ...props.transparency, creativeFormat: e.target.value || null })}
                style={fieldStyle}
              >
                <option value="">All formats</option>
                <option value="text">Text</option>
                <option value="image">Image</option>
                <option value="video">Video</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Advertiser ID</label>
              <input
                value={props.transparency.advertiserId ?? ""}
                onChange={(e) => props.setTransparency({ ...props.transparency, advertiserId: e.target.value })}
                placeholder="AR… (optional)"
                style={fieldStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Start date</label>
              <input
                value={props.transparency.startDate ?? ""}
                onChange={(e) => props.setTransparency({ ...props.transparency, startDate: e.target.value })}
                placeholder="YYYYMMDD"
                style={fieldStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>End date</label>
              <input
                value={props.transparency.endDate ?? ""}
                onChange={(e) => props.setTransparency({ ...props.transparency, endDate: e.target.value })}
                placeholder="YYYYMMDD"
                style={fieldStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Max ads (1–100)</label>
              <input
                type="number"
                min={1}
                max={100}
                value={props.transparency.num ?? 100}
                onChange={(e) =>
                  props.setTransparency({
                    ...props.transparency,
                    num: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                style={fieldStyle}
              />
            </div>
          </div>
          <span style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 8, display: "block" }}>
            Blank = safe defaults (no region → global, all platforms &amp; formats, 100 ads). Region is only sent when you set it.
          </span>
        </details>
      )}

      {/* Row: counts + run */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 16, marginTop: 18 }}>
        <Stepper colors={colors} label="Keywords to analyze" value={props.numKeywords} setValue={props.setNumKeywords} min={1} max={25} />
        <Stepper colors={colors} label="Competitors to scan" value={props.numCompetitors} setValue={props.setNumCompetitors} min={1} max={20} />
        <div style={{ flex: 1 }} />
        <button
          onClick={props.onRun}
          disabled={props.loading}
          style={{
            padding: "13px 30px",
            borderRadius: 12,
            border: "none",
            cursor: props.loading ? "default" : "pointer",
            fontSize: 14.5,
            fontWeight: 700,
            background: props.loading ? "rgba(16,185,129,0.4)" : colors.accent,
            color: "#06281D",
            display: "inline-flex",
            alignItems: "center",
            gap: 9,
          }}
        >
          {props.loading ? (
            <>
              <Spinner />
              Running…
            </>
          ) : (
            <>
              <BoltIcon />
              Run benchmark
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function Stepper(props: {
  colors: Colors;
  label: string;
  value: number;
  setValue: (n: number) => void;
  min: number;
  max: number;
}) {
  const { colors } = props;
  const btn: React.CSSProperties = {
    width: 34,
    height: 38,
    border: `1px solid ${colors.border}`,
    background: colors.bgInput,
    color: colors.text,
    cursor: "pointer",
    fontSize: 16,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
  return (
    <div>
      <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: colors.textMuted, marginBottom: 8, display: "block" }}>
        {props.label}
      </label>
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <button style={{ ...btn, borderRadius: "8px 0 0 8px" }} onClick={() => props.setValue(Math.max(props.min, props.value - 1))}>
          −
        </button>
        <input
          type="number"
          value={props.value}
          min={props.min}
          max={props.max}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n)) props.setValue(Math.max(props.min, Math.min(props.max, n)));
          }}
          style={{
            width: 52,
            textAlign: "center",
            border: `1px solid ${colors.border}`,
            borderLeft: "none",
            borderRight: "none",
            background: colors.bgInput,
            color: colors.text,
            fontSize: 14,
            fontWeight: 700,
            outline: "none",
          }}
        />
        <button style={{ ...btn, borderRadius: "0 8px 8px 0" }} onClick={() => props.setValue(Math.min(props.max, props.value + 1))}>
          +
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Loading
// ============================================================================
function LoadingPanel({ colors, stageIdx }: { colors: Colors; stageIdx: number }) {
  return (
    <div
      style={{
        marginTop: 20,
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        padding: 24,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {STAGES.map((s, i) => {
          const done = i < stageIdx;
          const active = i === stageIdx;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, opacity: done || active ? 1 : 0.4 }}>
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: done ? colors.accent : "transparent",
                  border: `2px solid ${done || active ? colors.accent : colors.border}`,
                }}
              >
                {done ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#06281D" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : active ? (
                  <Spinner color={colors.accent} />
                ) : null}
              </span>
              <span style={{ fontSize: 13.5, color: active ? colors.text : colors.textMuted, fontWeight: active ? 600 : 400, animation: active ? "air-pulse 1.6s ease-in-out infinite" : undefined }}>
                {s}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Report
// ============================================================================
function ReportView(props: {
  colors: Colors;
  report: LabReport;
  mounted: boolean;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
}) {
  const { colors, report, mounted } = props;
  const s = report.summary;
  const a = report.analytics;

  const chartData = useMemo(
    () => report.advertisers.map((a) => ({ name: a.domain.replace(/^www\./, ""), ads: a.totalAds })),
    [report.advertisers],
  );

  const toggle = (domain: string) => {
    const next = new Set(props.expanded);
    if (next.has(domain)) next.delete(domain);
    else next.add(domain);
    props.setExpanded(next);
  };

  return (
    <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 20, animation: "air-rise 0.3s ease both" }}>
      {report.demo && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "11px 16px",
            borderRadius: 12,
            background: "rgba(251,191,36,0.1)",
            border: "1px solid rgba(251,191,36,0.3)",
            color: "#FBBF24",
            fontSize: 13,
          }}
        >
          <InfoIcon />
          <span>
            <strong>Demo data.</strong> Set <code style={codeChip}>WINDMILL_URL</code>, <code style={codeChip}>WINDMILL_WORKSPACE</code> and{" "}
            <code style={codeChip}>WINDMILL_TOKEN</code> to run this live against the real Oxylabs + Transparency Center backend.
          </span>
        </div>
      )}

      {/* Provenance */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {report.sources.map((src, i) => (
          <SourceChip key={i} src={src} colors={colors} />
        ))}
      </div>

      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <StatCard colors={colors} value={fmtInt(s.advertisers)} label="Advertisers" sub={`on ${fmtInt(s.keywordsAnalyzed)} keyword(s)`} />
        <StatCard colors={colors} value={fmtInt(s.totalAds)} label="Active ads" sub="across competitors" />
        <StatCard colors={colors} value={`${fmtInt(s.avgDaysActive)}d`} label="Avg ad age" sub="how long they run" />
        <StatCard colors={colors} value={`${fmtInt(s.oldestDays)}d`} label="Oldest ad" sub="= most profitable" accent />
        <StatCard colors={colors} value={report.query.countryName} label="Market" sub={report.query.language.toUpperCase()} />
      </div>

      {/* Share of voice — ranking chart + detailed competitor table */}
      {report.advertisers.length > 0 && (
        <Card colors={colors}>
          <SectionTitle colors={colors} title="Share of voice" subtitle="Who owns the most ad inventory on your keywords right now" />
          {chartData.length > 0 && (
            <div style={{ width: "100%", height: Math.max(170, chartData.length * 46), marginTop: 14 }}>
              {mounted ? (
                <ResponsiveContainer width="100%" height={Math.max(170, chartData.length * 46)} minWidth={0}>
                  <BarChart layout="vertical" data={chartData} margin={{ left: 8, right: 28, top: 4, bottom: 4 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={150} tick={{ fill: colors.textMuted, fontSize: 12 }} axisLine={false} tickLine={false} />
                    <Tooltip
                      cursor={{ fill: "rgba(16,185,129,0.08)" }}
                      contentStyle={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 12, color: colors.text }}
                      labelStyle={{ color: colors.text }}
                    />
                    <Bar dataKey="ads" radius={[0, 6, 6, 0]} barSize={18} label={{ position: "right", fill: colors.textMuted, fontSize: 11 }}>
                      {chartData.map((_, i) => (
                        <Cell key={i} fill={colors.accent} fillOpacity={1 - i * 0.07} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : null}
            </div>
          )}
          <SovTable colors={colors} rows={a.competitors} />
        </Card>
      )}

      {/* Analytics grid — formats, ad age, CTAs, copy terms */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 20 }}>
        <Card colors={colors}>
          <SectionTitle colors={colors} title="Ad formats" subtitle={`Creative mix across ${fmtInt(a.creativesAnalyzed)} sampled ads`} />
          <MetricBars colors={colors} stats={a.formats} labelWidth={86} barColor={(st) => formatColor(st.label).color} emptyHint="No creatives captured yet." />
        </Card>
        <Card colors={colors}>
          <SectionTitle colors={colors} title="Ad age distribution" subtitle="Older survivors = proven, profitable messaging" />
          <MetricBars colors={colors} stats={a.ageBuckets} labelWidth={86} barColor={(_st, i) => AGE_COLORS[i] ?? colors.accent} emptyHint="No dated creatives yet." />
        </Card>
        {a.ctas.length > 0 && (
          <Card colors={colors}>
            <SectionTitle colors={colors} title="Top calls to action" subtitle="The offers competitors lead with" />
            <MetricBars colors={colors} stats={a.ctas} labelWidth={150} />
          </Card>
        )}
        {a.headlineTerms.length > 0 && (
          <Card colors={colors}>
            <SectionTitle colors={colors} title="Most-used ad copy terms" subtitle="% of competitors whose headlines use each term" />
            <Chips colors={colors} items={a.headlineTerms.map((t) => ({ label: t.label, sub: `${t.pct}%` }))} />
          </Card>
        )}
      </div>

      {/* Keyword coverage — only meaningful with more than one keyword */}
      {a.keywordCoverage.length > 1 && (
        <Card colors={colors}>
          <SectionTitle colors={colors} title="Keyword coverage" subtitle="Which competitors show up on each keyword you entered" />
          <CoverageMatrix colors={colors} coverage={a.keywordCoverage} />
        </Card>
      )}

      {/* Recommended keywords + the brand-competitor ("vs") gap */}
      {a.recommendedKeywords.length > 0 && (
        <Card colors={colors}>
          <SectionTitle colors={colors} title="Recommended keywords" subtitle="Mined from the words competitors actually use in their winning ads" />
          <Chips colors={colors} items={a.recommendedKeywords.map((k) => ({ label: k }))} accent />
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${colors.border}`, display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, color: colors.textMuted }}>
            <BoltGlyph color={colors.accent} />
            <span>
              {a.vsAdvertisers.length > 0 ? (
                <>
                  <strong style={{ color: colors.text }}>{a.vsAdvertisers.length} competitor{a.vsAdvertisers.length > 1 ? "s" : ""}</strong> run brand-comparison (“vs / alternative”) ads: {a.vsAdvertisers.join(", ")}. Match them with a switch-from campaign of your own.
                </>
              ) : (
                <>
                  <strong style={{ color: colors.text }}>Nobody is running comparison (“vs / alternative”) ads yet</strong> — an open lane to capture high-intent switchers before rivals do.
                </>
              )}
            </span>
          </div>
        </Card>
      )}

      {/* Oldest ads gallery */}
      {report.topOldestAds.length > 0 && (
        <Card colors={colors}>
          <SectionTitle
            colors={colors}
            title="Longest-running ads"
            subtitle="Still live after months → proven winners worth modelling"
          />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14, marginTop: 14 }}>
            {report.topOldestAds.map((ad, i) => (
              <AdCreative key={i} ad={ad} colors={colors} />
            ))}
          </div>
        </Card>
      )}

      {/* Advertisers */}
      <Card colors={colors}>
        <SectionTitle colors={colors} title="Advertisers" subtitle="Click a competitor to see their oldest creatives" />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
          {report.advertisers.map((adv) => (
            <AdvertiserCard key={adv.domain} adv={adv} colors={colors} open={props.expanded.has(adv.domain)} onToggle={() => toggle(adv.domain)} />
          ))}
        </div>
      </Card>

      {/* AI teardown */}
      {report.analysis && (
        <Card colors={colors}>
          <SectionTitle colors={colors} title="Strategic teardown" subtitle={`AI synthesis · ${languageName(report.analysis.language)}`} />
          <div style={{ marginTop: 14 }}>
            <MiniMarkdown text={report.analysis.markdown} colors={colors} />
          </div>
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${colors.border}`, fontSize: 11.5, color: colors.textFaint }}>
            Generated by {report.analysis.model} · {fmtDate(report.generatedAt)}
          </div>
        </Card>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Report sub-pieces
// ----------------------------------------------------------------------------
function Card({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 16, padding: 20 }}>{children}</div>;
}

function SectionTitle({ colors, title, subtitle }: { colors: Colors; title: string; subtitle?: string }) {
  return (
    <div>
      <h2 style={{ fontSize: 17, fontWeight: 800, color: colors.text, margin: 0 }}>{title}</h2>
      {subtitle && <p style={{ fontSize: 13, color: colors.textMuted, margin: "4px 0 0" }}>{subtitle}</p>}
    </div>
  );
}

function StatCard({ colors, value, label, sub, accent }: { colors: Colors; value: string; label: string; sub?: string; accent?: boolean }) {
  return (
    <div
      style={{
        background: accent ? "rgba(16,185,129,0.08)" : colors.bgCard,
        border: `1px solid ${accent ? "rgba(16,185,129,0.3)" : colors.border}`,
        borderRadius: 14,
        padding: "16px 18px",
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 800, color: accent ? colors.accent : colors.text, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: colors.text, marginTop: 6 }}>{label}</div>
      {sub && <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SourceChip({ src, colors }: { src: LabSource; colors: Colors }) {
  return (
    <div
      title={src.detail}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 9,
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: 999,
        padding: "7px 13px",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: src.live ? colors.accent : "#FBBF24", boxShadow: `0 0 8px ${src.live ? colors.accent : "#FBBF24"}` }} />
      <span style={{ fontSize: 12.5, fontWeight: 600, color: colors.text }}>{src.label}</span>
      <span style={{ fontSize: 11.5, color: colors.textMuted }}>· {src.provider}</span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Dashboard widgets (deterministic analytics)
// ----------------------------------------------------------------------------

/** Horizontal labelled bars for any frequency stat (formats, age, CTAs). */
function MetricBars({
  colors,
  stats,
  labelWidth = 92,
  barColor,
  emptyHint,
}: {
  colors: Colors;
  stats: LabStat[];
  labelWidth?: number;
  barColor?: (s: LabStat, i: number) => string;
  emptyHint?: string;
}) {
  if (!stats.length) {
    return <div style={{ fontSize: 12.5, color: colors.textFaint, marginTop: 14 }}>{emptyHint ?? "No data in this run."}</div>;
  }
  const max = Math.max(...stats.map((s) => s.count), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
      {stats.map((st, i) => (
        <div key={st.label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            title={st.label}
            style={{ width: labelWidth, flexShrink: 0, fontSize: 12.5, color: colors.text, fontWeight: 600, textTransform: "capitalize", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {st.label}
          </span>
          <div style={{ flex: 1, height: 10, borderRadius: 999, background: "rgba(127,127,127,0.12)", overflow: "hidden", minWidth: 40 }}>
            <div style={{ width: `${Math.max(3, Math.round((st.count / max) * 100))}%`, height: "100%", borderRadius: 999, background: barColor ? barColor(st, i) : colors.accent, transition: "width 0.4s ease" }} />
          </div>
          <span style={{ width: 74, flexShrink: 0, textAlign: "right", fontSize: 12, color: colors.textMuted }}>
            <strong style={{ color: colors.text }}>{fmtInt(st.count)}</strong> · {st.pct}%
          </span>
        </div>
      ))}
    </div>
  );
}

/** Pill list for terms / keywords, with optional sub-label (e.g. a %). */
function Chips({ colors, items, accent }: { colors: Colors; items: { label: string; sub?: string }[]; accent?: boolean }) {
  if (!items.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
      {items.map((it, i) => (
        <span
          key={`${it.label}-${i}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            fontWeight: 600,
            color: accent ? colors.accent : colors.text,
            background: accent ? "rgba(16,185,129,0.1)" : "rgba(127,127,127,0.08)",
            border: `1px solid ${accent ? "rgba(16,185,129,0.3)" : colors.border}`,
            borderRadius: 999,
            padding: "5px 11px",
          }}
        >
          {it.label}
          {it.sub && <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 500 }}>{it.sub}</span>}
        </span>
      ))}
    </div>
  );
}

/** Thin stacked bar showing a competitor's text/image/video proportions. */
function FormatMiniBar({ stats }: { stats: LabStat[] }) {
  const total = stats.reduce((n, s) => n + s.count, 0);
  if (!total) return <span style={{ color: "#6B7280" }}>—</span>;
  return (
    <div
      title={stats.map((s) => `${s.label} ${s.pct}%`).join(" · ")}
      style={{ display: "flex", width: 84, height: 8, borderRadius: 999, overflow: "hidden", background: "rgba(127,127,127,0.12)" }}
    >
      {stats.map((s, i) => (
        <span key={i} style={{ width: `${(s.count / total) * 100}%`, background: formatColor(s.label).color }} />
      ))}
    </div>
  );
}

/** Small "VS" tag flagging a competitor that runs brand-comparison ads. */
function VsBadge() {
  return (
    <span
      title="Runs brand-competitor (vs / alternative) ads"
      style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: "0.05em", color: "#F472B6", background: "rgba(244,114,182,0.14)", border: "1px solid rgba(244,114,182,0.3)", borderRadius: 999, padding: "1px 6px" }}
    >
      VS
    </span>
  );
}

/** The share-of-voice leaderboard table. */
function SovTable({ colors, rows }: { colors: Colors; rows: LabCompetitorStat[] }) {
  if (!rows.length) return null;
  const maxShare = Math.max(...rows.map((r) => r.sharePct), 1);
  const th: React.CSSProperties = { textAlign: "left", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: colors.textMuted, padding: "0 12px 10px", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: 12, borderTop: `1px solid ${colors.border}`, fontSize: 12.5, color: colors.text, verticalAlign: "middle", whiteSpace: "nowrap" };
  return (
    <div style={{ overflowX: "auto", marginTop: 18 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
        <thead>
          <tr>
            <th style={th}>Competitor</th>
            <th style={{ ...th, textAlign: "right" }}>Ads</th>
            <th style={th}>Share of voice</th>
            <th style={{ ...th, textAlign: "right" }}>Oldest</th>
            <th style={{ ...th, textAlign: "right" }}>Avg age</th>
            <th style={th}>Formats</th>
            <th style={th}>Top CTAs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.domain}>
              <td style={td}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <Favicon domain={r.domain} hue={brandHue(r.domain)} size={22} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ fontWeight: 700 }}>{r.domain}</span>
                      {r.runsVsAds && <VsBadge />}
                    </div>
                    {r.landingUrl && (
                      <a href={r.landingUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: colors.accent, textDecoration: "none" }}>
                        landing ↗
                      </a>
                    )}
                  </div>
                </div>
              </td>
              <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{fmtInt(r.totalAds)}</td>
              <td style={{ ...td, minWidth: 150 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, height: 8, borderRadius: 999, background: "rgba(127,127,127,0.12)", overflow: "hidden", minWidth: 60 }}>
                    <div style={{ width: `${Math.max(4, Math.round((r.sharePct / maxShare) * 100))}%`, height: "100%", background: colors.accent }} />
                  </div>
                  <span style={{ fontSize: 12, color: colors.textMuted, width: 34, textAlign: "right" }}>{r.sharePct}%</span>
                </div>
              </td>
              <td style={{ ...td, textAlign: "right", color: daysColor(r.oldestDays), fontWeight: 700 }}>{r.oldestDays ? `${fmtInt(r.oldestDays)}d` : "—"}</td>
              <td style={{ ...td, textAlign: "right", color: colors.textMuted }}>{r.avgDays ? `${fmtInt(r.avgDays)}d` : "—"}</td>
              <td style={td}><FormatMiniBar stats={r.formats} /></td>
              <td style={{ ...td, whiteSpace: "normal", maxWidth: 220 }}>
                {r.topCtas.length ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {r.topCtas.map((c, i) => (
                      <span key={i} style={{ fontSize: 11, color: colors.textMuted, background: "rgba(127,127,127,0.1)", borderRadius: 6, padding: "2px 7px" }}>{c}</span>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: colors.textFaint }}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Per-keyword roster of which competitors advertise on it. */
function CoverageMatrix({ colors, coverage }: { colors: Colors; coverage: { keyword: string; domains: string[] }[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
      {coverage.map((row) => (
        <div key={row.keyword} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ minWidth: 140, maxWidth: 240, fontSize: 12.5, fontWeight: 700, color: colors.text }}>{row.keyword}</span>
          <span style={{ fontSize: 11.5, color: colors.textMuted, width: 62 }}>
            {row.domains.length} {row.domains.length === 1 ? "rival" : "rivals"}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {row.domains.length ? (
              row.domains.map((d) => (
                <span key={d} title={d} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(127,127,127,0.08)", border: `1px solid ${colors.border}`, borderRadius: 999, padding: "3px 9px 3px 4px" }}>
                  <Favicon domain={d} hue={brandHue(d)} size={18} />
                  <span style={{ fontSize: 11.5, color: colors.text }}>{d}</span>
                </span>
              ))
            ) : (
              <span style={{ fontSize: 12, color: colors.textFaint }}>No advertisers found</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Lightning glyph that inherits an arbitrary colour (unlike BoltIcon). */
function BoltGlyph({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function AdCreative({ ad, colors }: { ad: LabAd; colors: Colors }) {
  const [imgOk, setImgOk] = useState(true);
  const showImg = Boolean(ad.imageUrl) && imgOk;
  const fmt = formatColor(ad.format);
  const hue = brandHue(ad.advertiserDomain || ad.advertiser || "x");
  const name = ad.advertiser || ad.advertiserDomain || "Advertiser";

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 12, overflow: "hidden", background: colors.bg }}>
      <div style={{ position: "relative", height: 140, background: `linear-gradient(135deg, hsl(${hue} 60% 22%), hsl(${(hue + 40) % 360} 55% 14%))`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ad.imageUrl!} alt={`${name} ad`} onError={() => setImgOk(false)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <div style={{ textAlign: "center", padding: 12 }}>
            <div style={{ fontSize: 30, fontWeight: 800, color: "rgba(255,255,255,0.9)" }}>{initialOf(name)}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {ad.format || "text"} ad
            </div>
          </div>
        )}
        <span style={{ position: "absolute", top: 8, left: 8, fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: "rgba(0,0,0,0.55)", color: daysColor(ad.daysActive) }}>
          {ad.daysActive != null ? `${fmtInt(ad.daysActive)} days` : "live"}
        </span>
        <span style={{ position: "absolute", top: 8, right: 8, fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: fmt.bg, color: fmt.color }}>
          {(ad.format || "text").toUpperCase()}
        </span>
      </div>
      <div style={{ padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Favicon domain={ad.advertiserDomain || ""} hue={hue} />
          <span style={{ fontSize: 13, fontWeight: 700, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        </div>
        <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 8 }}>
          {fmtDate(ad.firstShown)} → {fmtDate(ad.lastShown)}
        </div>
        {ad.detailsLink && (
          <a href={ad.detailsLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: colors.accent, fontWeight: 600, marginTop: 8, display: "inline-block", textDecoration: "none" }}>
            View in Transparency ↗
          </a>
        )}
      </div>
    </div>
  );
}

function AdvertiserCard({ adv, colors, open, onToggle }: { adv: LabAdvertiser; colors: Colors; open: boolean; onToggle: () => void }) {
  const hue = brandHue(adv.domain);
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 12, overflow: "hidden", background: colors.bg }}>
      <button
        onClick={onToggle}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: 14, background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <Favicon domain={adv.domain} hue={hue} size={28} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14.5, fontWeight: 700, color: colors.text }}>{adv.domain}</span>
            <Tag colors={colors} text={adv.source} />
            {adv.viaKeywords.length > 0 && <Tag colors={colors} text={`${adv.viaKeywords.length} kw`} muted />}
          </div>
          {adv.sampleHeadline && (
            <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              “{adv.sampleHeadline}”
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: colors.text }}>
            {fmtInt(adv.totalAds)} <span style={{ fontWeight: 400, color: colors.textMuted, fontSize: 12 }}>ads</span>
          </span>
          <span style={{ color: colors.textMuted, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s", display: "flex" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </div>
      </button>
      {open && (
        <div style={{ padding: "0 14px 14px" }}>
          {adv.oldestTop5.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
              {adv.oldestTop5.map((ad, i) => (
                <AdCreative key={i} ad={ad} colors={colors} />
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: colors.textFaint, padding: "4px 2px" }}>No transparency creatives captured for this domain.</div>
          )}
        </div>
      )}
    </div>
  );
}

function Tag({ colors, text, muted }: { colors: Colors; text: string; muted?: boolean }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        padding: "2px 7px",
        borderRadius: 999,
        background: muted ? "rgba(255,255,255,0.05)" : "rgba(16,185,129,0.12)",
        color: muted ? colors.textMuted : colors.accent,
        border: `1px solid ${muted ? colors.border : "rgba(16,185,129,0.3)"}`,
      }}
    >
      {text}
    </span>
  );
}

function Favicon({ domain, hue, size = 22 }: { domain: string; hue: number; size?: number }) {
  const [ok, setOk] = useState(true);
  if (!domain || !ok) {
    return (
      <span style={{ width: size, height: size, borderRadius: 6, background: `hsl(${hue} 55% 30%)`, color: "#fff", fontSize: size * 0.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {initialOf(domain || "?")}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={favicon(domain)} alt="" width={size} height={size} onError={() => setOk(false)} style={{ borderRadius: 6, flexShrink: 0, background: "#fff" }} />
  );
}

// ----------------------------------------------------------------------------
// Mini markdown renderer (no dependency)
// ----------------------------------------------------------------------------
function renderInline(text: string, colors: Colors, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) nodes.push(<strong key={`${keyBase}-${i++}`} style={{ color: colors.text, fontWeight: 700 }}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) nodes.push(<code key={`${keyBase}-${i++}`} style={codeChip}>{tok.slice(1, -1)}</code>);
    else nodes.push(<em key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function MiniMarkdown({ text, colors }: { text: string; colors: Colors }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (para.length) {
      const txt = para.join(" ");
      blocks.push(
        <p key={`p${key++}`} style={{ margin: "0 0 12px", lineHeight: 1.7, color: colors.textMuted, fontSize: 14 }}>
          {renderInline(txt, colors, `p${key}`)}
        </p>,
      );
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const L = list;
      const liStyle: React.CSSProperties = { margin: "0 0 6px", lineHeight: 1.6, color: colors.textMuted, fontSize: 14 };
      const wrapStyle: React.CSSProperties = { margin: "0 0 12px", paddingLeft: 20 };
      blocks.push(
        L.ordered ? (
          <ol key={`l${key++}`} style={wrapStyle}>
            {L.items.map((it, idx) => (
              <li key={idx} style={liStyle}>
                {renderInline(it, colors, `l${key}-${idx}`)}
              </li>
            ))}
          </ol>
        ) : (
          <ul key={`l${key++}`} style={wrapStyle}>
            {L.items.map((it, idx) => (
              <li key={idx} style={liStyle}>
                {renderInline(it, colors, `l${key}-${idx}`)}
              </li>
            ))}
          </ul>
        ),
      );
      list = null;
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushAll();
      continue;
    }
    if (/^###\s+/.test(line)) {
      flushAll();
      blocks.push(<h3 key={`h${key++}`} style={{ fontSize: 14.5, fontWeight: 700, color: colors.text, margin: "16px 0 8px" }}>{renderInline(line.replace(/^###\s+/, ""), colors, `h${key}`)}</h3>);
      continue;
    }
    if (/^##\s+/.test(line)) {
      flushAll();
      blocks.push(<h2 key={`h${key++}`} style={{ fontSize: 16, fontWeight: 800, color: colors.text, margin: "18px 0 10px" }}>{renderInline(line.replace(/^##\s+/, ""), colors, `h${key}`)}</h2>);
      continue;
    }
    if (/^#\s+/.test(line)) {
      flushAll();
      blocks.push(<h2 key={`h${key++}`} style={{ fontSize: 17, fontWeight: 800, color: colors.text, margin: "18px 0 10px" }}>{renderInline(line.replace(/^#\s+/, ""), colors, `h${key}`)}</h2>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushAll();
      blocks.push(
        <blockquote key={`q${key++}`} style={{ margin: "0 0 12px", padding: "8px 14px", borderLeft: `3px solid ${colors.accent}`, background: "rgba(16,185,129,0.06)", borderRadius: "0 8px 8px 0", color: colors.textMuted, fontSize: 13.5 }}>
          {renderInline(line.replace(/^>\s?/, ""), colors, `q${key}`)}
        </blockquote>,
      );
      continue;
    }
    if (/^---+$/.test(line)) {
      flushAll();
      blocks.push(<hr key={`hr${key++}`} style={{ border: "none", borderTop: `1px solid ${colors.border}`, margin: "16px 0" }} />);
      continue;
    }
    const oli = line.match(/^(\d+)\.\s+(.*)/);
    const uli = line.match(/^[-*]\s+(.*)/);
    if (oli) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(oli[2]);
      continue;
    }
    if (uli) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(uli[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushAll();
  return <div>{blocks}</div>;
}

// ----------------------------------------------------------------------------
// Icons & atoms
// ----------------------------------------------------------------------------
const codeChip: React.CSSProperties = {
  fontFamily: "var(--font-geist-mono), monospace",
  fontSize: "0.85em",
  padding: "1px 6px",
  borderRadius: 5,
  background: "rgba(127,127,127,0.18)",
};

function StatusPill({ live, colors }: { live: boolean; colors: Colors }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        padding: "3px 9px",
        borderRadius: 999,
        background: live ? "rgba(16,185,129,0.12)" : "rgba(251,191,36,0.12)",
        color: live ? colors.accent : "#FBBF24",
        border: `1px solid ${live ? "rgba(16,185,129,0.3)" : "rgba(251,191,36,0.3)"}`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: live ? colors.accent : "#FBBF24" }} />
      {live ? "Live backend" : "Demo mode"}
    </span>
  );
}

function Spinner({ color = "#06281D" }: { color?: string }) {
  return (
    <span
      style={{
        width: 14,
        height: 14,
        borderRadius: 999,
        border: `2px solid ${color}`,
        borderTopColor: "transparent",
        display: "inline-block",
        animation: "air-spin 0.8s linear infinite",
      }}
    />
  );
}

function BoltIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#06281D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
