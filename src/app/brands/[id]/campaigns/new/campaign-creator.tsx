"use client";

import { useEffect, useState, useMemo } from "react";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";
import { useRouter } from "next/navigation";

interface Brand {
  id: string; name: string; industry: string | null; website: string | null;
  logo_url: string | null; workspace_id: string;
}
interface Citation { url: string; domain: string; citation_count: number; models: string[]; }
interface BrandProfile {
  title: string; description: string; ogImage: string | null; logo: string | null;
  favicon: string | null; colors: string[]; keywords: string[];
}
interface AdInfo { hasGdn: boolean; gdnPubId: string | null; networks: string[]; }
interface Banner { width: number; height: number; name: string; dataUrl: string; }

type Step = "brand" | "placements" | "creatives" | "review";

const SIZES = [
  { id: "300x250", desc: "Medium Rectangle" }, { id: "728x90", desc: "Leaderboard" },
  { id: "336x280", desc: "Large Rectangle" }, { id: "160x600", desc: "Skyscraper" }, { id: "320x50", desc: "Mobile" },
];

export function CampaignCreator({ brand, citations }: { brand: Brand; citations: Citation[] }) {
  const { colors } = useTheme();
  const router = useRouter();
  const [step, setStep] = useState<Step>("brand");

  // Brand analysis
  const [profile, setProfile] = useState<BrandProfile | null>(null);
  const [scraping, setScraping] = useState(false);
  const [brandDesc, setBrandDesc] = useState("");
  const [brandTagline, setBrandTagline] = useState("");

  // Placements
  const [adData, setAdData] = useState<Record<string, AdInfo>>({});
  const [adLoading, setAdLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Campaign settings
  const [campaignName, setCampaignName] = useState(`${brand.name} - Citation Retargeting`);
  const [landingPage, setLandingPage] = useState(brand.website || "");
  const [dailyBudget, setDailyBudget] = useState(1);

  // Creatives
  const [banners, setBanners] = useState<Banner[]>([]);
  const [genBanners, setGenBanners] = useState(false);
  const [cta, setCta] = useState("Learn More");
  const [colorStyle, setColorStyle] = useState("");
  const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set(["300x250", "728x90"]));
  const [bannerError, setBannerError] = useState<string | null>(null);

  // Publishing
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [savedCampaignId, setSavedCampaignId] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{ googleCampaignId: string; placementsAdded: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inp = { width: '100%' as const, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: colors.text, outline: 'none', boxSizing: 'border-box' as const };
  const lbl = { display: 'block' as const, fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: colors.textMuted, marginBottom: 7, textTransform: 'uppercase' as const };

  // Scrape brand on mount
  useEffect(() => {
    if (brand.website) {
      setScraping(true);
      fetch("/api/brand-scrape", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: brand.website }) })
        .then((r) => r.json())
        .then((p) => {
          setProfile(p);
          setBrandDesc(p.description || `${brand.name} — ${brand.industry || ""}`);
          setBrandTagline(p.title || `Discover ${brand.name}`);
          if (p.colors?.length) setColorStyle(p.colors.slice(0, 3).join(", ") + " palette, professional");
          else setColorStyle("professional dark with brand colors");
        })
        .catch(() => {})
        .finally(() => setScraping(false));
    }
  }, [brand]);

  // Scan GDN on mount
  useEffect(() => {
    const domains = [...new Set(citations.map((c) => c.domain.replace(/^www\./, "").replace(/^m\./, "")))];
    if (!domains.length) { setAdLoading(false); return; }
    fetch("/api/check-gdn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domains }) })
      .then((r) => r.json())
      .then((data) => {
        const map: Record<string, AdInfo> = {};
        for (const r of data.results || []) map[r.domain] = { hasGdn: r.hasGdn, gdnPubId: r.gdnPubId, networks: r.networks || [] };
        setAdData(map);
        // Pre-select ALL targetable
        const targetable = citations.filter((c) => map[c.domain.replace(/^www\./, "").replace(/^m\./, "")]?.hasGdn);
        setSelected(new Set(targetable.map((c) => c.url)));
      })
      .catch(() => {})
      .finally(() => setAdLoading(false));
  }, [citations]);

  const targetable = useMemo(() => citations.filter((c) => adData[c.domain.replace(/^www\./, "").replace(/^m\./, "")]?.hasGdn), [citations, adData]);
  const selectedUrls = useMemo(() => citations.filter((c) => selected.has(c.url)), [citations, selected]);

  function toggleUrl(url: string) {
    setSelected((p) => { const n = new Set(p); if (n.has(url)) n.delete(url); else n.add(url); return n; });
  }

  async function generateBanners() {
    setGenBanners(true); setBannerError(null);
    try {
      const r = await fetch("/api/banners", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandName: brand.name, brandWebsite: brand.website, tagline: brandTagline, ctaText: cta, colorScheme: colorStyle, sizes: [...selectedSizes] }) });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setBanners(data.banners);
    } catch (e) { setBannerError(e instanceof Error ? e.message : "Failed"); }
    setGenBanners(false);
  }

  async function saveDraft() {
    setSaving(true); setError(null);
    try {
      const urls = selectedUrls.map((c) => ({ url: c.url, domain: c.domain.replace(/^www\./, "").replace(/^m\./, "") }));
      const r = await fetch("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId: brand.id, brandName: brand.name, brandWebsite: brand.website, workspaceId: brand.workspace_id, campaignName, landingPageUrl: landingPage, dailyBudgetCents: Math.round(dailyBudget * 100), urls }) });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setSavedCampaignId(data.campaign.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
    setSaving(false);
  }

  async function publishToGoogleAds() {
    if (!savedCampaignId) return;
    setPublishing(true); setError(null);
    try {
      const r = await fetch("/api/campaigns/publish", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: savedCampaignId }) });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setPublishResult({ googleCampaignId: data.googleCampaignId, placementsAdded: data.placementsAdded });
    } catch (e) { setError(e instanceof Error ? e.message : "Publish failed"); }
    setPublishing(false);
  }

  const steps: { key: Step; label: string }[] = [
    { key: "brand", label: "Brand" }, { key: "placements", label: "Placements" },
    { key: "creatives", label: "Creatives" }, { key: "review", label: "Review & Publish" },
  ];
  const stepIdx = steps.findIndex((s) => s.key === step);

  return (
    <div className="min-h-screen">
      <Header breadcrumbs={[{ label: "Brands", href: "/brands" }, { label: brand.name, href: `/brands/${brand.id}/citations` }, { label: "New Campaign" }]} />

      {/* Step bar */}
      <div style={{ borderBottom: `1px solid ${colors.border}`, padding: '12px 24px', background: colors.bgCard }}>
        <div className="max-w-5xl mx-auto flex gap-1">
          {steps.map((s, i) => (
            <button key={s.key} onClick={() => i <= stepIdx && setStep(s.key)}
              className="flex items-center gap-2" style={{ cursor: i <= stepIdx ? 'pointer' : 'default', opacity: i > stepIdx ? 0.4 : 1 }}>
              <div style={{ width: 28, height: 28, borderRadius: 99, fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: i === stepIdx ? colors.accent : i < stepIdx ? 'rgba(16,185,129,0.3)' : colors.bg,
                color: i <= stepIdx ? '#000' : colors.textMuted, border: `1px solid ${colors.border}` }}>
                {i < stepIdx ? '✓' : i + 1}
              </div>
              <span style={{ fontSize: 13, color: i === stepIdx ? colors.text : colors.textMuted, fontWeight: i === stepIdx ? 600 : 400 }}>{s.label}</span>
              {i < 3 && <span style={{ color: colors.border, margin: '0 8px' }}>→</span>}
            </button>
          ))}
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-6 py-8">

        {/* STEP 1: Brand Analysis */}
        {step === "brand" && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Brand Analysis</h1>
            <p style={{ color: colors.textMuted, marginBottom: 24 }}>We scraped {brand.website} to understand your brand. Confirm or edit.</p>

            {scraping ? (
              <div className="py-12 text-center animate-pulse" style={{ color: colors.textMuted }}>Analyzing {brand.website}...</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Left: extracted data */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {(profile?.ogImage || profile?.logo || brand.logo_url) && (
                    <div>
                      <label style={lbl}>Brand Image</label>
                      <img src={profile?.ogImage || profile?.logo || brand.logo_url || ""} alt={brand.name}
                        style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, border: `1px solid ${colors.border}` }} />
                    </div>
                  )}
                  <div><label style={lbl}>Brand Name</label><p style={{ fontSize: 16, fontWeight: 600 }}>{brand.name}</p></div>
                  <div><label style={lbl}>Industry</label><p style={{ fontSize: 14, color: colors.textMuted }}>{brand.industry}</p></div>
                  {profile?.colors && profile.colors.length > 0 && (
                    <div>
                      <label style={lbl}>Detected Colors</label>
                      <div className="flex gap-2">{profile.colors.slice(0, 6).map((c) => (
                        <div key={c} style={{ width: 32, height: 32, borderRadius: 6, background: c, border: `1px solid ${colors.border}` }} title={c} />
                      ))}</div>
                    </div>
                  )}
                </div>

                {/* Right: editable fields */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div><label style={lbl}>Campaign Name</label><input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} style={inp} /></div>
                  <div><label style={lbl}>Brand Description (used for ad copy)</label>
                    <textarea value={brandDesc} onChange={(e) => setBrandDesc(e.target.value)} rows={3}
                      style={{ ...inp, resize: 'vertical' as const }} /></div>
                  <div><label style={lbl}>Tagline</label><input value={brandTagline} onChange={(e) => setBrandTagline(e.target.value)} style={inp} /></div>
                  <div><label style={lbl}>Landing Page</label><input value={landingPage} onChange={(e) => setLandingPage(e.target.value)} style={inp} /></div>
                  <div>
                    <label style={lbl}>Daily Budget (USD)</label>
                    <input type="number" min={1} step={1} value={dailyBudget} onChange={(e) => setDailyBudget(Number(e.target.value))} style={inp} />
                    <p style={{ fontSize: 11, color: colors.textFaint, marginTop: 4 }}>Campaign is created PAUSED. Activate when ready.</p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end mt-8">
              <button onClick={() => setStep("placements")} style={{ padding: '10px 24px', borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 600, fontSize: 14, border: 'none', cursor: 'pointer' }}>
                Next: Select Placements →
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: Placements */}
        {step === "placements" && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Select Placements</h1>
            <p style={{ color: colors.textMuted, marginBottom: 8 }}>
              {adLoading ? "Scanning..." : `${targetable.length} targetable URLs found. All pre-selected — deselect any you don't want.`}
            </p>

            <div className="flex gap-3 mb-4">
              <button onClick={() => setSelected(new Set(targetable.map((c) => c.url)))}
                style={{ padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', color: colors.accent, cursor: 'pointer' }}>
                Select All ({targetable.length})
              </button>
              <button onClick={() => setSelected(new Set())}
                style={{ padding: '6px 12px', borderRadius: 6, fontSize: 12, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textMuted, cursor: 'pointer' }}>
                Deselect All
              </button>
              <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600, alignSelf: 'center' }}>{selected.size} selected</span>
            </div>

            <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${colors.border}`, maxHeight: 500, overflow: 'auto' }}>
              <table className="w-full">
                <thead style={{ position: 'sticky', top: 0 }}>
                  <tr style={{ background: colors.bgCard, borderBottom: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 12 }} className="text-left">
                    <th className="px-3 py-2 w-10"></th>
                    <th className="px-3 py-2 font-medium">Domain</th>
                    <th className="px-3 py-2 font-medium">URL</th>
                    <th className="px-3 py-2 font-medium text-right">Citations</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                  </tr>
                </thead>
                <tbody style={{ background: colors.bg }}>
                  {targetable.map((c) => {
                    const d = c.domain.replace(/^www\./, "").replace(/^m\./, "");
                    const info = adData[d];
                    const sel = selected.has(c.url);
                    const isYT = info?.networks.includes("YouTube");
                    return (
                      <tr key={c.url} style={{ borderBottom: `1px solid ${colors.bgCard}`, background: sel ? 'rgba(16,185,129,0.04)' : undefined, opacity: sel ? 1 : 0.5 }}>
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={sel} onChange={() => toggleUrl(c.url)}
                            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: colors.accent }} />
                        </td>
                        <td className="px-3 py-2" style={{ fontSize: 12, fontWeight: 500 }}>{d}</td>
                        <td className="px-3 py-2" style={{ fontSize: 11, color: colors.textMuted, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 50)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono" style={{ fontSize: 12 }}>{c.citation_count}</td>
                        <td className="px-3 py-2">
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 99, background: isYT ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)', color: isYT ? '#EF4444' : '#10B981' }}>
                            {isYT ? "YouTube" : "GDN"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between mt-8">
              <button onClick={() => setStep("brand")} style={{ padding: '10px 24px', borderRadius: 8, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 14, cursor: 'pointer' }}>← Back</button>
              <button onClick={() => setStep("creatives")} disabled={selected.size === 0}
                style={{ padding: '10px 24px', borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 600, fontSize: 14, border: 'none', cursor: selected.size === 0 ? 'not-allowed' : 'pointer', opacity: selected.size === 0 ? 0.5 : 1 }}>
                Next: Create Ads →
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: Creatives */}
        {step === "creatives" && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Create Ad Banners</h1>
            <p style={{ color: colors.textMuted, marginBottom: 24 }}>AI generates display banners using your brand info. Edit and regenerate until happy.</p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Left: controls */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div><label style={lbl}>Tagline</label><input value={brandTagline} onChange={(e) => setBrandTagline(e.target.value)} style={inp} /></div>
                <div><label style={lbl}>Call to Action</label><input value={cta} onChange={(e) => setCta(e.target.value)} style={inp} /></div>
                <div><label style={lbl}>Color / Style</label><input value={colorStyle} onChange={(e) => setColorStyle(e.target.value)} style={inp} /></div>
                <div>
                  <label style={lbl}>Sizes</label>
                  <div className="flex flex-wrap gap-2">
                    {SIZES.map((s) => (
                      <button key={s.id} onClick={() => setSelectedSizes((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })}
                        style={{ padding: '4px 8px', borderRadius: 6, fontSize: 11, background: selectedSizes.has(s.id) ? 'rgba(16,185,129,0.15)' : 'transparent',
                          border: `1px solid ${selectedSizes.has(s.id) ? 'rgba(16,185,129,0.4)' : colors.border}`, color: selectedSizes.has(s.id) ? colors.accent : colors.textMuted, cursor: 'pointer' }}>
                        {s.id}
                      </button>
                    ))}
                  </div>
                </div>
                <button onClick={generateBanners} disabled={genBanners || selectedSizes.size === 0}
                  style={{ padding: 11, borderRadius: 8, background: 'rgba(99,102,241,0.8)', color: '#fff', fontWeight: 600, fontSize: 13, border: 'none',
                    cursor: genBanners ? 'not-allowed' : 'pointer', opacity: genBanners ? 0.7 : 1 }}>
                  {genBanners ? "Generating..." : `Generate ${selectedSizes.size} Banner${selectedSizes.size > 1 ? 's' : ''}`}
                </button>
                {bannerError && <p style={{ fontSize: 12, color: '#F87171' }}>{bannerError}</p>}
              </div>

              {/* Right: previews (2 cols) */}
              <div className="md:col-span-2">
                {banners.length === 0 && !genBanners && (
                  <div className="py-16 text-center" style={{ border: `2px dashed ${colors.border}`, borderRadius: 12 }}>
                    <p style={{ color: colors.textMuted, fontSize: 14 }}>No banners yet. Configure and click Generate.</p>
                  </div>
                )}
                {genBanners && (
                  <div className="py-16 text-center animate-pulse" style={{ border: `2px dashed ${colors.border}`, borderRadius: 12 }}>
                    <p style={{ color: colors.textMuted, fontSize: 14 }}>Generating banners with AI...</p>
                  </div>
                )}
                {banners.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {banners.map((b, i) => (
                      <div key={i} style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 12 }}>
                        <div className="flex items-center justify-between mb-2">
                          <span style={{ fontSize: 12, color: colors.textMuted }}>{b.name} ({b.width}x{b.height})</span>
                          <a href={b.dataUrl} download={`${brand.name}-${b.width}x${b.height}.png`} style={{ fontSize: 11, color: colors.accent, textDecoration: 'none' }}>Download</a>
                        </div>
                        <img src={b.dataUrl} alt={b.name} style={{ maxWidth: '100%', borderRadius: 6, border: `1px solid ${colors.border}` }} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-between mt-8">
              <button onClick={() => setStep("placements")} style={{ padding: '10px 24px', borderRadius: 8, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 14, cursor: 'pointer' }}>← Back</button>
              <button onClick={() => setStep("review")}
                style={{ padding: '10px 24px', borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 600, fontSize: 14, border: 'none', cursor: 'pointer' }}>
                Next: Review →
              </button>
            </div>
          </div>
        )}

        {/* STEP 4: Review & Publish */}
        {step === "review" && (
          <div>
            {publishResult ? (
              <div className="py-12 text-center">
                <div style={{ width: 72, height: 72, borderRadius: 99, background: 'rgba(16,185,129,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <h1 className="text-3xl font-bold mb-4">Published to Google Ads!</h1>
                <p style={{ fontSize: 15, color: colors.textMuted, marginBottom: 8 }}>{publishResult.placementsAdded} placements added · {banners.length} banners generated</p>
                <p style={{ fontSize: 13, color: colors.textFaint, marginBottom: 8 }}>Google Ads Campaign ID: {publishResult.googleCampaignId}</p>
                <p style={{ fontSize: 14, color: '#FBBF24', fontWeight: 600, marginBottom: 24 }}>Status: PAUSED — Activate in Google Ads when ready</p>
                <button onClick={() => router.push(`/brands/${brand.id}/citations`)}
                  style={{ padding: '12px 32px', borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 600, fontSize: 14, border: 'none', cursor: 'pointer' }}>
                  Back to Citations
                </button>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-bold mb-6">Review & Publish</h1>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16 }}>
                    <p style={{ ...lbl }}>Campaign</p>
                    <p style={{ fontSize: 16, fontWeight: 600 }}>{campaignName}</p>
                    <p style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>{landingPage}</p>
                  </div>
                  <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16 }}>
                    <p style={{ ...lbl }}>Placements</p>
                    <p style={{ fontSize: 28, fontWeight: 700 }}>{selected.size}</p>
                    <p style={{ fontSize: 12, color: colors.textMuted }}>targetable URLs</p>
                  </div>
                  <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16 }}>
                    <p style={{ ...lbl }}>Budget</p>
                    <p style={{ fontSize: 28, fontWeight: 700 }}>${dailyBudget}</p>
                    <p style={{ fontSize: 12, color: colors.textMuted }}>per day (paused)</p>
                  </div>
                </div>

                {banners.length > 0 && (
                  <div className="mb-6">
                    <p style={{ ...lbl, marginBottom: 12 }}>Banners ({banners.length})</p>
                    <div className="flex gap-3 overflow-x-auto pb-2">
                      {banners.map((b, i) => (
                        <img key={i} src={b.dataUrl} alt={b.name} style={{ height: 100, borderRadius: 6, border: `1px solid ${colors.border}` }} />
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 8, padding: 14, marginBottom: 24 }}>
                  <p style={{ fontSize: 13, color: '#FBBF24' }}>Campaign will be created as <strong>PAUSED</strong> in Google Ads. Nothing will spend money until you activate it.</p>
                </div>

                {error && <p style={{ fontSize: 13, color: '#F87171', marginBottom: 16 }}>{error}</p>}

                <div className="flex justify-between">
                  <button onClick={() => setStep("creatives")} style={{ padding: '10px 24px', borderRadius: 8, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 14, cursor: 'pointer' }}>← Back</button>
                  <div className="flex gap-3">
                    {!savedCampaignId ? (
                      <button onClick={saveDraft} disabled={saving}
                        style={{ padding: '10px 24px', borderRadius: 8, background: colors.bgCard, border: `1px solid ${colors.border}`, color: colors.text, fontWeight: 600, fontSize: 14, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
                        {saving ? "Saving..." : "Save as Draft"}
                      </button>
                    ) : (
                      <span style={{ fontSize: 13, color: colors.accent, alignSelf: 'center' }}>✓ Draft saved</span>
                    )}
                    <button onClick={savedCampaignId ? publishToGoogleAds : async () => { await saveDraft(); }}
                      disabled={publishing || saving}
                      style={{ padding: '10px 24px', borderRadius: 8, background: savedCampaignId ? '#EF4444' : colors.accent, color: '#fff', fontWeight: 600, fontSize: 14, border: 'none',
                        cursor: publishing || saving ? 'not-allowed' : 'pointer', opacity: publishing || saving ? 0.7 : 1 }}>
                      {publishing ? "Publishing..." : savedCampaignId ? "🚀 Publish to Google Ads" : "Save & Publish"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
