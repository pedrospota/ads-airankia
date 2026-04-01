"use client";

import { useEffect, useState, useMemo } from "react";
import { Header } from "@/components/header";
import { GdnBadge, NetworkPills } from "@/components/gdn-badge";
import { useTheme } from "@/components/theme-provider";

interface Brand {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  logo_url: string | null;
}

interface Citation {
  url: string;
  domain: string;
  citation_count: number;
  models: string[];
  gdn_available: boolean;
}

interface AdInfo {
  hasGdn: boolean;
  gdnPubId: string | null;
  networks: string[];
  checkedAt: string | null;
}

const PAGE_SIZE = 50;

export function CitationsClient({
  brand,
  citations,
  error,
}: {
  brand: Brand;
  citations: Citation[];
  error: string | null;
}) {
  const { colors } = useTheme();
  const [adData, setAdData] = useState<Record<string, AdInfo>>({});
  const [adLoading, setAdLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [networkFilter, setNetworkFilter] = useState<string>("all");
  const [page, setPage] = useState(0);

  // Fetch GDN data
  function fetchAdData(force = false) {
    const domains = [...new Set(citations.map((c) => c.domain.replace(/^www\./, "")))];
    if (domains.length === 0) { setAdLoading(false); return; }

    if (force) setRefreshing(true);
    else setAdLoading(true);

    fetch("/api/check-gdn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains, force }),
    })
      .then((r) => r.json())
      .then((data) => {
        const map: Record<string, AdInfo> = {};
        for (const r of data.results || []) {
          map[r.domain] = { hasGdn: r.hasGdn, gdnPubId: r.gdnPubId, networks: r.networks || [], checkedAt: r.checkedAt || null };
        }
        setAdData(map);
      })
      .catch(() => {})
      .finally(() => { setAdLoading(false); setRefreshing(false); });
  }

  useEffect(() => { fetchAdData(); }, [citations]);

  // Collect all unique networks for filter dropdown
  const allNetworks = useMemo(() => {
    const nets = new Set<string>();
    Object.values(adData).forEach((a) => a.networks.forEach((n) => nets.add(n)));
    return [...nets].sort();
  }, [adData]);

  // Filter citations by network
  const filtered = useMemo(() => {
    if (networkFilter === "all") return citations;
    if (networkFilter === "gdn") return citations.filter((c) => adData[c.domain.replace(/^www\./, "")]?.hasGdn);
    if (networkFilter === "no-ads") return citations.filter((c) => {
      const info = adData[c.domain.replace(/^www\./, "")];
      return info && !info.hasGdn && info.networks.length === 0;
    });
    return citations.filter((c) => {
      const info = adData[c.domain.replace(/^www\./, "")];
      return info?.networks.includes(networkFilter);
    });
  }, [citations, adData, networkFilter]);

  // Paginate
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Reset page when filter changes
  useEffect(() => { setPage(0); }, [networkFilter]);

  // KPIs
  const gdnCount = Object.values(adData).filter((a) => a.hasGdn).length;
  const totalCitations = citations.reduce((sum, c) => sum + c.citation_count, 0);
  const uniqueDomains = new Set(citations.map((c) => c.domain)).size;
  const networksCount = allNetworks.length;

  // Oldest check date
  const oldestCheck = useMemo(() => {
    const dates = Object.values(adData).filter((a) => a.checkedAt).map((a) => new Date(a.checkedAt!).getTime());
    if (dates.length === 0) return null;
    return new Date(Math.min(...dates));
  }, [adData]);

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Brands", href: "/brands" },
          { label: brand.name },
          { label: "Citations" },
        ]}
        action={
          <button style={{
            padding: '8px 16px', borderRadius: 8, background: colors.accent,
            color: '#000', fontWeight: 600, fontSize: 13, border: 'none', cursor: 'pointer'
          }}>
            Start Campaign
          </button>
        }
      />

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Brand header */}
        <div className="flex items-center gap-4 mb-8">
          {brand.logo_url ? (
            <img src={brand.logo_url} alt={brand.name}
              className="w-16 h-16 rounded-xl object-cover" style={{ background: colors.bgCard }} />
          ) : (
            <div className="w-16 h-16 rounded-xl flex items-center justify-center font-bold text-2xl"
              style={{ background: colors.bgCard, color: colors.textFaint }}>
              {brand.name.charAt(0)}
            </div>
          )}
          <div>
            <h1 className="text-3xl font-bold">{brand.name}</h1>
            <p style={{ color: colors.textMuted }}>{brand.industry}</p>
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: "Total Citations", value: totalCitations.toLocaleString() },
            { label: "Unique Sources", value: uniqueDomains.toString() },
            { label: "Ad Networks Found", value: adLoading ? "..." : networksCount.toString() },
            { label: "GDN Available", value: adLoading ? "..." : gdnCount.toString(), accent: true },
          ].map((kpi) => (
            <div key={kpi.label} className="p-4 rounded-xl"
              style={{ background: colors.bgCard, border: `1px solid ${colors.border}` }}>
              <p style={{ fontSize: 13, color: colors.textMuted }}>{kpi.label}</p>
              <p className="text-2xl font-bold mt-1" style={{ color: kpi.accent ? colors.accent : colors.text }}>
                {kpi.value}
              </p>
            </div>
          ))}
        </div>

        {error && (
          <div style={{ padding: 16, borderRadius: 8, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', color: '#F87171', marginBottom: 24 }}>
            {error}
          </div>
        )}

        {/* Filters + refresh bar */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <select
              value={networkFilter}
              onChange={(e) => setNetworkFilter(e.target.value)}
              style={{
                background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 8,
                padding: '8px 12px', fontSize: 13, color: colors.text, cursor: 'pointer', outline: 'none',
              }}
            >
              <option value="all">All Sources ({citations.length})</option>
              <option value="gdn">GDN Only ({gdnCount})</option>
              <option value="no-ads">No Ads</option>
              {allNetworks.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: colors.textFaint }}>
              {filtered.length} result{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {oldestCheck && (
              <span style={{ fontSize: 11, color: colors.textFaint }}>
                Scanned {oldestCheck.toLocaleDateString()}
              </span>
            )}
            <button
              onClick={() => fetchAdData(true)}
              disabled={refreshing}
              style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                background: 'transparent', border: `1px solid ${colors.border}`,
                color: colors.textMuted, cursor: refreshing ? 'not-allowed' : 'pointer',
                opacity: refreshing ? 0.5 : 1,
              }}
            >
              {refreshing ? "Scanning..." : "Rescan All"}
            </button>
          </div>
        </div>

        {/* Citation table */}
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ background: colors.bgCard, borderBottom: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 13 }} className="text-left">
                  <th className="px-6 py-3 font-medium">URL</th>
                  <th className="px-6 py-3 font-medium">Domain</th>
                  <th className="px-6 py-3 font-medium text-right">Citations</th>
                  <th className="px-6 py-3 font-medium">Ad Inventory</th>
                  <th className="px-6 py-3 font-medium">Networks</th>
                </tr>
              </thead>
              <tbody style={{ background: colors.bg }}>
                {paginated.map((citation) => {
                  const cleanDomain = citation.domain.replace(/^www\./, "");
                  const info = adData[cleanDomain];
                  return (
                    <tr key={citation.url} style={{ borderBottom: `1px solid ${colors.bgCard}` }}>
                      <td className="px-6 py-3">
                        <a
                          href={citation.url.startsWith("http") ? citation.url : `https://${citation.url}`}
                          target="_blank" rel="noopener noreferrer"
                          className="truncate block max-w-sm"
                          style={{ fontSize: 13, color: '#60A5FA' }}
                        >
                          {citation.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}
                        </a>
                      </td>
                      <td className="px-6 py-3" style={{ fontSize: 13, color: colors.textMuted }}>
                        {cleanDomain}
                      </td>
                      <td className="px-6 py-3 font-mono text-right" style={{ fontSize: 13 }}>
                        {citation.citation_count}
                      </td>
                      <td className="px-6 py-3">
                        <GdnBadge adInfo={adLoading ? undefined : info} />
                      </td>
                      <td className="px-6 py-3">
                        {!adLoading && info && <NetworkPills networks={info.networks} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {citations.length === 0 && !error && (
            <div className="px-6 py-12 text-center" style={{ color: colors.textMuted }}>
              <p>No citations found for this brand yet.</p>
              <p style={{ fontSize: 13, marginTop: 8 }}>
                Run monitored prompts in AI Rankia to start collecting citation data.
              </p>
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <span style={{ fontSize: 13, color: colors.textMuted }}>
              Page {page + 1} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
                style={{
                  padding: '6px 14px', borderRadius: 6, fontSize: 13,
                  background: colors.bgCard, border: `1px solid ${colors.border}`,
                  color: page === 0 ? colors.textFaint : colors.text,
                  cursor: page === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                Previous
              </button>
              <button
                onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                disabled={page >= totalPages - 1}
                style={{
                  padding: '6px 14px', borderRadius: 6, fontSize: 13,
                  background: colors.bgCard, border: `1px solid ${colors.border}`,
                  color: page >= totalPages - 1 ? colors.textFaint : colors.text,
                  cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer',
                }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
