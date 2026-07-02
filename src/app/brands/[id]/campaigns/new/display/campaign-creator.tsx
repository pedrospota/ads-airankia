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
  { id: "300x250", desc: "Medium square" }, { id: "728x90", desc: "Wide banner" },
  { id: "336x280", desc: "Large square" }, { id: "160x600", desc: "Tall vertical banner" }, { id: "320x50", desc: "Mobile banner" },
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
  const [campaignName, setCampaignName] = useState(`${brand.name} - Ads for your customers`);
  const [landingPage, setLandingPage] = useState(brand.website || "");
  const [dailyBudget, setDailyBudget] = useState(1);

  // Creatives
  const [banners, setBanners] = useState<Banner[]>([]);
  const [genBanners, setGenBanners] = useState(false);
  const [cta, setCta] = useState("Learn more");
  const [colorStyle, setColorStyle] = useState("");
  const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set(["300x250", "728x90"]));
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [uploadedImages, setUploadedImages] = useState<{ base64: string; mimeType: string; preview: string; name: string }[]>([]);
  const [regenSize, setRegenSize] = useState<string | null>(null);

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

    // Auto-load brand logo as uploaded image
    const logoUrl = brand.logo_url;
    if (logoUrl && logoUrl.startsWith("http")) {
      fetch(logoUrl).then((r) => r.blob()).then((blob) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const [header, base64] = dataUrl.split(",");
          const mimeType = header.match(/data:([^;]+)/)?.[1] || "image/png";
          setUploadedImages([{ base64, mimeType, preview: dataUrl, name: "Brand logo" }]);
        };
        reader.readAsDataURL(blob);
      }).catch(() => {});
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

  const bannerPayload = () => ({
    brandName: brand.name, brandWebsite: brand.website, tagline: brandTagline,
    ctaText: cta, colorScheme: colorStyle,
    images: uploadedImages.map((i) => ({ base64: i.base64, mimeType: i.mimeType })),
  });

  async function generateBanners() {
    setGenBanners(true); setBannerError(null);
    try {
      const r = await fetch("/api/banners", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...bannerPayload(), sizes: [...selectedSizes] }) });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setBanners(data.banners);
    } catch (e) { setBannerError(e instanceof Error ? e.message : "We couldn't create them. Please try again."); }
    setGenBanners(false);
  }

  async function regenerateBanner(sizeId: string) {
    setRegenSize(sizeId);
    try {
      const r = await fetch("/api/banners", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...bannerPayload(), singleSize: sizeId }) });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      if (data.banners?.[0]) {
        setBanners((prev) => prev.map((b) => `${b.width}x${b.height}` === sizeId ? data.banners[0] : b));
      }
    } catch (e) { setBannerError(e instanceof Error ? e.message : "We couldn't create it again. Please try once more."); }
    setRegenSize(null);
  }

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).slice(0, 5).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const [header, base64] = dataUrl.split(",");
        const mimeType = header.match(/data:([^;]+)/)?.[1] || "image/png";
        setUploadedImages((prev) => [...prev, { base64, mimeType, preview: dataUrl, name: file.name }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  }

  async function saveDraft(): Promise<string | null> {
    setSaving(true); setError(null);
    try {
      const urls = selectedUrls.map((c) => ({ url: c.url, domain: c.domain.replace(/^www\./, "").replace(/^m\./, "") }));
      const r = await fetch("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId: brand.id, brandName: brand.name, brandWebsite: brand.website, workspaceId: brand.workspace_id, campaignName, landingPageUrl: landingPage, dailyBudgetCents: Math.round(dailyBudget * 100), urls }) });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setSavedCampaignId(data.campaign.id);
      setSaving(false);
      return data.campaign.id as string;
    } catch (e) { setError(e instanceof Error ? e.message : "We couldn't save it. Please try again."); }
    setSaving(false);
    return null;
  }

  // ONE-CLICK create: save the draft (if needed) and publish it to Google Ads
  // in a single action. The campaign is always created PAUSED, so nothing is
  // spent until the user activates it inside Google Ads. This replaces the old
  // 3-button "guardar / guardar y publicar / publicar" cluster with one clear
  // step, while saveDraft/publishToGoogleAds stay available underneath.
  async function createCampaignPaused() {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "We're going to create your campaign in your Google Ads account.\n\nIt will be PAUSED, so nothing is spent yet: you decide when to turn it on inside Google Ads.\n\nShall we continue?",
      );
      if (!ok) return;
    }
    setPublishing(true); setError(null);
    try {
      let id = savedCampaignId;
      if (!id) {
        id = await saveDraft();
        if (!id) { setPublishing(false); return; }
      }
      const r = await fetch("/api/campaigns/publish", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: id }) });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setPublishResult({ googleCampaignId: data.googleCampaignId, placementsAdded: data.placementsAdded });
    } catch (e) { setError(e instanceof Error ? e.message : "We couldn't create the campaign. Please try again."); }
    setPublishing(false);
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
    } catch (e) { setError(e instanceof Error ? e.message : "We couldn't publish it. Please try again."); }
    setPublishing(false);
  }

  const steps: { key: Step; label: string }[] = [
    { key: "brand", label: "Brand" }, { key: "placements", label: "Where to show" },
    { key: "creatives", label: "Your ads" }, { key: "review", label: "Review" },
  ];
  const stepIdx = steps.findIndex((s) => s.key === step);

  return (
    <div className="min-h-screen">
      <Header breadcrumbs={[{ label: "Brands", href: "/brands" }, { label: brand.name, href: `/brands/${brand.id}/citations` }, { label: "Campaigns", href: `/brands/${brand.id}/campaigns` }, { label: "New display campaign" }]} />

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
            <h1 className="text-2xl font-bold mb-2">Your brand</h1>
            <p style={{ color: colors.textMuted, marginBottom: 24 }}>We took a look at {brand.website} to get to know your brand. Review the details and change them if you like.</p>

            {scraping ? (
              <div className="py-12 text-center animate-pulse" style={{ color: colors.textMuted }}>We&apos;re taking a look at {brand.website}…</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Left: extracted data */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {(profile?.ogImage || profile?.logo || brand.logo_url) && (
                    <div>
                      <label style={lbl}>Brand image</label>
                      <img src={profile?.ogImage || profile?.logo || brand.logo_url || ""} alt={brand.name}
                        style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, border: `1px solid ${colors.border}` }} />
                    </div>
                  )}
                  <div><label style={lbl}>Brand name</label><p style={{ fontSize: 16, fontWeight: 600 }}>{brand.name}</p></div>
                  <div><label style={lbl}>Industry</label><p style={{ fontSize: 14, color: colors.textMuted }}>{brand.industry}</p></div>
                  {profile?.colors && profile.colors.length > 0 && (
                    <div>
                      <label style={lbl}>Colors we found</label>
                      <div className="flex gap-2">{profile.colors.slice(0, 6).map((c) => (
                        <div key={c} style={{ width: 32, height: 32, borderRadius: 6, background: c, border: `1px solid ${colors.border}` }} title={c} />
                      ))}</div>
                    </div>
                  )}
                </div>

                {/* Right: editable fields */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div><label style={lbl}>Campaign name</label><input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} style={inp} /></div>
                  <div><label style={lbl}>Brand description (we use it for your ad text)</label>
                    <textarea value={brandDesc} onChange={(e) => setBrandDesc(e.target.value)} rows={3}
                      style={{ ...inp, resize: 'vertical' as const }} /></div>
                  <div><label style={lbl}>Tagline</label><input value={brandTagline} onChange={(e) => setBrandTagline(e.target.value)} style={inp} /></div>
                  <div><label style={lbl}>Landing page</label><input value={landingPage} onChange={(e) => setLandingPage(e.target.value)} style={inp} /></div>
                  <div>
                    <label style={lbl}>Daily budget (USD)</label>
                    <input type="number" min={1} step={1} value={dailyBudget} onChange={(e) => setDailyBudget(Number(e.target.value))} style={inp} />
                    <p style={{ fontSize: 11, color: colors.textFaint, marginTop: 4 }}>The campaign is created PAUSED. Nothing is spent until you turn it on.</p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end mt-8">
              <button onClick={() => setStep("placements")} style={{ padding: '10px 24px', borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 600, fontSize: 14, border: 'none', cursor: 'pointer' }}>
                Next: Choose where to show →
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: Placements */}
        {step === "placements" && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Choose where to show</h1>
            <p style={{ color: colors.textMuted, marginBottom: 8 }}>
              {adLoading ? "We're checking which websites can show your ads…" : `We can show your ads on ${targetable.length} of ${citations.length} websites. We've already checked them all; uncheck any you don't want.`}
            </p>

            {adLoading && (
              <div className="py-8 text-center animate-pulse" style={{ background: colors.bgCard, borderRadius: 12, marginBottom: 16 }}>
                <p style={{ fontSize: 14, color: colors.textMuted }}>We&apos;re checking which websites can show your ads…</p>
                <p style={{ fontSize: 12, color: colors.textFaint, marginTop: 4 }}>This may take a moment</p>
              </div>
            )}

            {!adLoading && (
              <>
                <div className="flex gap-3 mb-4">
                  <button onClick={() => setSelected(new Set(targetable.map((c) => c.url)))}
                    style={{ padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', color: colors.accent, cursor: 'pointer' }}>
                    Check all available ({targetable.length})
                  </button>
                  <button onClick={() => setSelected(new Set())}
                    style={{ padding: '6px 12px', borderRadius: 6, fontSize: 12, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textMuted, cursor: 'pointer' }}>
                    Uncheck all
                  </button>
                  <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600, alignSelf: 'center' }}>{selected.size} chosen</span>
                </div>

                <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${colors.border}`, maxHeight: 500, overflow: 'auto' }}>
                  <table className="w-full">
                    <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                      <tr style={{ background: colors.bgCard, borderBottom: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 12 }} className="text-left">
                        <th className="px-3 py-2 w-10"></th>
                        <th className="px-3 py-2 font-medium">Website</th>
                        <th className="px-3 py-2 font-medium">Address</th>
                        <th className="px-3 py-2 font-medium text-right">Mentions</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody style={{ background: colors.bg }}>
                      {citations.map((c) => {
                        const d = c.domain.replace(/^www\./, "").replace(/^m\./, "");
                        const info = adData[d];
                        const isTargetable = info?.hasGdn;
                        const sel = selected.has(c.url);
                        const isYT = info?.networks.includes("YouTube");
                        return (
                          <tr key={c.url} style={{ borderBottom: `1px solid ${colors.bgCard}`, background: sel ? 'rgba(16,185,129,0.04)' : undefined, opacity: isTargetable ? (sel ? 1 : 0.6) : 0.3 }}>
                            <td className="px-3 py-2">
                              {isTargetable ? (
                                <input type="checkbox" checked={sel} onChange={() => toggleUrl(c.url)}
                                  style={{ width: 16, height: 16, cursor: 'pointer', accentColor: colors.accent }} />
                              ) : (
                                <span style={{ width: 16, height: 16, display: 'block' }} />
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <img src={`https://www.google.com/s2/favicons?domain=${d}&sz=16`} alt="" width={16} height={16} style={{ borderRadius: 2 }} />
                                <span style={{ fontSize: 12, fontWeight: 500 }}>{d}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2" style={{ fontSize: 11, color: colors.textMuted, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {c.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 50)}
                            </td>
                            <td className="px-3 py-2 text-right font-mono" style={{ fontSize: 12 }}>{c.citation_count}</td>
                            <td className="px-3 py-2">
                              {isTargetable ? (
                                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 99, background: isYT ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)', color: isYT ? '#EF4444' : '#10B981' }}>
                                  {isYT ? "YouTube" : "Available"}
                                </span>
                              ) : (
                                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 99, background: 'rgba(161,161,170,0.1)', color: 'rgba(161,161,170,0.5)' }}>
                                  Not available here
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div className="flex flex-col items-stretch gap-3 mt-8">
              {!adLoading && selected.size === 0 && (
                <p style={{ fontSize: 12, color: colors.textMuted, textAlign: 'right' }}>
                  You haven&apos;t checked any websites. No worries: Google will automatically pick where to show your ads. If you prefer, check the specific websites above where you want to appear.
                </p>
              )}
              <div className="flex justify-between">
                <button onClick={() => setStep("brand")} style={{ padding: '10px 24px', borderRadius: 8, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 14, cursor: 'pointer' }}>← Back</button>
                <button onClick={() => setStep("creatives")}
                  style={{ padding: '10px 24px', borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 600, fontSize: 14, border: 'none', cursor: 'pointer' }}>
                  Next: Create your ads →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: Creatives */}
        {step === "creatives" && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Create your ads</h1>
            <p style={{ color: colors.textMuted, marginBottom: 24 }}>Upload images of your brand and we&apos;ll create great-looking ads for you.</p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Left: controls */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Image upload */}
                <div>
                  <label style={lbl}>Images of your brand (logo, product photos)</label>
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, borderRadius: 8, border: `2px dashed ${colors.border}`, cursor: 'pointer', color: colors.textMuted, fontSize: 13 }}>
                    <input type="file" accept="image/*" multiple onChange={handleImageUpload} style={{ display: 'none' }} />
                    📎 Upload images (up to 5)
                  </label>
                  {uploadedImages.length > 0 && (
                    <div className="flex gap-2 mt-2 flex-wrap">
                      {uploadedImages.map((img, i) => (
                        <div key={i} style={{ position: 'relative' }}>
                          <img src={img.preview} alt={img.name} style={{ width: 56, height: 56, borderRadius: 6, objectFit: 'cover', border: `1px solid ${colors.border}` }} />
                          <button onClick={() => setUploadedImages((p) => p.filter((_, j) => j !== i))}
                            style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 99, background: '#EF4444', color: '#fff', border: 'none', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <p style={{ fontSize: 10, color: colors.textFaint, marginTop: 4 }}>
                    {uploadedImages.length > 0 ? `${uploadedImages.length} image${uploadedImages.length > 1 ? 's' : ''} — we'll use them in your ads` : "Upload your logo for a better result"}
                  </p>
                </div>

                <div><label style={lbl}>Tagline</label><input value={brandTagline} onChange={(e) => setBrandTagline(e.target.value)} style={inp} /></div>
                <div><label style={lbl}>Button text</label><input value={cta} onChange={(e) => setCta(e.target.value)} style={inp} /></div>
                <div><label style={lbl}>Colors and style</label><input value={colorStyle} onChange={(e) => setColorStyle(e.target.value)} style={inp} /></div>
                <div>
                  <label style={lbl}>Sizes</label>
                  <div className="flex flex-wrap gap-2">
                    {SIZES.map((s) => (
                      <button key={s.id} onClick={() => setSelectedSizes((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })}
                        style={{ padding: '4px 8px', borderRadius: 6, fontSize: 11, background: selectedSizes.has(s.id) ? 'rgba(16,185,129,0.15)' : 'transparent',
                          border: `1px solid ${selectedSizes.has(s.id) ? 'rgba(16,185,129,0.4)' : colors.border}`, color: selectedSizes.has(s.id) ? colors.accent : colors.textMuted, cursor: 'pointer' }}>
                        {s.desc}
                      </button>
                    ))}
                  </div>
                  <p style={{ fontSize: 10, color: colors.textFaint, marginTop: 6 }}>Choose the formats where you want your ad to appear. If you&apos;re not sure, just leave the ones already checked.</p>
                </div>
                <button onClick={generateBanners} disabled={genBanners || selectedSizes.size === 0}
                  style={{ padding: 11, borderRadius: 8, background: 'rgba(99,102,241,0.8)', color: '#fff', fontWeight: 600, fontSize: 13, border: 'none',
                    cursor: genBanners ? 'not-allowed' : 'pointer', opacity: genBanners ? 0.7 : 1 }}>
                  {genBanners ? "Creating…" : `Create ${selectedSizes.size} ad${selectedSizes.size > 1 ? 's' : ''}`}
                </button>
                {bannerError && <p style={{ fontSize: 12, color: '#F87171' }}>{bannerError}</p>}
              </div>

              {/* Right: previews */}
              <div className="md:col-span-2">
                {banners.length === 0 && !genBanners && (
                  <div className="py-16 text-center" style={{ border: `2px dashed ${colors.border}`, borderRadius: 12 }}>
                    <p style={{ color: colors.textMuted, fontSize: 14 }}>
                      {uploadedImages.length > 0 ? `${uploadedImages.length} images ready. Press Create.` : "Upload images of your brand and press Create."}
                    </p>
                  </div>
                )}
                {genBanners && (
                  <div className="py-16 text-center animate-pulse" style={{ border: `2px dashed ${colors.border}`, borderRadius: 12 }}>
                    <p style={{ color: colors.textMuted, fontSize: 14 }}>We&apos;re creating your ads{uploadedImages.length > 0 ? " with your brand images" : ""}…</p>
                  </div>
                )}
                {banners.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {banners.map((b, i) => {
                      const sizeId = `${b.width}x${b.height}`;
                      const isRegen = regenSize === sizeId;
                      const sizeLabel = SIZES.find((s) => s.id === sizeId)?.desc || b.name;
                      return (
                        <div key={i} style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 12, opacity: isRegen ? 0.5 : 1 }}>
                          <div className="flex items-center justify-between mb-2">
                            <span style={{ fontSize: 12, color: colors.textMuted }}>{sizeLabel}</span>
                            <div className="flex gap-3">
                              <button onClick={() => regenerateBanner(sizeId)} disabled={!!regenSize}
                                style={{ fontSize: 11, color: 'rgba(99,102,241,0.8)', background: 'none', border: 'none', cursor: regenSize ? 'not-allowed' : 'pointer' }}>
                                {isRegen ? "Creating again…" : "🔄 Create again"}
                              </button>
                              <a href={b.dataUrl} download={`${brand.name}-${sizeId}.png`} style={{ fontSize: 11, color: colors.accent, textDecoration: 'none' }}>⬇ Download</a>
                            </div>
                          </div>
                          <img src={b.dataUrl} alt={b.name} style={{ maxWidth: '100%', borderRadius: 6, border: `1px solid ${colors.border}` }} />
                        </div>
                      );
                    })}
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
                <h1 className="text-3xl font-bold mb-4">Your campaign is in Google Ads!</h1>
                <p style={{ fontSize: 15, color: colors.textMuted, marginBottom: 8 }}>Your ads can appear on {publishResult.placementsAdded} websites · {banners.length} ads created</p>
                <p style={{ fontSize: 13, color: colors.textFaint, marginBottom: 8 }}>Your Google Ads campaign number: {publishResult.googleCampaignId}</p>
                <p style={{ fontSize: 14, color: '#FBBF24', fontWeight: 600, marginBottom: 24 }}>Status: PAUSED — turn it on in Google Ads whenever you like</p>
                <button onClick={() => router.push(`/brands/${brand.id}/citations`)}
                  style={{ padding: '12px 32px', borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 600, fontSize: 14, border: 'none', cursor: 'pointer' }}>
                  Back to mentions
                </button>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-bold mb-6">Review</h1>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16 }}>
                    <p style={{ ...lbl }}>Campaign</p>
                    <p style={{ fontSize: 16, fontWeight: 600 }}>{campaignName}</p>
                    <p style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>{landingPage}</p>
                  </div>
                  <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16 }}>
                    <p style={{ ...lbl }}>Where to show</p>
                    <p style={{ fontSize: 28, fontWeight: 700 }}>{selected.size}</p>
                    <p style={{ fontSize: 12, color: colors.textMuted }}>websites chosen</p>
                  </div>
                  <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16 }}>
                    <p style={{ ...lbl }}>Budget</p>
                    <p style={{ fontSize: 28, fontWeight: 700 }}>${dailyBudget}</p>
                    <p style={{ fontSize: 12, color: colors.textMuted }}>per day (paused)</p>
                  </div>
                </div>

                {banners.length > 0 && (
                  <div className="mb-6">
                    <p style={{ ...lbl, marginBottom: 12 }}>Your ads ({banners.length})</p>
                    <div className="flex gap-3 overflow-x-auto pb-2">
                      {banners.map((b, i) => (
                        <img key={i} src={b.dataUrl} alt={b.name} style={{ height: 100, borderRadius: 6, border: `1px solid ${colors.border}` }} />
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 8, padding: 14, marginBottom: 24 }}>
                  <p style={{ fontSize: 13, color: '#FBBF24' }}>Your campaign will be created <strong>PAUSED</strong> in Google Ads. Nothing will be spent until you turn it on.</p>
                </div>

                {error && <p style={{ fontSize: 13, color: '#F87171', marginBottom: 16 }}>{error}</p>}

                <div className="flex justify-between items-center" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <button onClick={() => setStep("creatives")} style={{ padding: '10px 24px', borderRadius: 8, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 14, cursor: 'pointer' }}>← Back</button>
                  <button onClick={createCampaignPaused} disabled={publishing || saving}
                    style={{ padding: '13px 30px', borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 700, fontSize: 15, border: 'none',
                      cursor: publishing || saving ? 'not-allowed' : 'pointer', opacity: publishing || saving ? 0.7 : 1 }}>
                    {publishing || saving ? "Creating your campaign…" : "Create my campaign (paused)"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
