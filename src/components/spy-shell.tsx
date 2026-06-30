"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";

// Each ad-spy capability is its OWN tool (own route), navigable from this left
// sidebar — kept SEPARATE from the AI benchmark pipeline so each can be tested in
// isolation. Only the live ones are clickable; the rest show the roadmap.
const TOOLS: { href: string; icon: string; label: string; live: boolean; source: string }[] = [
  { href: "/spy/keyword-spend", icon: "💰", label: "Keyword & Spend Spy", live: true, source: "DataForSEO" },
  { href: "/spy/landing", icon: "🔬", label: "Landing X-Ray", live: true, source: "Firecrawl + AI" },
  { href: "/spy/brand-defense", icon: "🛡️", label: "Brand Defense", live: true, source: "Oxylabs" },
  { href: "/spy/discovery", icon: "🔍", label: "Competitor Discovery", live: true, source: "DataForSEO" },
  { href: "/spy/monitor", icon: "🔔", label: "Monitor & Alerts", live: false, source: "Snapshots" },
];

export function SpyShell({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const pathname = usePathname();

  return (
    <div style={{ minHeight: "100vh", background: colors.bg }}>
      <Header breadcrumbs={[{ label: "Ad Spy" }]} />
      <div style={{ display: "flex", gap: 0, maxWidth: 1320, margin: "0 auto", alignItems: "stretch" }}>
        <aside
          style={{
            width: 248,
            flexShrink: 0,
            padding: "22px 12px",
            borderRight: `1px solid ${colors.border}`,
            minHeight: "calc(100vh - 56px)",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: colors.textMuted, padding: "0 10px 12px" }}>
            Ad-spy tools
          </div>
          <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {TOOLS.map((t) => {
              const active = pathname === t.href || pathname.startsWith(t.href + "/");
              const inner = (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 10px",
                    borderRadius: 10,
                    background: active ? "rgba(16,185,129,0.12)" : "transparent",
                    border: `1px solid ${active ? "rgba(16,185,129,0.3)" : "transparent"}`,
                    color: t.live ? (active ? colors.accent : colors.text) : colors.textFaint,
                    cursor: t.live ? "pointer" : "default",
                  }}
                >
                  <span style={{ fontSize: 16, width: 20, textAlign: "center" }}>{t.icon}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, display: "block", lineHeight: 1.2 }}>{t.label}</span>
                    <span style={{ fontSize: 10.5, color: colors.textFaint }}>{t.source}</span>
                  </span>
                  {!t.live && (
                    <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: colors.textFaint, border: `1px solid ${colors.border}`, borderRadius: 999, padding: "1px 6px" }}>
                      soon
                    </span>
                  )}
                </div>
              );
              return t.live ? (
                <Link key={t.href} href={t.href} style={{ textDecoration: "none" }}>{inner}</Link>
              ) : (
                <div key={t.href} title="Coming soon">{inner}</div>
              );
            })}
          </nav>
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${colors.border}` }}>
            <Link href="/brands" style={{ fontSize: 12.5, color: colors.textMuted, textDecoration: "none", padding: "0 10px" }}>
              ← Brands & Benchmark
            </Link>
          </div>
        </aside>
        <main style={{ flex: 1, minWidth: 0, padding: "24px 28px" }}>{children}</main>
      </div>
    </div>
  );
}
