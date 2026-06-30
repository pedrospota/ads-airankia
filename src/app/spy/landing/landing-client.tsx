"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";

type Colors = ReturnType<typeof useTheme>["colors"];

interface LandingSlice {
  domain: string;
  url: string;
  offer: string | null;
  pricing: string[] | null;
  primaryCta: string | null;
  valueProps: string[];
  socialProof: string[];
  funnelSteps: string[] | null;
  trackingStack: string[];
  adMessageMatch: "strong" | "partial" | "weak" | null;
  matchRationale: string | null;
}
interface Result {
  url: string;
  domain: string;
  title: string;
  slice: LandingSlice;
  scrape: { ok: boolean; provider: "firecrawl" | "fetch" | "none"; chars: number; creditsUsed: number };
  llm: { ran: boolean; model: string | null; error: string | null };
  llmError: string | null;
  cost: number;
  source: string;
}

const MATCH_META: Record<"strong" | "partial" | "weak", { label: string; color: string; emoji: string }> = {
  strong: { label: "Strong match", color: "#10B981", emoji: "✅" },
  partial: { label: "Partial match", color: "#FBBF24", emoji: "⚠️" },
  weak: { label: "Weak match", color: "#F87171", emoji: "🚫" },
};

export function LandingClient({ aiConfigured }: { aiConfigured: boolean }) {
  const { colors } = useTheme();
  const [url, setUrl] = useState("");
  const [adHeadline, setAdHeadline] = useState("");
  const [adDescription, setAdDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async () => {
    const u = url.trim();
    if (!u) {
      setError("Enter a competitor landing URL or domain (e.g. competitor.com/pricing).");
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/spy/landing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        signal: ac.signal,
        body: JSON.stringify({
          url: u,
          adHeadline: adHeadline.trim() || undefined,
          adDescription: adDescription.trim() || undefined,
        }),
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
  }, [url, adHeadline, adDescription]);

  const input: React.CSSProperties = {
    width: "100%", background: colors.bgInput, border: `1px solid ${colors.border}`,
    borderRadius: 10, color: colors.text, fontSize: 14, padding: "10px 12px", outline: "none",
  };
  const label: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
    color: colors.textMuted, marginBottom: 6, display: "block",
  };

  const slice = result?.slice;
  const match = slice?.adMessageMatch ? MATCH_META[slice.adMessageMatch] : null;

  return (
    <div style={{ maxWidth: 980 }}>
      {/* Hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: colors.text, margin: 0 }}>🔬 Landing X-Ray</h1>
        <SourceChip colors={colors} text="Firecrawl + AI" />
      </div>
      <p style={{ fontSize: 14, color: colors.textMuted, marginTop: 4, maxWidth: 660, lineHeight: 1.6 }}>
        Drop a competitor&apos;s landing URL to read its{" "}
        <strong style={{ color: colors.text }}>offer, pricing, CTA, value props, social proof</strong> and{" "}
        <strong style={{ color: colors.text }}>funnel</strong>, plus the{" "}
        <strong style={{ color: colors.text }}>tracking stack</strong> on the page. Paste the ad that drives the
        click and we&apos;ll judge the <strong style={{ color: colors.text }}>message match</strong>.
      </p>

      {!aiConfigured && (
        <div style={banner("#FBBF24")}>
          No OpenRouter key is set — scraping still works, but the AI teardown won&apos;t run until a key + model are configured in <strong>/admin</strong>.
        </div>
      )}

      {/* Config */}
      <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 16, padding: 20, marginTop: 16 }}>
        <div>
          <label style={label}>Competitor landing URL</label>
          <input style={input} placeholder="e.g. competitor.com/pricing" value={url}
            onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginTop: 14 }}>
          <div>
            <label style={label}>Ad headline (optional · for match)</label>
            <input style={input} placeholder="e.g. Cut your ad spend 30%" value={adHeadline}
              onChange={(e) => setAdHeadline(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
          </div>
          <div>
            <label style={label}>Ad description (optional · for match)</label>
            <input style={input} placeholder="e.g. AI optimizes your Google Ads daily." value={adDescription}
              onChange={(e) => setAdDescription(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
          <button onClick={run} disabled={loading}
            style={{ padding: "12px 28px", borderRadius: 12, border: "none", cursor: loading ? "default" : "pointer",
              fontSize: 14.5, fontWeight: 700, background: loading ? "rgba(16,185,129,0.4)" : colors.accent, color: "#06281D" }}>
            {loading ? "X-raying…" : "Run X-ray"}
          </button>
          <span style={{ fontSize: 12, color: colors.textFaint }}>scrape + 1 AI pass · billed to Firecrawl + OpenRouter</span>
        </div>
      </div>

      {error && <div style={banner("#F87171")}>{error}</div>}

      {result && slice && !loading && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Header line */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: colors.text }}>{result.domain || result.url}</span>
            {result.title && <span style={{ fontSize: 12.5, color: colors.textMuted }}>· {result.title}</span>}
            <span style={chip(colors)}>scraped via {result.scrape.provider}</span>
          </div>

          {/* If the AI pass didn't run, say why (page text still scraped). */}
          {result.llmError && (
            <div style={banner("#FBBF24")}>AI teardown didn&apos;t run: {result.llmError}</div>
          )}

          {/* Ad-match verdict */}
          {match && (
            <div style={{ background: `${match.color}14`, border: `1px solid ${match.color}55`, borderRadius: 14, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>{match.emoji}</span>
                <span style={{ fontSize: 15, fontWeight: 800, color: match.color }}>Ad → page: {match.label}</span>
              </div>
              {slice.matchRationale && (
                <p style={{ fontSize: 13.5, color: colors.text, marginTop: 8, marginBottom: 0, lineHeight: 1.6 }}>{slice.matchRationale}</p>
              )}
            </div>
          )}

          {/* Offer + CTA cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            <Card colors={colors} title="🎯 Offer" accent>
              <p style={{ margin: 0, fontSize: 14, color: colors.text, lineHeight: 1.55 }}>
                {slice.offer ?? <Muted colors={colors}>Not detected</Muted>}
              </p>
            </Card>
            <Card colors={colors} title="🟢 Primary CTA">
              <p style={{ margin: 0, fontSize: 14, color: colors.text }}>
                {slice.primaryCta ?? <Muted colors={colors}>Not detected</Muted>}
              </p>
            </Card>
          </div>

          {/* Pricing */}
          <Card colors={colors} title="💵 Pricing">
            {slice.pricing && slice.pricing.length ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {slice.pricing.map((p, i) => (
                  <span key={i} style={pill(colors, colors.accent)}>{p}</span>
                ))}
              </div>
            ) : (
              <Muted colors={colors}>No pricing shown on this page.</Muted>
            )}
          </Card>

          {/* Value props + social proof */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
            <Card colors={colors} title="✨ Value propositions">
              <BulletList colors={colors} items={slice.valueProps} empty="None detected." />
            </Card>
            <Card colors={colors} title="🏆 Social proof">
              <BulletList colors={colors} items={slice.socialProof} empty="None detected." />
            </Card>
          </div>

          {/* Funnel steps */}
          {slice.funnelSteps && slice.funnelSteps.length > 0 && (
            <Card colors={colors} title="🪜 Funnel steps">
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                {slice.funnelSteps.map((s, i) => (
                  <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={pill(colors, colors.textMuted)}>{i + 1}. {s}</span>
                    {i < slice.funnelSteps!.length - 1 && <span style={{ color: colors.textFaint }}>→</span>}
                  </span>
                ))}
              </div>
            </Card>
          )}

          {/* Tracking stack */}
          <Card colors={colors} title="📡 Tracking & marketing stack">
            {slice.trackingStack.length ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {slice.trackingStack.map((t, i) => (
                  <span key={i} style={pill(colors, "#60A5FA")}>{t}</span>
                ))}
              </div>
            ) : (
              <Muted colors={colors}>No common pixels/tags detected in the page markup.</Muted>
            )}
          </Card>

          <div style={{ fontSize: 11.5, color: colors.textFaint }}>
            Source: <strong style={{ color: colors.textMuted }}>{result.source}</strong>
            {result.llm.model ? <> · model <strong style={{ color: colors.textMuted }}>{result.llm.model}</strong></> : null}
            {" "}· cost ${result.cost.toFixed(4)} · estimates are AI-extracted from the live page
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ colors, title, children, accent }: { colors: Colors; title: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <div style={{
      background: accent ? "rgba(16,185,129,0.08)" : colors.bgCard,
      border: `1px solid ${accent ? "rgba(16,185,129,0.3)" : colors.border}`,
      borderRadius: 14, padding: 16,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: colors.text, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function BulletList({ colors, items, empty }: { colors: Colors; items: string[]; empty: string }) {
  if (!items.length) return <Muted colors={colors}>{empty}</Muted>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((it, i) => (
        <li key={i} style={{ fontSize: 13.5, color: colors.text, lineHeight: 1.5 }}>{it}</li>
      ))}
    </ul>
  );
}

function Muted({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return <span style={{ fontSize: 13, color: colors.textFaint }}>{children}</span>;
}

function pill(colors: Colors, color: string): React.CSSProperties {
  return {
    fontSize: 12.5, fontWeight: 600, color,
    background: `${color}1a`, border: `1px solid ${color}44`,
    borderRadius: 999, padding: "4px 11px", whiteSpace: "nowrap",
  };
}

function chip(colors: Colors): React.CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, color: colors.textMuted,
    background: colors.bgInput, border: `1px solid ${colors.border}`,
    borderRadius: 999, padding: "2px 9px",
  };
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
