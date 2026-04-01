"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/header";
import { ModelPill } from "@/components/model-pill";
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
}

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

  // Fetch GDN data for all citation domains on mount
  useEffect(() => {
    const domains = [...new Set(citations.map((c) => c.domain.replace(/^www\./, "")))];
    if (domains.length === 0) { setAdLoading(false); return; }

    fetch("/api/check-gdn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains }),
    })
      .then((r) => r.json())
      .then((data) => {
        const map: Record<string, AdInfo> = {};
        for (const r of data.results || []) {
          map[r.domain] = { hasGdn: r.hasGdn, gdnPubId: r.gdnPubId, networks: r.networks || [] };
        }
        setAdData(map);
      })
      .catch(() => {})
      .finally(() => setAdLoading(false));
  }, [citations]);

  const gdnAvailableCount = Object.values(adData).filter((a) => a.hasGdn).length;
  const totalCitations = citations.reduce((sum, c) => sum + c.citation_count, 0);
  const uniqueDomains = new Set(citations.map((c) => c.domain)).size;
  const uniqueModels = new Set(citations.flatMap((c) => c.models)).size;

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
              className="w-16 h-16 rounded-xl object-cover"
              style={{ background: colors.bgCard }} />
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
            { label: "AI Models Citing", value: uniqueModels.toString() },
            { label: "GDN Available", value: adLoading ? "..." : gdnAvailableCount.toString(), accent: true },
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

        {/* Citation table */}
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
          <div className="px-6 py-4" style={{ background: colors.bgCard, borderBottom: `1px solid ${colors.border}` }}>
            <h2 className="font-semibold">Citation Sources</h2>
            <p style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>
              URLs that AI models cite when answering queries about {brand.name}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}`, color: colors.textMuted, fontSize: 13 }} className="text-left">
                  <th className="px-6 py-3 font-medium">URL</th>
                  <th className="px-6 py-3 font-medium">Domain</th>
                  <th className="px-6 py-3 font-medium text-right">Citations</th>
                  <th className="px-6 py-3 font-medium">Models</th>
                  <th className="px-6 py-3 font-medium">Ad Inventory</th>
                  <th className="px-6 py-3 font-medium">Networks</th>
                </tr>
              </thead>
              <tbody style={{ background: colors.bg }}>
                {citations.map((citation) => {
                  const cleanDomain = citation.domain.replace(/^www\./, "");
                  const info = adData[cleanDomain];
                  return (
                    <tr key={citation.url} style={{ borderBottom: `1px solid ${colors.bgCard}` }}>
                      <td className="px-6 py-3">
                        <a
                          href={citation.url.startsWith("http") ? citation.url : `https://${citation.url}`}
                          target="_blank" rel="noopener noreferrer"
                          className="truncate block max-w-xs"
                          style={{ fontSize: 13, color: '#60A5FA' }}
                        >
                          {citation.url.replace(/^https?:\/\/(www\.)?/, "")}
                        </a>
                      </td>
                      <td className="px-6 py-3" style={{ fontSize: 13, color: colors.textMuted }}>
                        {cleanDomain}
                      </td>
                      <td className="px-6 py-3 font-mono text-right" style={{ fontSize: 13 }}>
                        {citation.citation_count}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex flex-wrap gap-1">
                          {citation.models.map((model) => (
                            <ModelPill key={model} model={model} />
                          ))}
                        </div>
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
      </main>
    </div>
  );
}
