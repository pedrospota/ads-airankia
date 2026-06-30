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
interface DomainMetrics {
  domain: string;
  monthlySpend: number;
  paidKeywords: number;
  clicks: number;
  avgCpc: number | null;
  avgPosition: number | null;
  positions: { top: number; pos2to3: number; pos4to10: number; lower: number };
}
interface SharedKeyword {
  keyword: string;
  volume: number;
  theirCpc: number | null;
  theirPosition: number | null;
  theirEtv: number;
  yourCpc: number | null;
  yourPosition: number | null;
  yourEtv: number;
}
interface Result {
  domain: string;
  country: { code: string; name: string; flag: string };
  spend: SpendData | null;
  keywords: PaidKeyword[];
  totalPaidKeywords: number;
  brandSpend: SpendData | null;
  comparison: { brand: DomainMetrics; competitor: DomainMetrics } | null;
  gap: {
    brandDomain: string;
    steal: PaidKeyword[];
    shared: SharedKeyword[];
    defend: PaidKeyword[];
    defendCount: number;
  } | null;
  cost: number;
  source: string;
}

const fmt = (n: number) => Math.round(Math.max(0, n)).toLocaleString("en-US");
const money = (n: number) => "$" + Math.round(Math.max(0, n)).toLocaleString("en-US");
const cpcFmt = (c: number | null) => (c != null && c > 0 ? "$" + c.toFixed(2) : "—");
const posFmt = (p: number | null) => (p != null ? String(p) : "—");
const avgPosFmt = (p: number | null) => (p != null ? p.toFixed(1) : "—");

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

  const hasBrand = brandDomain.trim().length > 0;

  return (
    <div style={{ maxWidth: 980 }}>
      {/* Hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: colors.text, margin: 0 }}>💰 Keyword &amp; Spend Spy</h1>
        <SourceChip colors={colors} text="Data: DataForSEO Labs" />
      </div>
      <p style={{ fontSize: 14, color: colors.textMuted, marginTop: 4, maxWidth: 660, lineHeight: 1.6 }}>
        Drop a competitor domain to see its estimated <strong style={{ color: colors.text }}>monthly Google Ads spend</strong>,
        the <strong style={{ color: colors.text }}>paid keywords it bids on</strong> (volume, CPC, position), and — if you add
        your domain — a <strong style={{ color: colors.text }}>side-by-side you-vs-them comparison</strong> plus the full
        <strong style={{ color: colors.text }}> keyword gap</strong> (what to steal, where you overlap, and what to defend).
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
            <label style={label}>Your domain (optional · for the comparison)</label>
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
          <span style={{ fontSize: 12, color: colors.textFaint }}>
            {hasBrand ? "~$0.04–0.05 per run (4 calls)" : "~$0.02–0.03 per run"} · billed to DataForSEO
          </span>
        </div>
      </div>

      {error && <div style={banner("#F87171")}>{error}</div>}

      {result && !loading && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Competitor spend cards */}
          {result.spend && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
              <Stat colors={colors} accent value={result.spend.estimatedMonthlySpend > 0 ? money(result.spend.estimatedMonthlySpend) : "—"} label="Est. monthly ad spend" sub={`${result.domain} · ${result.country.flag} ${result.country.name}`} />
              <Stat colors={colors} value={fmt(result.totalPaidKeywords)} label="Paid keywords" sub="they bid on" />
              <Stat colors={colors} value={fmt(result.spend.estimatedPaidTraffic)} label="Est. monthly paid clicks" />
              <Stat colors={colors} value={`${result.spend.positions.top} / ${result.spend.positions.pos2to3}`} label="Top vs #2–3 positions" sub="position mix" />
            </div>
          )}

          {/* You vs Them comparison panel (only when a brand domain was supplied) */}
          {result.comparison && (
            <ComparisonPanel colors={colors} comparison={result.comparison} />
          )}

          {/* Gap summary counts */}
          {result.gap && (
            <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: colors.text, marginBottom: 10 }}>
                Keyword gap · <span style={{ color: colors.accent }}>{result.gap.brandDomain}</span> vs <span style={{ color: colors.text }}>{result.domain}</span>
              </div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                <GapStat colors={colors} n={result.gap.steal.length} label="🔥 To steal" hint="they bid, you don't" color="#F87171" />
                <GapStat colors={colors} n={result.gap.shared.length} label="⚔️ Shared" hint="you both bid" color="#FBBF24" />
                <GapStat colors={colors} n={result.gap.defendCount} label="🛡️ You defend" hint="only you bid" color={colors.accent} />
              </div>
            </div>
          )}

          {/* Gap detail — three stacked sections, OR fall back to the single competitor table */}
          {result.gap ? (
            <>
              <PaidKeywordSection
                colors={colors}
                emoji="🔥"
                title="To steal"
                hint="they bid, you don't — easy wins to take"
                color="#F87171"
                keywords={result.gap.steal}
                positionLabel="Their position"
              />
              <SharedSection colors={colors} keywords={result.gap.shared} brandDomain={result.gap.brandDomain} competitorDomain={result.domain} />
              <PaidKeywordSection
                colors={colors}
                emoji="🛡️"
                title="You defend"
                hint="only you bid — protect these"
                color={colors.accent}
                keywords={result.gap.defend}
                positionLabel="Your position"
                footer={result.gap.defendCount > result.gap.defend.length
                  ? `Showing top ${result.gap.defend.length} of ${fmt(result.gap.defendCount)} by traffic`
                  : undefined}
              />
            </>
          ) : (
            <KeywordTable colors={colors} keywords={result.keywords} />
          )}

          <div style={{ fontSize: 11.5, color: colors.textFaint }}>
            Source: <strong style={{ color: colors.textMuted }}>{result.source}</strong> · estimates are directional (model-based) · cost ${result.cost.toFixed(4)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── You vs Them comparison ──────────────────────────────────────────────── */

function ComparisonPanel({ colors, comparison }: { colors: Colors; comparison: { brand: DomainMetrics; competitor: DomainMetrics } }) {
  const { brand, competitor } = comparison;
  const rows: { label: string; hint?: string; you: string; them: string }[] = [
    { label: "Monthly spend", you: brand.monthlySpend > 0 ? money(brand.monthlySpend) : "—", them: competitor.monthlySpend > 0 ? money(competitor.monthlySpend) : "—" },
    { label: "Paid keywords", you: fmt(brand.paidKeywords), them: fmt(competitor.paidKeywords) },
    { label: "Est. monthly clicks", you: fmt(brand.clicks), them: fmt(competitor.clicks) },
    { label: "Avg CPC", you: cpcFmt(brand.avgCpc), them: cpcFmt(competitor.avgCpc) },
    { label: "Avg position", hint: "lower is better", you: avgPosFmt(brand.avgPosition), them: avgPosFmt(competitor.avgPosition) },
  ];
  const th: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: colors.textMuted, padding: "0 14px 12px", whiteSpace: "nowrap" };
  const tdLabel: React.CSSProperties = { padding: "12px 14px", borderTop: `1px solid ${colors.border}`, fontSize: 13, color: colors.text, fontWeight: 600, whiteSpace: "nowrap" };
  const tdVal: React.CSSProperties = { padding: "12px 14px", borderTop: `1px solid ${colors.border}`, fontSize: 14, textAlign: "right", whiteSpace: "nowrap" };
  const youBg = "rgba(16,185,129,0.06)";

  return (
    <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: colors.text, marginBottom: 4 }}>⚖️ You vs Them</div>
      <div style={{ fontSize: 12, color: colors.textFaint, marginBottom: 10 }}>Head-to-head paid-search footprint.</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>Metric</th>
              <th style={{ ...th, textAlign: "right", color: colors.accent }}>{brand.domain} <span style={{ fontWeight: 600 }}>(you)</span></th>
              <th style={{ ...th, textAlign: "right" }}>{competitor.domain}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td style={tdLabel}>
                  {r.label}
                  {r.hint && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 500, color: colors.textFaint }}>· {r.hint}</span>}
                </td>
                <td style={{ ...tdVal, background: youBg, color: colors.accent, fontWeight: 700 }}>{r.you}</td>
                <td style={{ ...tdVal, color: colors.text, fontWeight: 600 }}>{r.them}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Steal / Defend section (single-side keyword list) ───────────────────── */

