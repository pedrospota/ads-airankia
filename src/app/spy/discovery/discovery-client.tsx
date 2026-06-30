"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { COUNTRIES } from "@/lib/benchmark/countries";

type Colors = ReturnType<typeof useTheme>["colors"];

interface Suggested {
  domain: string;
  intersections: number;
  avgPosition: number | null;
}
interface Result {
  domain: string;
  country: { code: string; name: string; flag: string };
  suggested: Suggested[];
  cost: number;
  source: string;
}

const fmt = (n: number) => Math.round(Math.max(0, n)).toLocaleString("en-US");

export function DiscoveryClient({ configured }: { configured: boolean }) {
  const { colors } = useTheme();
  const [domain, setDomain] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async () => {
    const d = domain.trim();
    if (!d) {
      setError("Enter your brand domain (e.g. airankia.com).");
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/spy/discovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        signal: ac.signal,
        body: JSON.stringify({ domain: d, countryCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setResult(data as Result);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      if (abortRef.current === ac) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  }, [domain, countryCode]);

  const copyAll = useCallback(() => {
    if (!result?.suggested.length) return;
    const text = result.suggested.map((s) => s.domain).join("\n");
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [result]);

  const input: React.CSSProperties = {
    width: "100%", background: colors.bgInput, border: `1px solid ${colors.border}`,
    borderRadius: 10, color: colors.text, fontSize: 14, padding: "10px 12px", outline: "none",
  };
  const label: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
    color: colors.textMuted, marginBottom: 6, display: "block",
  };

  const maxOverlap = result?.suggested.reduce((m, s) => Math.max(m, s.intersections), 0) ?? 0;

  return (
    <div style={{ maxWidth: 980 }}>
      {/* Hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: colors.text, margin: 0 }}>🔍 Competitor Discovery</h1>
        <SourceChip colors={colors} text="Data: DataForSEO Labs" />
      </div>
      <p style={{ fontSize: 14, color: colors.textMuted, marginTop: 4, maxWidth: 640, lineHeight: 1.6 }}>
        Drop your domain to find the rivals that compete for the <strong style={{ color: colors.text }}>same Google keywords</strong> —
        ranked by <strong style={{ color: colors.text }}>keyword overlap</strong>. Surfaces competitors you never listed, ready to
        drop into the benchmark.
      </p>

      {!configured && (
        <div style={banner("#FBBF24")}>DataForSEO isn&apos;t configured on the server — set DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD.</div>
      )}

      {/* Config */}
      <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 16, padding: 20, marginTop: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          <div>
            <label style={label}>Your brand domain</label>
            <input style={input} placeholder="e.g. airankia.com" value={domain}
              onChange={(e) => setDomain(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
          </div>
          <div>
            <label style={label}>Market</label>
            <select style={{ ...input, cursor: "pointer" }} value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
          <button onClick={run} disabled={loading || !configured}
            style={{ padding: "12px 28px", borderRadius: 12, border: "none", cursor: loading ? "default" : "pointer",
              fontSize: 14.5, fontWeight: 700, background: loading ? "rgba(16,185,129,0.4)" : colors.accent, color: "#06281D" }}>
            {loading ? "Discovering…" : "Find competitors"}
          </button>
          <span style={{ fontSize: 12, color: colors.textFaint }}>~$0.01 per run · billed to DataForSEO</span>
        </div>
      </div>

      {error && <div style={banner("#F87171")}>{error}</div>}

      {result && !loading && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: colors.text }}>
                {result.suggested.length} rivals of <span style={{ color: colors.accent }}>{result.domain}</span> · {result.country.flag} {result.country.name}
              </div>
              {result.suggested.length > 0 && (
                <button onClick={copyAll}
                  style={{ padding: "7px 14px", borderRadius: 10, border: `1px solid ${colors.border}`, cursor: "pointer",
                    fontSize: 12.5, fontWeight: 700, background: "transparent", color: copied ? colors.accent : colors.text }}>
                  {copied ? "✓ Copied" : "Copy all → benchmark"}
                </button>
              )}
            </div>

            {result.suggested.length === 0 ? (
              <div style={{ fontSize: 13, color: colors.textFaint, padding: "8px 2px" }}>
                No overlapping competitors found for this domain in this market.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {result.suggested.map((s, i) => {
                  const pct = maxOverlap > 0 ? Math.max(4, Math.round((s.intersections / maxOverlap) * 100)) : 0;
                  return (
                    <div key={s.domain} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 4px", borderTop: i === 0 ? "none" : `1px solid ${colors.border}` }}>
                      <div style={{ width: 22, fontSize: 12, fontWeight: 700, color: colors.textFaint, textAlign: "right" }}>{i + 1}</div>
                      <div style={{ flex: "0 0 200px", fontSize: 14, fontWeight: 600, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.domain}</div>
                      <div style={{ flex: 1, minWidth: 80, height: 8, background: colors.bgInput, borderRadius: 999, overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: colors.accent, borderRadius: 999 }} />
                      </div>
                      <div style={{ flex: "0 0 130px", textAlign: "right", fontSize: 12.5, color: colors.textMuted }}>
                        <strong style={{ color: colors.text }}>{fmt(s.intersections)}</strong> shared kw
                      </div>
                      <div style={{ flex: "0 0 90px", textAlign: "right", fontSize: 12, color: colors.textFaint }}>
                        {s.avgPosition != null ? `avg #${s.avgPosition.toFixed(1)}` : "—"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ fontSize: 11.5, color: colors.textFaint }}>
            Source: <strong style={{ color: colors.textMuted }}>{result.source}</strong> · overlap = shared organic keywords (model-based) · cost ${result.cost.toFixed(4)}
          </div>
        </div>
      )}
    </div>
  );
}

function SourceChip({ colors, text }: { colors: Colors; text: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: colors.accent, background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 999, padding: "3px 9px" }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: colors.accent }} />{text}
    </span>
  );
}

function banner(color: string): React.CSSProperties {
  return { marginTop: 16, padding: "12px 16px", borderRadius: 12, background: `${color}1a`, border: `1px solid ${color}55`, color, fontSize: 13.5 };
}
