"use client";

import { useState } from "react";
import { useTheme } from "./theme-provider";

const SIZES = [
  { id: "300x250", label: "300x250", desc: "Medium Rectangle" },
  { id: "728x90", label: "728x90", desc: "Leaderboard" },
  { id: "336x280", label: "336x280", desc: "Large Rectangle" },
  { id: "160x600", label: "160x600", desc: "Wide Skyscraper" },
  { id: "320x50", label: "320x50", desc: "Mobile Leaderboard" },
];

interface GeneratedBanner {
  width: number;
  height: number;
  name: string;
  dataUrl: string;
}

export function BannerStudio({
  brandName,
  brandWebsite,
  onBannersGenerated,
}: {
  brandName: string;
  brandWebsite: string;
  onBannersGenerated: (banners: GeneratedBanner[]) => void;
}) {
  const { colors } = useTheme();
  const [tagline, setTagline] = useState(`Discover ${brandName}`);
  const [ctaText, setCtaText] = useState("Learn More");
  const [colorScheme, setColorScheme] = useState("professional dark theme with emerald green accents");
  const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set(["300x250", "728x90"]));
  const [generating, setGenerating] = useState(false);
  const [banners, setBanners] = useState<GeneratedBanner[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");

  function toggleSize(id: string) {
    setSelectedSizes((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function generate() {
    if (selectedSizes.size === 0) return;
    setGenerating(true);
    setError(null);
    setProgress(`Generating ${selectedSizes.size} banner${selectedSizes.size > 1 ? "s" : ""}...`);

    try {
      const resp = await fetch("/api/banners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandName,
          brandWebsite,
          tagline,
          ctaText,
          colorScheme,
          sizes: [...selectedSizes],
        }),
      });

      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      setBanners(data.banners);
      onBannersGenerated(data.banners);
      setProgress("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
      setProgress("");
    }
    setGenerating(false);
  }

  const inp = {
    width: "100%" as const, background: colors.bg, border: `1px solid ${colors.border}`,
    borderRadius: 8, padding: "10px 14px", fontSize: 13, color: colors.text,
    outline: "none", boxSizing: "border-box" as const,
  };
  const lbl = {
    display: "block" as const, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em",
    color: colors.textMuted, marginBottom: 7, textTransform: "uppercase" as const,
  };

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Banner Creatives</h3>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={lbl}>Tagline</label>
          <input value={tagline} onChange={(e) => setTagline(e.target.value)} style={inp} />
        </div>
        <div>
          <label style={lbl}>Call to Action</label>
          <input value={ctaText} onChange={(e) => setCtaText(e.target.value)} style={inp} />
        </div>
        <div>
          <label style={lbl}>Color / Style</label>
          <input value={colorScheme} onChange={(e) => setColorScheme(e.target.value)} style={inp}
            placeholder="e.g. dark navy, bright orange accents, minimalist" />
        </div>

        <div>
          <label style={lbl}>Banner Sizes</label>
          <div className="flex flex-wrap gap-2">
            {SIZES.map((s) => (
              <button key={s.id} onClick={() => toggleSize(s.id)}
                style={{
                  padding: "6px 12px", borderRadius: 6, fontSize: 12,
                  background: selectedSizes.has(s.id) ? "rgba(16,185,129,0.15)" : "transparent",
                  border: `1px solid ${selectedSizes.has(s.id) ? "rgba(16,185,129,0.4)" : colors.border}`,
                  color: selectedSizes.has(s.id) ? colors.accent : colors.textMuted,
                  cursor: "pointer",
                }}>
                {s.label} <span style={{ opacity: 0.6 }}>{s.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <button onClick={generate} disabled={generating || selectedSizes.size === 0}
          style={{
            padding: "11px", borderRadius: 8, background: colors.accent, color: "#000",
            fontWeight: 600, fontSize: 13, border: "none",
            cursor: generating ? "not-allowed" : "pointer", opacity: generating ? 0.7 : 1,
          }}>
          {generating ? progress || "Generating..." : `Generate ${selectedSizes.size} Banner${selectedSizes.size > 1 ? "s" : ""}`}
        </button>

        {error && (
          <p style={{ fontSize: 12, color: "#F87171", background: "rgba(248,113,113,0.1)", padding: "8px 12px", borderRadius: 7 }}>
            {error}
          </p>
        )}
      </div>

      {/* Preview generated banners */}
      {banners.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <label style={lbl}>Generated Banners ({banners.length})</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {banners.map((b, i) => (
              <div key={i} style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 12 }}>
                <div className="flex items-center justify-between mb-2">
                  <span style={{ fontSize: 12, color: colors.textMuted }}>{b.name} ({b.width}x{b.height})</span>
                  <a href={b.dataUrl} download={`${brandName}-${b.width}x${b.height}.png`}
                    style={{ fontSize: 11, color: colors.accent, textDecoration: "none" }}>
                    Download
                  </a>
                </div>
                <img src={b.dataUrl} alt={`${b.name} banner`}
                  style={{ maxWidth: "100%", borderRadius: 6, border: `1px solid ${colors.border}` }} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
