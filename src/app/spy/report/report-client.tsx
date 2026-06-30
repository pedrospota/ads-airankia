"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { MarkdownReport } from "@/components/markdown-report";
import { COUNTRIES } from "@/lib/benchmark/countries";

export function ReportClient() {
  const { colors } = useTheme();
  const [brandDomain, setBrandDomain] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ markdown: string; cost: number; competitors: string[] } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async () => {
    if (!brandDomain.trim()) {
      setError("Enter your brand domain.");
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const list = competitors.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      const res = await fetch("/api/spy/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        signal: ac.signal,
        body: JSON.stringify({ brandDomain: brandDomain.trim(), competitors: list, countryCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setReport({ markdown: data.reportMarkdown, cost: data.cost, competitors: data.competitors });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      if (abortRef.current === ac) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  }, [brandDomain, competitors, countryCode]);

  const input: React.CSSProperties = {
    width: "100%", background: colors.bgInput, border: `1px solid ${colors.border}`,
    borderRadius: 10, color: colors.text, fontSize: 14, padding: "10px 12px", outline: "none",
  };
  const label: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
    color: colors.textMuted, marginBottom: 6, display: "block",
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: colors.text, margin: 0 }}>📄 Premium Report</h1>
        <span style={{ fontSize: 11, fontWeight: 600, color: colors.accent, background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 999, padding: "3px 9px" }}>
          all tools · one report
        </span>
      </div>
      <p style={{ fontSize: 14, color: colors.textMuted, marginTop: 4, maxWidth: 640, lineHeight: 1.6 }}>
        One run = every spy tool over your competitors → <strong style={{ color: colors.text }}>spend</strong>, keyword gaps,
        <strong style={{ color: colors.text }}> landing teardowns</strong>, who attacks your brand, and an AI strategy — in one consolidated report.
      </p>

      <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 16, padding: 20, marginTop: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
          <div>
            <label style={label}>Your domain</label>
            <input style={input} placeholder="e.g. airankia.com" value={brandDomain} onChange={(e) => setBrandDomain(e.target.value)} />
          </div>
          <div>
            <label style={label}>Market</label>
            <select style={{ ...input, cursor: "pointer" }} value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <label style={label}>Competitors (optional — leave blank to auto-discover)</label>
          <textarea style={{ ...input, minHeight: 64, resize: "vertical" }} placeholder="semrush.com, surferseo.com, ahrefs.com" value={competitors} onChange={(e) => setCompetitors(e.target.value)} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
          <button onClick={run} disabled={loading} style={{ padding: "12px 28px", borderRadius: 12, border: "none", cursor: loading ? "default" : "pointer", fontSize: 14.5, fontWeight: 700, background: loading ? "rgba(16,185,129,0.4)" : colors.accent, color: "#06281D" }}>
            {loading ? "Compiling report…" : "Generate report"}
          </button>
          <span style={{ fontSize: 12, color: colors.textFaint }}>Runs all tools · ~$0.10–0.20 · 1–2 min</span>
        </div>
      </div>

      {error && <div style={{ marginTop: 16, padding: "12px 16px", borderRadius: 12, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#F87171", fontSize: 13.5 }}>{error}</div>}

      {loading && (
        <div style={{ marginTop: 18, fontSize: 13.5, color: colors.textMuted }}>
          Running spend spy, keyword gap, brand defense, landing X-ray + AI synthesis across your competitors…
        </div>
      )}

      {report && !loading && (
        <div style={{ marginTop: 20 }}>
          <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 16, padding: 22 }}>
            <MarkdownReport markdown={report.markdown} colors={colors} />
          </div>
          <div style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 10 }}>
            Compiled from DataForSEO + Oxylabs + Firecrawl + AI · {report.competitors.length} competitors · cost ${report.cost.toFixed(4)}
          </div>
        </div>
      )}
    </div>
  );
}
