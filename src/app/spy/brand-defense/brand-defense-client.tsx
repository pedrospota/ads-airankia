"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { useSpyBrand } from "@/components/spy-brand-context";
import { toDomain } from "@/lib/benchmark/page-fetch";
import { COUNTRIES } from "@/lib/benchmark/countries";

type Colors = ReturnType<typeof useTheme>["colors"];

interface Conquester {
  domain: string;
  headline: string | null;
  description: string | null;
  displayedUrl: string | null;
  url: string | null;
  position: number | null;
}
interface Threat {
  brandKeyword: string;
  conquesters: Conquester[];
}
interface Result {
  brandDomain: string;
  country: { code: string; name: string; flag: string };
  threats: Threat[];
  totalThreats: number;
  cost: number;
  source: string;
}

export function BrandDefenseClient({ configured }: { configured: boolean }) {
  const { colors } = useTheme();
  const [brandDomain, setBrandDomain] = useState("");
  const [brandName, setBrandName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { selected } = useSpyBrand();
  const appliedBrandRef = useRef<string | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Prefill brand domain + name from the selected brand — only when the brand id
  // actually changes (never on keystrokes). Manual (no brand) leaves fields as-is.
  useEffect(() => {
    const id = selected?.id ?? null;
    if (!id || id === appliedBrandRef.current) return;
    appliedBrandRef.current = id;
    if (selected?.website) {
      const d = toDomain(selected.website);
      if (d) setBrandDomain(d);
    }
    if (selected?.name) setBrandName(selected.name);
  }, [selected?.id]);

  const run = useCallback(async () => {
    const dom = brandDomain.trim();
    const name = brandName.trim();
    if (!dom && !name) {
      setError("Enter your brand domain or brand name.");
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const kwList = keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 3);
      const res = await fetch("/api/spy/brand-defense", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        signal: ac.signal,
        body: JSON.stringify({
          brandDomain: dom || undefined,
          brandName: name || undefined,
          keywords: kwList.length ? kwList : undefined,
          countryCode,
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
  }, [brandDomain, brandName, keywords, countryCode]);

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
        <h1 style={{ fontSize: 26, fontWeight: 800, color: colors.text, margin: 0 }}>🛡️ Brand Defense</h1>
        <SourceChip colors={colors} text="Data: Oxylabs" />
      </div>
      <p style={{ fontSize: 14, color: colors.textMuted, marginTop: 4, maxWidth: 660, lineHeight: 1.6 }}>
        See who is <strong style={{ color: colors.text }}>bidding on your brand</strong>. We run a live Google Ads
        search for your branded terms and surface every <strong style={{ color: colors.text }}>conquester</strong> —
        rivals poaching your brand-intent traffic — with their domain and ad copy. Your own ads are excluded.
      </p>

      {!configured && (
        <div style={banner("#FBBF24")}>Oxylabs isn&apos;t configured on the server — set OXYLABS_USERNAME / OXYLABS_PASSWORD.</div>
      )}

      {/* Config */}
      <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 16, padding: 20, marginTop: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
          <div>
            <label style={label}>Brand domain</label>
            <input style={input} placeholder="e.g. airankia.com" value={brandDomain}
              onChange={(e) => setBrandDomain(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
          </div>
          <div>
            <label style={label}>Brand name (optional)</label>
            <input style={input} placeholder="e.g. AirAnkia" value={brandName}
              onChange={(e) => setBrandName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
          </div>
          <div>
            <label style={label}>Branded keywords (optional · up to 3, comma-separated)</label>
            <input style={input} placeholder="auto — your brand name + variants" value={keywords}
              onChange={(e) => setKeywords(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
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
            {loading ? "Scanning…" : "Defend my brand"}
          </button>
          <span style={{ fontSize: 12, color: colors.textFaint }}>live Google Ads scrape · billed to Oxylabs</span>
        </div>
      </div>

      {error && <div style={banner("#F87171")}>{error}</div>}

      {result && !loading && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Summary */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
            <Stat colors={colors} accent value={String(result.totalThreats)} label="Conquesters found" sub="bidding on your brand" />
            <Stat colors={colors} value={String(result.threats.length)} label="Branded terms checked" sub={`${result.country.flag} ${result.country.name}`} />
            <Stat colors={colors} value={result.brandDomain} label="Protected brand" />
          </div>

          {result.totalThreats === 0 ? (
            <div style={{ background: "rgba(16,185,129,0.08)", border: `1px solid rgba(16,185,129,0.3)`, borderRadius: 14, padding: "20px 22px" }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: colors.accent, marginBottom: 4 }}>✅ Nobody is bidding on your brand — good.</div>
              <div style={{ fontSize: 13.5, color: colors.textMuted, lineHeight: 1.6 }}>
                We found no rival advertisers on your branded terms in {result.country.flag} {result.country.name}. Your brand SERP is clean. Re-run periodically — conquesters appear without warning.
              </div>
            </div>
          ) : (
            result.threats.map((t, i) => (
              <ThreatCard key={i} colors={colors} threat={t} />
            ))
          )}

          <div style={{ fontSize: 11.5, color: colors.textFaint }}>
            Source: <strong style={{ color: colors.textMuted }}>{result.source}</strong> · live Google Ads snapshot (intermittent) · cost ${result.cost.toFixed(4)}
          </div>
        </div>
      )}
    </div>
  );
}

function ThreatCard({ colors, threat }: { colors: Colors; threat: Threat }) {
  const clean = threat.conquesters.length === 0;
  return (
    <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: clean ? 0 : 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: colors.text }}>Branded term</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: colors.accent }}>“{threat.brandKeyword}”</span>
        <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, color: clean ? colors.accent : "#F87171" }}>
          {clean ? "no conquesters" : `${threat.conquesters.length} conquester${threat.conquesters.length > 1 ? "s" : ""}`}
        </span>
      </div>
      {clean ? (
        <div style={{ fontSize: 12.5, color: colors.textFaint, marginTop: 8 }}>No rival ads on this term — clean.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {threat.conquesters.map((c, i) => (
            <div key={i} style={{ border: `1px solid ${colors.border}`, borderRadius: 12, padding: "12px 14px", background: "rgba(248,113,113,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, color: "#F87171", background: "rgba(248,113,113,0.14)", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 999, padding: "1px 7px" }}>CONQUESTER</span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: colors.text }}>{c.domain}</span>
                {c.position != null && (
                  <span style={{ fontSize: 11, color: colors.textFaint }}>· ad position {c.position}</span>
                )}
              </div>
              {c.headline && (
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#60A5FA", marginTop: 8, lineHeight: 1.4 }}>{c.headline}</div>
              )}
              {c.description && (
                <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>{c.description}</div>
              )}
              {c.displayedUrl && (
                <div style={{ fontSize: 11.5, color: colors.accent, marginTop: 6 }}>{c.displayedUrl}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ colors, value, label, sub, accent }: { colors: Colors; value: string; label: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{ background: accent ? "rgba(16,185,129,0.08)" : colors.bgCard, border: `1px solid ${accent ? "rgba(16,185,129,0.3)" : colors.border}`, borderRadius: 14, padding: "16px 18px" }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent ? colors.accent : colors.text, lineHeight: 1.1, wordBreak: "break-word" }}>{value}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: colors.text, marginTop: 6 }}>{label}</div>
      {sub && <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 2 }}>{sub}</div>}
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
