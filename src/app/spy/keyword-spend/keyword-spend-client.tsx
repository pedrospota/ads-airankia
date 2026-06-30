"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { COUNTRIES } from "@/lib/benchmark/countries";

type Colors = ReturnType<typeof useTheme>["colors"];

interface PaidKeyword {
  keyword: string;
  volume: number;
  cpc: number | null;
  position: number | null;
  etv: number;
}
interface SpendData {
  domain: string;
  estimatedMonthlySpend: number;
  paidKeywords: number;
  estimatedPaidTraffic: number;
  positions: { top: number; pos2to3: number; pos4to10: number; lower: number };
}
interface Result {
  domain: string;
  country: { code: string; name: string; flag: string };
  spend: SpendData | null;
  keywords: PaidKeyword[];
  totalPaidKeywords: number;
  gap: { brandDomain: string; shared: PaidKeyword[]; steal: PaidKeyword[]; defend: number } | null;
  cost: number;
  source: string;
}

const fmt = (n: number) => Math.round(Math.max(0, n)).toLocaleString("en-US");
const money = (n: number) => "$" + Math.round(Math.max(0, n)).toLocaleString("en-US");

export function KeywordSpendClient({ configured }: { configured: boolean }) {
  const { colors } = useTheme();
  const [domain, setDomain] = useState("");
  const [brandDomain, setBrandDomain] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async () => {
    const d = domain.trim();
    if (!d) {
      setError("Enter a competitor domain (e.g. semrush.com).");
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/spy/keyword-spend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        signal: ac.signal,
        body: JSON.stringify({ domain: d, brandDomain: brandDomain.trim() || undefined, countryCode }),
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
  }, [domain, brandDomain, countryCode]);

  const input: React.CSSProperties = {
    width: "100%", background: colors.bgInput, border: `1px solid ${colors.border}`,
    borderRadius: 10, color: colors.text, fontSize: 14, padding: "10px 12px", outline: "none",
  };
  const label: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
    color: colors.textMuted, marginBottom: 6, display: "block",
  };

  return (
    <div style={{ maxWidth: 980 }}>
      {/* Hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: colors.text, margin: 0 }}>💰 Keyword &amp; Spend Spy</h1>
        <SourceChip colors={colors} text="Data: DataForSEO Labs" />
      </div>
      <p style={{ fontSize: 14, color: colors.textMuted, marginTop: 4, maxWidth: 640, lineHeight: 1.6 }}>
        Drop a competitor domain to see its estimated <strong style={{ color: colors.text }}>monthly Google Ads spend</strong>,
        the <strong style={{ color: colors.text }}>paid keywords it bids on</strong> (volume, CPC, position), and — if you add
        your domain — the <strong style={{ color: colors.text }}>keyword gap</strong> (what to steal vs defend).
      </p>

      {!configured && (
        <div style={banner("#FBBF24")}>DataForSEO isn&apos;t configured on the server — set DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD.</div>
      )}

      {/* Config */}
      <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 16, padding: 20, marginTop: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
          <div>
            <label style={label}>Competitor domain</label>
            <input style={input} placeholder="e.g. semrush.com" value={domain}
              onChange={(e) => setDomain(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
          </div>
          <div>
            <label style={label}>Your domain (optional · for the gap)</label>
            <input style={input} placeholder="e.g. airankia.com" value={brandDomain}
              onChange={(e) => setBrandDomain(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
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
            {loading ? "Analyzing…" : "Run spy"}
          </button>
          <span style={{ fontSize: 12, color: colors.textFaint }}>~$0.02–0.03 per run · billed to DataForSEO</span>
        </div>
      </div>

      {error && <div style={banner("#F87171")}>{error}</div>}

      {result && !loading && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Spend cards */}
          {result.spend && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
              <Stat colors={colors} accent value={result.spend.estimatedMonthlySpend > 0 ? money(result.spend.estimatedMonthlySpend) : "—"} label="Est. monthly ad spend" sub={`${result.country.flag} ${result.country.name}`} />
              <Stat colors={colors} value={fmt(result.totalPaidKeywords)} label="Paid keywords" sub="they bid on" />
              <Stat colors={colors} value={fmt(result.spend.estimatedPaidTraffic)} label="Est. monthly paid clicks" />
              <Stat colors={colors} value={`${result.spend.positions.top} / ${result.spend.positions.pos2to3}`} label="Top vs #2–3 positions" sub="position mix" />
            </div>
          )}

          {/* Gap summary */}
          {result.gap && (
            <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: colors.text, marginBottom: 10 }}>
                Keyword gap vs <span style={{ color: colors.accent }}>{result.gap.brandDomain}</span>
              </div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                <GapStat colors={colors} n={result.gap.steal.length} label="🔥 To steal" hint="they bid, you don't" color="#F87171" />
                <GapStat colors={colors} n={result.gap.shared.length} label="⚔️ Shared" hint="you both bid" color="#FBBF24" />
                <GapStat colors={colors} n={result.gap.defend} label="🛡️ You defend" hint="only you bid" color={colors.accent} />
              </div>
            </div>
          )}

          {/* Keyword table */}
          <KeywordTable colors={colors} keywords={result.keywords} gapSteal={result.gap ? new Set(result.gap.steal.map((k) => k.keyword)) : null} />

          <div style={{ fontSize: 11.5, color: colors.textFaint }}>
            Source: <strong style={{ color: colors.textMuted }}>{result.source}</strong> · estimates are directional (model-based) · cost ${result.cost.toFixed(4)}
          </div>
        </div>
      )}
    </div>
  );
}

