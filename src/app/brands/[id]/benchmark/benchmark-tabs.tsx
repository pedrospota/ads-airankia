"use client";

// ============================================================================
// Page-level 2-tab switcher for the per-brand Competitor benchmark page.
// Keeps the large benchmark-suite.tsx untouched: the suite owns the "benchmark"
// tab (and brings its own Header + main), while the auto-filled Premium spy
// report owns the other tab. A compact, on-brand segmented control switches
// between them. The report tab is given the same page chrome (Header + centered
// main) so navigation stays consistent across tabs.
// ============================================================================

import { useState } from "react";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";
import { BenchmarkSuite } from "./benchmark-suite";
import { BrandSpyReport } from "./brand-spy-report";

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
