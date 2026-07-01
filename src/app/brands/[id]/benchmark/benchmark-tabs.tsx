"use client";

// ============================================================================
// Page-level 2-tab switcher for the per-brand Competitor benchmark page.
// Keeps the large benchmark-suite.tsx untouched: the suite owns the "benchmark"
// tab (and brings its own Header + main), while the auto-filled Premium spy
// report owns the other tab. A compact, on-brand segmented control switches
// between them. The report tab is given the same page chrome (Header + centered
// main) so navigation stays consistent across tabs.
// ============================================================================

import Link from "next/link";
import { useState } from "react";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";
import { BenchmarkSuite } from "./benchmark-suite";
import { BrandSpyReport } from "./brand-spy-report";

// Per-brand launcher → every Ad Spy tool, pre-scoped to THIS brand via ?brand=id
// (the SpyBrandProvider reads that param and auto-selects the brand on arrival).
const SPY_TOOLS: { href: string; icon: string; label: string }[] = [
  { href: "/spy/keyword-spend", icon: "💰", label: "Keyword & Spend" },
  { href: "/spy/landing", icon: "🔬", label: "Landing X-Ray" },
  { href: "/spy/brand-defense", icon: "🛡️", label: "Brand Defense" },
  { href: "/spy/discovery", icon: "🔍", label: "Competitor Discovery" },
  { href: "/spy/report", icon: "📄", label: "Premium Report" },
];

interface Props {
  brandId: string;
  brandName: string;
  brandWebsite: string | null;
  knownCompetitors: string[];
  /** True when a SearchApi key is configured → the paid "live ads" toggle works. */
  adSpyAvailable: boolean;
}

type Tab = "benchmark" | "report";

export function BenchmarkTabs(props: Props) {
  const { colors } = useTheme();
  const [tab, setTab] = useState<Tab>("benchmark");

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "8px 16px",
    borderRadius: 10,
    border: `1px solid ${active ? colors.accent : colors.border}`,
    background: active ? "rgba(16,185,129,0.1)" : "transparent",
    color: active ? colors.accent : colors.textMuted,
    fontSize: 13.5,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  });

  return (
    <div className="min-h-screen">
      {/* Per-brand Ad Spy launcher — every tool deep-linked + pre-scoped to this brand. */}
      <div style={{ borderBottom: `1px solid ${colors.border}`, background: colors.bg }}>
        <div
          className="max-w-5xl mx-auto px-6"
          style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 24px" }}
        >
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: colors.textMuted,
              marginRight: 2,
            }}
          >
            🕵️ Spy this brand →
          </span>
          {SPY_TOOLS.map((t) => (
            <Link
              key={t.href}
              href={`${t.href}?brand=${encodeURIComponent(props.brandId)}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 11px",
                borderRadius: 999,
                fontSize: 12.5,
                fontWeight: 600,
                textDecoration: "none",
                background: colors.bgInput,
                border: `1px solid ${colors.border}`,
                color: colors.text,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ fontSize: 13 }}>{t.icon}</span>
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      {/* Section switcher — compact segmented control, page-width aligned. */}
      <div style={{ borderBottom: `1px solid ${colors.border}`, background: colors.bg }}>
        <div className="max-w-5xl mx-auto px-6" style={{ display: "flex", gap: 8, padding: "12px 24px" }}>
          <button type="button" style={tabBtn(tab === "benchmark")} onClick={() => setTab("benchmark")}>
            Competitor benchmark
          </button>
          <button type="button" style={tabBtn(tab === "report")} onClick={() => setTab("report")}>
            Premium spy report
          </button>
        </div>
      </div>

      {tab === "benchmark" ? (
        // The suite renders its own Header + main.
        <BenchmarkSuite {...props} />
      ) : (
        <>
          <Header
            breadcrumbs={[
              { label: "Brands", href: "/brands" },
              { label: props.brandName || "Brand", href: `/brands/${props.brandId}/citations` },
              { label: "Premium spy report" },
            ]}
            action={
              <a
                href={`/brands/${props.brandId}/campaigns`}
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
            <BrandSpyReport brandWebsite={props.brandWebsite} knownCompetitors={props.knownCompetitors} />
          </main>
        </>
      )}
    </div>
  );
}
