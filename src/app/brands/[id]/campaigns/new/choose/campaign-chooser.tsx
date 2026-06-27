"use client";

import Link from "next/link";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";

// Two clear paths, in plain words. The Búsqueda engine is the flagship (most
// autonomous), so it's marked "Recomendado" and shown first. No jargon: we say
// what the user GETS, not the Google product name.
export function CampaignChooser({
  brandId,
  brandName,
}: {
  brandId: string;
  brandName: string;
}) {
  const { colors } = useTheme();

  const options = [
    {
      href: `/brands/${brandId}/campaigns/new/search`,
      emoji: "🔎",
      title: "Google Search ads",
      desc: "Your ad shows up when someone searches Google for exactly what you offer. The AI sets it up almost on its own: you just review and turn it on.",
      foot: "The easiest, most automatic option — recommended",
      recommended: true,
    },
    {
      href: `/brands/${brandId}/campaigns/new`,
      emoji: "🖼️",
      title: "Image ads",
      desc: "We create banners with your brand and your images so they show up on websites, blogs, and apps where your audience hangs out.",
      foot: "Great if you want people to see you with images",
      recommended: false,
    },
  ];

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Brands", href: "/brands" },
          { label: brandName, href: `/brands/${brandId}/citations` },
          { label: "New campaign" },
        ]}
      />

      <main className="max-w-3xl mx-auto px-6 py-12">
        <div style={{ textAlign: "center", marginBottom: 8 }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.5px", color: colors.text }}>
            What would you like to do?
          </h1>
          <p style={{ fontSize: 15, color: colors.textMuted, marginTop: 8 }}>
            Choose how you want to advertise <strong>{brandName}</strong>. You can
            change your mind anytime.
          </p>
        </div>

        <div
          role="list"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: 16,
            marginTop: 28,
          }}
        >
          {options.map((o) => (
            <Link
              key={o.href}
              href={o.href}
              role="listitem"
              style={{
                display: "block",
                position: "relative",
                textDecoration: "none",
                background: colors.bgCard,
                border: `1px solid ${o.recommended ? colors.accent : colors.border}`,
                borderRadius: 16,
                padding: "22px 24px",
              }}
            >
              {o.recommended && (
                <span
                  style={{
                    position: "absolute",
                    top: 16,
                    right: 16,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    color: "#000",
                    background: colors.accent,
                    borderRadius: 999,
                    padding: "3px 10px",
                  }}
                >
                  RECOMMENDED
                </span>
              )}
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                <div
                  aria-hidden="true"
                  style={{
                    fontSize: 34,
                    lineHeight: 1,
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  {o.emoji}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2 style={{ fontSize: 19, fontWeight: 700, color: colors.text }}>
                    {o.title}
                  </h2>
                  <p style={{ fontSize: 14, color: colors.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                    {o.desc}
                  </p>
                  <p style={{ fontSize: 12.5, color: o.recommended ? colors.accent : colors.textFaint, marginTop: 10, fontWeight: 600 }}>
                    {o.foot} →
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>

        <p style={{ textAlign: "center", fontSize: 12.5, color: colors.textFaint, marginTop: 22 }}>
          Not sure? Start with <strong>Google Search ads</strong>: it&apos;s
          the simplest option and the AI does almost everything for you.
        </p>
      </main>
    </div>
  );
}
