"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { useSpyBrand } from "@/components/spy-brand-context";
import { toDomain } from "@/lib/benchmark/page-fetch";
import { COUNTRIES } from "@/lib/benchmark/countries";

type Colors = ReturnType<typeof useTheme>["colors"];

interface Advertiser {
  domain: string;
  keywordsBidOn: number;
  keywords: string[];
  sampleHeadline: string | null;
  sampleUrl: string | null;
  bestPosition: number | null;
}
interface Result {
  brandDomain: string | null;
  country: { code: string; name: string; flag: string };
  advertisers: Advertiser[];
  keywordsProbed: string[];
  cost: number;
  source: string;
}

const fmt = (n: number) => Math.round(Math.max(0, n)).toLocaleString("en-US");

export function DiscoveryClient({ configured }: { configured: boolean }) {
  const { colors } = useTheme();
  const [brandDomain, setBrandDomain] = useState("");
  const [keywords, setKeywords] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { selected } = useSpyBrand();
  const appliedBrandRef = useRef<string | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Prefill the brand domain from the selected brand — only when the brand id
  // actually changes (never on keystrokes). Manual mode leaves the field as-is.
  useEffect(() => {
    const id = selected?.id ?? null;
    if (!id || id === appliedBrandRef.current) return;
    appliedBrandRef.current = id;
    if (selected?.website) {
      const d = toDomain(selected.website);
      if (d) setBrandDomain(d);
    }
  }, [selected?.id]);

  const run = useCallback(async () => {
    const d = brandDomain.trim();
    const kws = keywords.split(",").map((k) => k.trim()).filter(Boolean);
    if (!d && kws.length === 0) {
      setError("Enter your brand domain or a few seed keywords.");
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
        body: JSON.stringify({ brandDomain: d || undefined, keywords: kws, countryCode }),
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
  }, [brandDomain, keywords, countryCode]);

  const copyAll = useCallback(() => {
    if (!result?.advertisers.length) return;
    const text = result.advertisers.map((a) => a.domain).join("\n");
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

  const probedCount = result?.keywordsProbed.length ?? 0;

  return (
    <div style={{ maxWidth: 980 }}>
      {/* Hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: colors.text, margin: 0 }}>🎯 Competitor Discovery</h1>
        <SourceChip colors={colors} text="Data: Oxylabs (live Google Ads)" />
      </div>
      <p style={{ fontSize: 14, color: colors.textMuted, marginTop: 4, maxWidth: 680, lineHeight: 1.6 }}>
        Find the domains that <strong style={{ color: colors.text }}>actually run Google Ads on your keywords</strong> — the
        real paid rivals bidding against you <strong style={{ color: colors.text }}>right now</strong>, not organic look-alikes.
        We probe your keywords through a live Google Ads scrape and rank every advertiser by how many of your keywords they bid on.
        No competitor list needed — we surface them for you.
      </p>

      {!configured && (
        <div style={banner("#FBBF24")}>Oxylabs isn&apos;t configured on the server — set OXYLABS_USERNAME / OXYLABS_PASSWORD.</div>
      )}

      {/* Config */}
      <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 16, padding: 20, marginTop: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          <div>
            <label style={label}>Your brand domain</label>
            <input style={input} placeholder="e.g. airankia.com" value={brandDomain}
              onChange={(e) => setBrandDomain(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
            <div style={{ fontSize: 10.5, color: colors.textFaint, marginTop: 6 }}>
              We seed the probe from your own paid keywords.
            </div>
          </div>
          <div>
            <label style={label}>Seed keywords (comma-separated, optional)</label>
            <input style={input} placeholder="e.g. ai seo tool, rank tracker" value={keywords}
              onChange={(e) => setKeywords(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
            <div style={{ fontSize: 10.5, color: colors.textFaint, marginTop: 6 }}>
              Provide these to probe exact keywords instead of auto-seeding.
            </div>
          </div>
          <div>
            <label style={label}>Market</label>
            <select style={{ ...input, cursor: "pointer" }} value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16, flexWrap: "wrap" }}>
          <button onClick={run} disabled={loading || !configured}
            style={{ padding: "12px 28px", borderRadius: 12, border: "none", cursor: loading ? "default" : "pointer",
              fontSize: 14.5, fontWeight: 700, background: loading ? "rgba(16,185,129,0.4)" : colors.accent, color: "#06281D" }}>
            {loading ? "Scanning live ads…" : "Find who's bidding"}
          </button>
          <span style={{ fontSize: 12, color: colors.textFaint }}>Live paid scrape · ~$0.03–0.05 per run · billed to Oxylabs</span>
        </div>
      </div>

      {error && <div style={banner("#F87171")}>{error}</div>}

      {result && !loading && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Header stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            <Stat colors={colors} accent value={fmt(result.advertisers.length)}
              label="Advertisers found"
              sub={`bidding on your keywords · ${result.country.flag} ${result.country.name}`} />
            <Stat colors={colors} value={fmt(probedCount)} label="Keywords probed"
              sub={result.brandDomain ? result.brandDomain : "from seed keywords"} />
          </div>

          {/* Probed keywords */}
          {result.keywordsProbed.length > 0 && (
            <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: colors.textMuted, marginBottom: 10 }}>
                Keywords probed
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {result.keywordsProbed.map((k) => (
                  <span key={k} style={chip(colors)}>{k}</span>
                ))}
              </div>
            </div>
          )}

          {/* Advertisers */}
          <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: colors.text }}>
                {result.advertisers.length} advertiser{result.advertisers.length === 1 ? "" : "s"} bidding on your keywords
              </div>
              {result.advertisers.length > 0 && (
                <button onClick={copyAll}
                  style={{ padding: "7px 14px", borderRadius: 10, border: `1px solid ${colors.border}`, cursor: "pointer",
                    fontSize: 12.5, fontWeight: 700, background: "transparent", color: copied ? colors.accent : colors.text }}>
                  {copied ? "✓ Copied" : "Copy all → benchmark"}
                </button>
              )}
            </div>

            {result.advertisers.length === 0 ? (
              <div style={{ fontSize: 13, color: colors.textFaint, padding: "8px 2px" }}>
                No competitors are bidding on these keywords right now.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {result.advertisers.map((a, i) => (
                  <AdvertiserRow key={a.domain} colors={colors} rank={i + 1} adv={a} probedCount={probedCount} />
                ))}
              </div>
            )}
          </div>

          <div style={{ fontSize: 11.5, color: colors.textFaint }}>
            Source: <strong style={{ color: colors.textMuted }}>{result.source}</strong> · live paid-ads snapshot (real advertisers) · cost ${result.cost.toFixed(4)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── One advertiser ──────────────────────────────────────────────────────── */

function AdvertiserRow({ colors, rank, adv, probedCount }: { colors: Colors; rank: number; adv: Advertiser; probedCount: number }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "12px 4px", borderTop: rank === 1 ? "none" : `1px solid ${colors.border}` }}>
      <div style={{ width: 22, fontSize: 12, fontWeight: 700, color: colors.textFaint, textAlign: "right", paddingTop: 2 }}>{rank}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
          <span style={{ fontSize: 14.5, fontWeight: 700, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{adv.domain}</span>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: colors.accent, background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 999, padding: "2px 9px" }}>
            bids on {fmt(adv.keywordsBidOn)} of {fmt(probedCount)} keyword{probedCount === 1 ? "" : "s"}
          </span>
          {adv.bestPosition != null && (
            <span style={{ fontSize: 11.5, color: colors.textMuted }}>best position <strong style={{ color: colors.text }}>#{adv.bestPosition}</strong></span>
          )}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: adv.sampleHeadline || adv.sampleUrl ? 8 : 0 }}>
          {adv.keywords.map((k) => (
            <span key={k} style={chip(colors)}>{k}</span>
          ))}
        </div>
        {adv.sampleHeadline && (
          <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", lineHeight: 1.5 }}>
            &ldquo;{adv.sampleHeadline}&rdquo;
          </div>
        )}
        {adv.sampleUrl && (
          <div style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {adv.sampleUrl}
          </div>
        )}
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

function chip(colors: Colors): React.CSSProperties {
  return {
    fontSize: 11.5, fontWeight: 600, color: colors.textMuted, background: colors.bgInput,
    border: `1px solid ${colors.border}`, borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap",
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