function PaidKeywordSection({
  colors, emoji, title, hint, color, keywords, positionLabel, footer,
}: {
  colors: Colors; emoji: string; title: string; hint: string; color: string;
  keywords: PaidKeyword[]; positionLabel: string; footer?: string;
}) {
  const th: React.CSSProperties = { textAlign: "left", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: colors.textMuted, padding: "0 12px 10px", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: 12, borderTop: `1px solid ${colors.border}`, fontSize: 13, color: colors.text, verticalAlign: "middle" };
  return (
    <SectionCard colors={colors} emoji={emoji} title={title} hint={hint} count={keywords.length} color={color}>
      {keywords.length === 0 ? (
        <div style={{ fontSize: 13, color: colors.textFaint, padding: "4px 2px" }}>None in this market.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
            <thead>
              <tr>
                <th style={th}>Keyword</th>
                <th style={{ ...th, textAlign: "right" }}>Volume</th>
                <th style={{ ...th, textAlign: "right" }}>CPC</th>
                <th style={{ ...th, textAlign: "right" }}>{positionLabel}</th>
                <th style={{ ...th, textAlign: "right" }}>Est. clicks</th>
              </tr>
            </thead>
            <tbody>
              {keywords.map((k, i) => (
                <tr key={i}>
                  <td style={td}>{k.keyword}</td>
                  <td style={{ ...td, textAlign: "right" }}>{fmt(k.volume)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{cpcFmt(k.cpc)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{posFmt(k.position)}</td>
                  <td style={{ ...td, textAlign: "right", color: colors.textMuted }}>{fmt(k.etv)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {footer && <div style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 10 }}>{footer}</div>}
    </SectionCard>
  );
}

/* ── Shared section (you vs them, per keyword) ───────────────────────────── */

function SharedSection({ colors, keywords, brandDomain, competitorDomain }: { colors: Colors; keywords: SharedKeyword[]; brandDomain: string; competitorDomain: string }) {
  const th: React.CSSProperties = { textAlign: "left", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: colors.textMuted, padding: "0 12px 10px", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: 12, borderTop: `1px solid ${colors.border}`, fontSize: 13, color: colors.text, verticalAlign: "middle" };
  return (
    <SectionCard
      colors={colors}
      emoji="⚔️"
      title="Shared"
      hint={`you both bid · ${brandDomain} vs ${competitorDomain}`}
      count={keywords.length}
      color="#FBBF24"
    >
      {keywords.length === 0 ? (
        <div style={{ fontSize: 13, color: colors.textFaint, padding: "4px 2px" }}>No overlapping keywords in this market.</div>
      ) : (
        <>
          <div style={{ fontSize: 11.5, color: colors.textFaint, marginBottom: 8 }}>
            <span style={{ color: colors.accent, fontWeight: 700 }}>green</span> = better (lower) paid position.
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
              <thead>
                <tr>
                  <th style={th}>Keyword</th>
                  <th style={{ ...th, textAlign: "right" }}>Volume</th>
                  <th style={{ ...th, textAlign: "right" }}>Your CPC</th>
                  <th style={{ ...th, textAlign: "right" }}>Their CPC</th>
                  <th style={{ ...th, textAlign: "right" }}>Your pos</th>
                  <th style={{ ...th, textAlign: "right" }}>Their pos</th>
                </tr>
              </thead>
              <tbody>
                {keywords.map((k, i) => {
                  const youWin = k.yourPosition != null && (k.theirPosition == null || k.yourPosition < k.theirPosition);
                  const themWin = k.theirPosition != null && (k.yourPosition == null || k.theirPosition < k.yourPosition);
                  return (
                    <tr key={i}>
                      <td style={td}>{k.keyword}</td>
                      <td style={{ ...td, textAlign: "right" }}>{fmt(k.volume)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{cpcFmt(k.yourCpc)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{cpcFmt(k.theirCpc)}</td>
                      <td style={{ ...td, textAlign: "right", color: youWin ? colors.accent : colors.text, fontWeight: youWin ? 700 : 400 }}>{posFmt(k.yourPosition)}</td>
                      <td style={{ ...td, textAlign: "right", color: themWin ? colors.accent : colors.text, fontWeight: themWin ? 700 : 400 }}>{posFmt(k.theirPosition)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

/* ── Shared section card chrome ──────────────────────────────────────────── */

function SectionCard({ colors, emoji, title, hint, count, color, children }: {
  colors: Colors; emoji: string; title: string; hint: string; count: number; color: string; children: React.ReactNode;
}) {
  return (
    <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.text }}>{emoji} {title}</div>
        <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}22`, border: `1px solid ${color}55`, borderRadius: 999, padding: "1px 8px" }}>{fmt(count)}</span>
        <span style={{ fontSize: 11.5, color: colors.textFaint }}>{hint}</span>
      </div>
      {children}
    </div>
  );
}

/* ── Single-domain fallback (no brand domain supplied) ───────────────────── */

function KeywordTable({ colors, keywords }: { colors: Colors; keywords: PaidKeyword[] }) {
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
                <td style={td}>{k.keyword}</td>
                <td style={{ ...td, textAlign: "right" }}>{fmt(k.volume)}</td>
                <td style={{ ...td, textAlign: "right" }}>{cpcFmt(k.cpc)}</td>
                <td style={{ ...td, textAlign: "right" }}>{posFmt(k.position)}</td>
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
