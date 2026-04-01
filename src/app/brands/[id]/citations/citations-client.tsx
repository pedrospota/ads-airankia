"use client";

import { useEffect, useState, useMemo } from "react";
import { Header } from "@/components/header";
import { GdnBadge, NetworkPills } from "@/components/gdn-badge";
import { useTheme } from "@/components/theme-provider";

interface Brand { id: string; name: string; industry: string | null; website: string | null; logo_url: string | null; workspace_id?: string; }
interface Citation { url: string; domain: string; citation_count: number; models: string[]; gdn_available: boolean; }
interface AdInfo { hasGdn: boolean; gdnPubId: string | null; networks: string[]; checkedAt: string | null; }

const PAGE_SIZE = 50;

export function CitationsClient({ brand, citations, error }: { brand: Brand; citations: Citation[]; error: string | null; }) {
  const { colors } = useTheme();
  const [adData, setAdData] = useState<Record<string, AdInfo>>({});
  const [adLoading, setAdLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [networkFilter, setNetworkFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [campaignResult, setCampaignResult] = useState<{ id: string; placementCount: number } | null>(null);

  function fetchAdData(force = false) {
    const domains = [...new Set(citations.map((c) => c.domain.replace(/^www\./, "")))];
    if (domains.length === 0) { setAdLoading(false); return; }
    if (force) setRefreshing(true); else setAdLoading(true);
    fetch("/api/check-gdn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domains, force }) })
      .then((r) => r.json())
      .then((data) => { const map: Record<string, AdInfo> = {}; for (const r of data.results || []) { map[r.domain] = { hasGdn: r.hasGdn, gdnPubId: r.gdnPubId, networks: r.networks || [], checkedAt: r.checkedAt || null }; } setAdData(map); })
      .catch(() => {}).finally(() => { setAdLoading(false); setRefreshing(false); });
  }
  useEffect(() => { fetchAdData(); }, [citations]);

  const allNetworks = useMemo(() => { const nets = new Set<string>(); Object.values(adData).forEach((a) => a.networks.forEach((n) => nets.add(n))); return [...nets].sort(); }, [adData]);

  const filtered = useMemo(() => {
    if (networkFilter === "all") return citations;
    if (networkFilter === "gdn") return citations.filter((c) => adData[c.domain.replace(/^www\./, "")]?.hasGdn);
    if (networkFilter === "no-ads") return citations.filter((c) => { const i = adData[c.domain.replace(/^www\./, "")]; return i && !i.hasGdn && i.networks.length === 0; });
    return citations.filter((c) => adData[c.domain.replace(/^www\./, "")]?.networks.includes(networkFilter));
  }, [citations, adData, networkFilter]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  useEffect(() => { setPage(0); }, [networkFilter]);

  const gdnCount = Object.values(adData).filter((a) => a.hasGdn).length;
  const totalCitations = citations.reduce((s, c) => s + c.citation_count, 0);
  const uniqueDomains = new Set(citations.map((c) => c.domain)).size;

  const oldestCheck = useMemo(() => { const d = Object.values(adData).filter((a) => a.checkedAt).map((a) => new Date(a.checkedAt!).getTime()); return d.length ? new Date(Math.min(...d)) : null; }, [adData]);

  const gdnCitations = useMemo(() => citations.filter((c) => adData[c.domain.replace(/^www\./, "")]?.hasGdn), [citations, adData]);
  function toggleSelect(url: string) { setSelected((p) => { const n = new Set(p); if (n.has(url)) n.delete(url); else n.add(url); return n; }); }
  function selectAllGdn() { setSelected(new Set(gdnCitations.map((c) => c.url))); }

  async function createCampaign(name: string, landingPage: string, dailyBudget: number) {
    setCreating(true);
    const urls = citations.filter((c) => selected.has(c.url)).map((c) => ({ url: c.url, domain: c.domain.replace(/^www\./, "") }));
    try {
      const r = await fetch("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId: brand.id, brandName: brand.name, brandWebsite: brand.website, workspaceId: brand.workspace_id || "", campaignName: name, landingPageUrl: landingPage, dailyBudgetCents: Math.round(dailyBudget * 100), urls }) });
      const data = await r.json();
      if (data.campaign) setCampaignResult(data.campaign);
    } catch { }
    setCreating(false);
  }

  return (
    <div className="min-h-screen">
      <Header breadcrumbs={[{ label: "Brands", href: "/brands" }, { label: brand.name }, { label: "Citations" }]}
        action={selected.size > 0 ? (
          <button onClick={() => setShowModal(true)} style={{ padding: '8px 16px', borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 600, fontSize: 13, border: 'none', cursor: 'pointer' }}>
            Create Campaign ({selected.size} URLs)
          </button>
        ) : undefined} />

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-8">
          {brand.logo_url ? <img src={brand.logo_url} alt={brand.name} className="w-16 h-16 rounded-xl object-cover" style={{ background: colors.bgCard }} /> :
            <div className="w-16 h-16 rounded-xl flex items-center justify-center font-bold text-2xl" style={{ background: colors.bgCard, color: colors.textFaint }}>{brand.name.charAt(0)}</div>}
          <div><h1 className="text-3xl font-bold">{brand.name}</h1><p style={{ color: colors.textMuted }}>{brand.industry}</p></div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[{ l: "Total Citations", v: totalCitations.toLocaleString() }, { l: "Unique Sources", v: uniqueDomains.toString() }, { l: "Ad Networks", v: adLoading ? "..." : allNetworks.length.toString() }, { l: "GDN Available", v: adLoading ? "..." : gdnCount.toString(), a: true }]
            .map((k) => (<div key={k.l} className="p-4 rounded-xl" style={{ background: colors.bgCard, border: `1px solid ${colors.border}` }}><p style={{ fontSize: 13, color: colors.textMuted }}>{k.l}</p><p className="text-2xl font-bold mt-1" style={{ color: k.a ? colors.accent : colors.text }}>{k.v}</p></div>))}
        </div>

        {error && <div style={{ padding: 16, borderRadius: 8, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', color: '#F87171', marginBottom: 24 }}>{error}</div>}

        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <select value={networkFilter} onChange={(e) => setNetworkFilter(e.target.value)} style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, color: colors.text, cursor: 'pointer', outline: 'none' }}>
              <option value="all">All Sources ({citations.length})</option><option value="gdn">GDN Only ({gdnCount})</option><option value="no-ads">No Ads</option>
              {allNetworks.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            {!adLoading && gdnCount > 0 && <button onClick={selectAllGdn} style={{ padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', color: colors.accent, cursor: 'pointer' }}>Select all GDN ({gdnCount})</button>}
            {selected.size > 0 && <button onClick={() => setSelected(new Set())} style={{ padding: '6px 12px', borderRadius: 6, fontSize: 12, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textMuted, cursor: 'pointer' }}>Clear ({selected.size})</button>}
            <span style={{ fontSize: 12, color: colors.textFaint }}>{filtered.length} results</span>
          </div>
          <div className="flex items-center gap-3">
            {oldestCheck && <span style={{ fontSize: 11, color: colors.textFaint }}>Scanned {oldestCheck.toLocaleDateString()}</span>}
            <button onClick={() => fetchAdData(true)} disabled={refreshing} style={{ padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textMuted, cursor: refreshing ? 'not-allowed' : 'pointer', opacity: refreshing ? 0.5 : 1 }}>
              {refreshing ? "Scanning..." : "Rescan All"}
            </button>
          </div>
        </div>

        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr style={{ background: colors.bgCard, borderBottom: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 13 }} className="text-left">
                <th className="px-3 py-3 w-10"></th><th className="px-3 py-3 font-medium">URL</th><th className="px-3 py-3 font-medium">Domain</th><th className="px-3 py-3 font-medium text-right">Citations</th><th className="px-3 py-3 font-medium">Ad Inventory</th><th className="px-3 py-3 font-medium">Networks</th>
              </tr></thead>
              <tbody style={{ background: colors.bg }}>
                {paginated.map((c) => { const d = c.domain.replace(/^www\./, ""); const info = adData[d]; const isGdn = info?.hasGdn; const sel = selected.has(c.url); return (
                  <tr key={c.url} style={{ borderBottom: `1px solid ${colors.bgCard}`, background: sel ? 'rgba(16,185,129,0.05)' : undefined }}>
                    <td className="px-3 py-3">{isGdn && <input type="checkbox" checked={sel} onChange={() => toggleSelect(c.url)} style={{ width: 16, height: 16, cursor: 'pointer', accentColor: colors.accent }} />}</td>
                    <td className="px-3 py-3"><a href={c.url.startsWith("http") ? c.url : `https://${c.url}`} target="_blank" rel="noopener noreferrer" className="truncate block max-w-sm" style={{ fontSize: 13, color: '#60A5FA' }}>{c.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}</a></td>
                    <td className="px-3 py-3" style={{ fontSize: 13, color: colors.textMuted }}>{d}</td>
                    <td className="px-3 py-3 font-mono text-right" style={{ fontSize: 13 }}>{c.citation_count}</td>
                    <td className="px-3 py-3"><GdnBadge adInfo={adLoading ? undefined : info} /></td>
                    <td className="px-3 py-3">{!adLoading && info && <NetworkPills networks={info.networks} />}</td>
                  </tr>); })}
              </tbody>
            </table>
          </div>
          {citations.length === 0 && !error && <div className="px-6 py-12 text-center" style={{ color: colors.textMuted }}><p>No citations found yet.</p></div>}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <span style={{ fontSize: 13, color: colors.textMuted }}>Page {page + 1} of {totalPages}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 13, background: colors.bgCard, border: `1px solid ${colors.border}`, color: page === 0 ? colors.textFaint : colors.text, cursor: page === 0 ? 'not-allowed' : 'pointer' }}>Previous</button>
              <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 13, background: colors.bgCard, border: `1px solid ${colors.border}`, color: page >= totalPages - 1 ? colors.textFaint : colors.text, cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}>Next</button>
            </div>
          </div>
        )}
      </main>

      {showModal && <CampaignModal colors={colors} brand={brand} selectedCount={selected.size}
        onClose={() => { setShowModal(false); setCampaignResult(null); }} onCreate={createCampaign} creating={creating} result={campaignResult} />}
    </div>
  );
}

function CampaignModal({ colors, brand, selectedCount, onClose, onCreate, creating, result }: {
  colors: ReturnType<typeof useTheme>["colors"]; brand: { name: string; website: string | null }; selectedCount: number;
  onClose: () => void; onCreate: (n: string, l: string, b: number) => void; creating: boolean; result: { id: string; placementCount: number } | null;
}) {
  const [name, setName] = useState(`${brand.name} - Citation Retargeting`);
  const [lp, setLp] = useState(brand.website || "");
  const [budget, setBudget] = useState(0);
  const inp = { width: '100%' as const, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: colors.text, outline: 'none', boxSizing: 'border-box' as const };
  const lbl = { display: 'block' as const, fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: colors.textMuted, marginBottom: 7, textTransform: 'uppercase' as const };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 16, padding: 32, maxWidth: 480, width: '100%', boxShadow: '0 24px 48px rgba(0,0,0,0.4)' }}>
        {result ? (
          <div className="text-center">
            <div style={{ width: 56, height: 56, borderRadius: 99, background: 'rgba(16,185,129,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Campaign Created</h2>
            <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 4 }}>{result.placementCount} URL placements saved</p>
            <p style={{ fontSize: 12, color: colors.textFaint, marginBottom: 24 }}>Status: <strong style={{ color: '#FBBF24' }}>Draft</strong> — Saved but not yet live. Set budget and activate when ready.</p>
            <button onClick={onClose} style={{ padding: '10px 24px', borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 600, fontSize: 13, border: 'none', cursor: 'pointer' }}>Done</button>
          </div>
        ) : (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Create Campaign</h2>
            <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 24 }}>{selectedCount} GDN placements for {brand.name}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div><label style={lbl}>Campaign Name</label><input value={name} onChange={(e) => setName(e.target.value)} style={inp} /></div>
              <div><label style={lbl}>Landing Page URL</label><input value={lp} onChange={(e) => setLp(e.target.value)} placeholder="https://yoursite.com" style={inp} /></div>
              <div>
                <label style={lbl}>Daily Budget (USD) — $0 = paused, set later</label>
                <input type="number" min={0} step={1} value={budget} onChange={(e) => setBudget(Number(e.target.value))} style={inp} />
                <p style={{ fontSize: 11, color: colors.textFaint, marginTop: 4 }}>Campaign created PAUSED. You activate it when ready.</p>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={onClose} style={{ flex: 1, padding: 10, borderRadius: 8, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => onCreate(name, lp, budget)} disabled={creating || !name} style={{ flex: 1, padding: 10, borderRadius: 8, background: colors.accent, color: '#000', fontWeight: 600, fontSize: 13, border: 'none', cursor: creating ? 'not-allowed' : 'pointer', opacity: creating ? 0.7 : 1 }}>
                {creating ? "Creating..." : "Create Campaign"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
