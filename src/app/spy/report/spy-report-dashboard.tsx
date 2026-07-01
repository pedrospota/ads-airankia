"use client";

// ============================================================================
// SpyReportDashboard — the PREMIUM, scannable face of the consolidated ad-spy
// report. Replaces the old wall-of-markdown with big KPIs, a spend chart, and
// tight teardown cards. The AI prose still lives here, but tucked inside a
// collapsible card so it informs without dominating. "Build once, expose three
// times" — this single component is rendered by both /spy/report and the
// per-brand benchmark page.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTheme } from "@/components/theme-provider";
import { MarkdownReport } from "@/components/markdown-report";
import type { CompetitiveBrief } from "@/lib/spy/brief";

type Colors = ReturnType<typeof useTheme>["colors"];

// ---- tiny formatters -------------------------------------------------------
const money = (n: number) => "$" + Math.round(n || 0).toLocaleString("en-US");
const int = (n: number) => Math.round(n || 0).toLocaleString("en-US");
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

// ---- match badge palette ---------------------------------------------------
const MATCH: Record<"strong" | "partial" | "weak", { bg: string; border: string; fg: string; label: string }> = {
  strong: { bg: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.35)", fg: "#10B981", label: "Strong match" },
  partial: { bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.35)", fg: "#F59E0B", label: "Partial match" },
  weak: { bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.35)", fg: "#F87171", label: "Weak match" },
};