function KeywordTable({ colors, keywords, gapSteal }: { colors: Colors; keywords: PaidKeyword[]; gapSteal: Set<string> | null }) {
  if (!keywords.length) {
    return <div style={{ fontSize: 13, color: colors.textFaint, padding: "8px 2px" }}>No paid keywords found for this domain in this market.</div>;
  }
  const th: React.CSSProperties = { textAlign: "left", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: colors.textMuted, padding: "0 12px 10px", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: 12, borderTop: `1px solid ${colors.border}`, fontSize: 13, color: colors.text, verticalAlign: "middle" };
  return (
    <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: colors.text, marginBottom: 10 }}>Paid keywords (top {keywords.length} by traffic)</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
          <thead>
            <tr>
              <th style={th}>Keyword</th>
              <th style={{ ...th, textAlign: "right" }}>Volume</th>
              <th style={{ ...th, textAlign: "right" }}>CPC</th>
              <th style={{ ...th, textAlign: "right" }}>Position</th>
              <th style={{ ...th, textAlign: "right" }}>Est. clicks</th>
            </tr>
          </thead>
          <tbody>
            {keywords.map((k, i) => (
              <tr key={i}>
                <td style={td}>
                  {k.keyword}
                  {gapSteal?.has(k.keyword) && (
                    <span style={{ marginLeft: 8, fontSize: 9.5, fontWeight: 700, color: "#F87171", background: "rgba(248,113,113,0.14)", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 999, padding: "1px 6px" }}>STEAL</span>
                  )}
                </td>
                <td style={{ ...td, textAlign: "right" }}>{fmt(k.volume)}</td>
                <td style={{ ...td, textAlign: "right" }}>{k.cpc != null ? "$" + k.cpc.toFixed(2) : "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>{k.position ?? "—"}</td>
                <td style={{ ...td, textAlign: "right", color: colors.textMuted }}>{fmt(k.etv)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ colors, value, label, sub, accent }: { colors: Colors; value: string; label: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{ background: accent ? "rgba(16,185,129,0.08)" : colors.bgCard, border: `1px solid ${accent ? "rgba(16,185,129,0.3)" : colors.border}`, borderRadius: 14, padding: "16px 18px" }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent ? colors.accent : colors.text, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: colors.text, marginTop: 6 }}>{label}</div>
      {sub && <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function GapStat({ colors, n, label, hint, color }: { colors: Colors; n: number; label: string; hint: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 800, color }}>{fmt(n)}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: colors.text }}>{label}</div>
      <div style={{ fontSize: 11, color: colors.textFaint }}>{hint}</div>
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
