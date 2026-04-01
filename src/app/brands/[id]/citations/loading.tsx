"use client";

import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";

export default function CitationsLoading() {
  const { colors } = useTheme();

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Brands", href: "/brands" },
          { label: "Loading..." },
        ]}
      />
      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Skeleton brand header */}
        <div className="flex items-center gap-4 mb-8">
          <div className="w-16 h-16 rounded-xl animate-pulse" style={{ background: colors.bgCard }} />
          <div>
            <div className="h-8 w-48 rounded animate-pulse mb-2" style={{ background: colors.bgCard }} />
            <div className="h-4 w-32 rounded animate-pulse" style={{ background: colors.bgCard }} />
          </div>
        </div>

        {/* Skeleton KPI cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="p-4 rounded-xl" style={{ background: colors.bgCard, border: `1px solid ${colors.border}` }}>
              <div className="h-4 w-24 rounded animate-pulse mb-2" style={{ background: colors.border }} />
              <div className="h-8 w-16 rounded animate-pulse" style={{ background: colors.border }} />
            </div>
          ))}
        </div>

        {/* Skeleton table */}
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
          <div className="px-6 py-4" style={{ background: colors.bgCard, borderBottom: `1px solid ${colors.border}` }}>
            <div className="h-5 w-36 rounded animate-pulse" style={{ background: colors.border }} />
            <div className="h-4 w-64 rounded animate-pulse mt-2" style={{ background: colors.border }} />
          </div>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="px-6 py-3 flex gap-8" style={{ borderBottom: `1px solid ${colors.bgCard}` }}>
              <div className="h-4 w-48 rounded animate-pulse" style={{ background: colors.bgCard }} />
              <div className="h-4 w-24 rounded animate-pulse" style={{ background: colors.bgCard }} />
              <div className="h-4 w-12 rounded animate-pulse" style={{ background: colors.bgCard }} />
              <div className="h-4 w-20 rounded animate-pulse" style={{ background: colors.bgCard }} />
            </div>
          ))}
        </div>

        <p className="text-center mt-8 animate-pulse" style={{ color: colors.textMuted, fontSize: 13 }}>
          Loading citation data...
        </p>
      </main>
    </div>
  );
}