export function SpyReportDashboard({
  brief,
  executiveSummary,
  cost,
}: {
  brief: CompetitiveBrief;
  executiveSummary: string | null;
  cost: number;
}) {
  const { colors } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  useEffect(() => setMounted(true), []);

  const spend = brief.keywordSpend ?? [];
  const competitors = brief.competitors ?? [];
  const landing = brief.landing ?? [];
  const brandThreats = brief.brandThreats ?? [];
  const gap = brief.keywordGap ?? null;

  // ---- KPIs ----------------------------------------------------------------
  const totalSpend = spend.reduce((s, k) => s + (k.estimatedMonthlySpend || 0), 0);
  const totalPaidKw = spend.reduce((s, k) => s + (k.paidKeywords || 0), 0);
  const stealCount = gap?.steal.length ?? 0;
  const threatCount = brandThreats.reduce((s, t) => s + (t.conquesters?.length ?? 0), 0);

  // ---- spend chart data (sorted desc) --------------------------------------
  const chartData = useMemo(
    () =>
      [...spend]
        .filter((k) => (k.estimatedMonthlySpend || 0) > 0)
        .sort((a, b) => (b.estimatedMonthlySpend || 0) - (a.estimatedMonthlySpend || 0))
        .map((k) => ({ domain: k.domain, spend: Math.round(k.estimatedMonthlySpend || 0) })),
    [spend],
  );
  const chartHeight = Math.max(160, chartData.length * 40);

  // ---- source counts grouped by provider -----------------------------------
  const sourceLabel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of brief.sources ?? []) counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
    return [...counts.entries()].map(([p, n]) => `${p} (${n})`).join(" · ");
  }, [brief.sources]);

  const card: React.CSSProperties = {
    background: colors.bgCard,
    border: `1px solid ${colors.border}`,
    borderRadius: 16,
    padding: 20,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* a. HEADER */}
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: colors.text, margin: 0 }}>
          Competitive Intelligence — {brief.brand.domain ?? brief.brand.name}
        </h1>
        <p style={{ fontSize: 13, color: colors.textMuted, margin: "6px 0 0" }}>
          {brief.market.countryName} · {competitors.length} competitor{competitors.length === 1 ? "" : "s"} ·{" "}
          {fmtDate(brief.generatedAt)}
        </p>
      </div>

      {/* b. KPI STRIP */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
        <Kpi colors={colors} value={money(totalSpend)} label="Rival ad spend / mo" accent />
        <Kpi colors={colors} value={int(totalPaidKw)} label="Paid keywords tracked" />
        <Kpi colors={colors} value={int(stealCount)} label="🔥 Keywords to steal" />
        <Kpi colors={colors} value={int(competitors.length)} label="Competitors analyzed" />
        <Kpi
          colors={colors}
          value={threatCount === 0 ? "0 · clean" : int(threatCount)}
          label="🛡️ Brand threats"
        />
      </div>

      {/* c. SPEND CHART */}
      <div style={card}>
        <SectionTitle colors={colors} title="💰 Estimated monthly ad spend" />
        {chartData.length === 0 ? (
          <p style={{ fontSize: 13, color: colors.textFaint, margin: "10px 0 0" }}>No paid spend detected.</p>
        ) : mounted ? (
          <div style={{ width: "100%", height: chartHeight, marginTop: 14 }}>
            <ResponsiveContainer width="100%" height={chartHeight} minWidth={0}>
              <BarChart layout="vertical" data={chartData} margin={{ left: 8, right: 60, top: 4, bottom: 4 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="domain"
                  width={150}
                  tick={{ fill: colors.textMuted, fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: "rgba(16,185,129,0.08)" }}
                  contentStyle={{
                    background: colors.bgCard,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 8,
                    fontSize: 12,
                    color: colors.text,
                  }}
                  labelStyle={{ color: colors.text }}
                  formatter={(v) => [money(Number(v)), "Spend / mo"]}
                />
                <Bar
                  dataKey="spend"
                  radius={[0, 6, 6, 0]}
                  barSize={18}
                  label={{ position: "right", fill: colors.textMuted, fontSize: 11, formatter: (v) => money(Number(v)) }}
                >
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={colors.accent} fillOpacity={1 - i * 0.07} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          // SSR / pre-mount fallback — a plain list, no chart.
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {chartData.map((d) => (
              <div key={d.domain} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: colors.textMuted }}>
                <span>{d.domain}</span>
                <span style={{ color: colors.text, fontWeight: 600 }}>{money(d.spend)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* d. KEYWORD GAP */}
      {gap && (
        <div style={card}>
          <SectionTitle colors={colors} title="🥊 Keyword gap" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginTop: 12 }}>
            <MiniStat colors={colors} value={int(gap.steal.length)} label="🔥 To steal" />
            <MiniStat colors={colors} value={int(gap.shared.length)} label="⚔️ Shared" />
            <MiniStat colors={colors} value={int(gap.defendCount)} label="🛡️ You defend" />
          </div>
          {gap.steal.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: colors.textMuted, marginBottom: 8 }}>
                Top keywords to steal:
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {gap.steal.slice(0, 15).map((kw, i) => (
                  <Chip key={i} colors={colors} accent>
                    {truncate(kw, 40)}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* e. LANDING TEARDOWNS */}
      {landing.length > 0 && (
        <div>
          <SectionTitle colors={colors} title="🔬 How competitors sell" style={{ marginBottom: 12 }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
            {landing.map((l, i) => {
              const badge = l.adMessageMatch ? MATCH[l.adMessageMatch] : null;
              return (
                <div key={i} style={{ ...card, padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 14.5, fontWeight: 700, color: colors.text, textDecoration: "none", wordBreak: "break-all" }}
                    >
                      {l.domain}
                    </a>
                    {badge && (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          color: badge.fg,
                          background: badge.bg,
                          border: `1px solid ${badge.border}`,
                          borderRadius: 999,
                          padding: "2px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {badge.label}
                      </span>
                    )}
                  </div>

                  {l.offer && (
                    <p style={{ fontSize: 13, color: colors.textMuted, margin: 0, lineHeight: 1.5 }}>
                      {truncate(l.offer, 160)}
                    </p>
                  )}

                  {l.primaryCta && (
                    <div>
                      <span
                        style={{
                          display: "inline-block",
                          fontSize: 12,
                          fontWeight: 700,
                          color: "#06281D",
                          background: colors.accent,
                          borderRadius: 999,
                          padding: "4px 12px",
                        }}
                      >
                        {truncate(l.primaryCta, 40)}
                      </span>
                    </div>
                  )}

                  {l.valueProps.length > 0 && (
                    <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                      {l.valueProps.slice(0, 3).map((vp, vi) => (
                        <li key={vi} style={{ fontSize: 12.5, color: colors.textMuted, lineHeight: 1.45 }}>
                          {truncate(vp, 90)}
                        </li>
                      ))}
                    </ul>
                  )}

                  {l.socialProof.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {l.socialProof.slice(0, 4).map((sp, si) => (
                        <Chip key={si} colors={colors}>
                          {truncate(sp, 30)}
                        </Chip>
                      ))}
                    </div>
                  )}

                  {l.trackingStack.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                      {l.trackingStack.slice(0, 6).map((t, ti) => (
                        <span
                          key={ti}
                          style={{
                            fontSize: 10.5,
                            fontFamily: "var(--font-geist-mono), monospace",
                            color: colors.textFaint,
                            border: `1px solid ${colors.border}`,
                            borderRadius: 5,
                            padding: "1px 6px",
                          }}
                        >
                          {truncate(t, 24)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* f. BRAND DEFENSE */}
      <div style={card}>
        <SectionTitle colors={colors} title="🛡️ Brand defense" />
        {threatCount === 0 ? (
          <div
            style={{
              marginTop: 12,
              padding: "12px 14px",
              borderRadius: 12,
              background: "rgba(16,185,129,0.08)",
              border: "1px solid rgba(16,185,129,0.3)",
              color: colors.text,
              fontSize: 13.5,
              fontWeight: 600,
            }}
          >
            ✅ No one is bidding on your brand — clean.
          </div>
        ) : (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {brandThreats.map((t, ti) =>
              (t.conquesters ?? []).map((c, ci) => (
                <div
                  key={`${ti}-${ci}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    padding: "10px 14px",
                    borderRadius: 12,
                    background: colors.bgInput,
                    border: `1px solid ${colors.border}`,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: "#F87171" }}>{c.domain}</span>
                    <span style={{ fontSize: 11, color: colors.textFaint }}>on “{truncate(t.brandKeyword, 40)}”</span>
                  </div>
                  {c.headline && (
                    <div style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.5 }}>
                      {truncate(c.headline, 120)}
                    </div>
                  )}
                </div>
              )),
            )}
          </div>
        )}
      </div>

      {/* g. AI STRATEGY (collapsible) */}
      {executiveSummary && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <SectionTitle colors={colors} title="✨ AI strategy & recommendations" style={{ marginBottom: 0 }} />
            <button
              onClick={() => setAiOpen((v) => !v)}
              style={{
                padding: "8px 16px",
                borderRadius: 10,
                border: `1px solid ${colors.border}`,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 700,
                background: "transparent",
                color: colors.text,
                whiteSpace: "nowrap",
              }}
            >
              {aiOpen ? "Hide the AI analysis ▴" : "Read the AI analysis ▾"}
            </button>
          </div>
          {aiOpen && (
            <div style={{ marginTop: 16, borderTop: `1px solid ${colors.border}`, paddingTop: 16 }}>
              <MarkdownReport markdown={executiveSummary} colors={colors} />
            </div>
          )}
        </div>
      )}

      {/* h. SOURCES footer */}
      <div style={{ fontSize: 11.5, color: colors.textFaint }}>
        {sourceLabel && <>{sourceLabel} · </>}cost ${cost.toFixed(4)}
      </div>
    </div>
  );
}

// ---- presentational helpers ------------------------------------------------
function SectionTitle({
  colors,
  title,
  style,
}: {
  colors: Colors;
  title: string;
  style?: React.CSSProperties;
}) {
  return (
    <h2 style={{ fontSize: 15, fontWeight: 800, color: colors.text, margin: 0, ...style }}>{title}</h2>
  );
}

function Kpi({
  colors,
  value,
  label,
  accent,
}: {
  colors: Colors;
  value: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        background: accent ? "rgba(16,185,129,0.08)" : colors.bgCard,
        border: `1px solid ${accent ? "rgba(16,185,129,0.35)" : colors.border}`,
        borderRadius: 14,
        padding: "16px 18px",
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 800, color: accent ? colors.accent : colors.text, lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 6, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function MiniStat({ colors, value, label }: { colors: Colors; value: string; label: string }) {
  return (
    <div
      style={{
        background: colors.bgInput,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: "14px 12px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 800, color: colors.text, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 5, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function Chip({
  colors,
  children,
  accent,
}: {
  colors: Colors;
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: accent ? colors.accent : colors.textMuted,
        background: accent ? "rgba(16,185,129,0.1)" : colors.bgInput,
        border: `1px solid ${accent ? "rgba(16,185,129,0.3)" : colors.border}`,
        borderRadius: 999,
        padding: "4px 10px",
      }}
    >
      {children}
    </span>
  );
}
