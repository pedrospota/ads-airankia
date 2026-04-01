"use client";

import { Header } from "@/components/header";
import { ModelPill } from "@/components/model-pill";
import { GdnBadge } from "@/components/gdn-badge";

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

export function CitationsClient({
  brand,
  citations,
  error,
}: {
  brand: Brand;
  citations: Citation[];
  error: string | null;
}) {
  const gdnAvailableCount = citations.filter((c) => c.gdn_available).length;
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
          <button className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-sm transition-colors">
            Start Campaign
          </button>
        }
      />

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Brand header */}
        <div className="flex items-center gap-4 mb-8">
          {brand.logo_url ? (
            <img
              src={brand.logo_url}
              alt={brand.name}
              className="w-16 h-16 rounded-xl object-cover bg-zinc-100 dark:bg-zinc-800"
            />
          ) : (
            <div className="w-16 h-16 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500 font-bold text-2xl">
              {brand.name.charAt(0)}
            </div>
          )}
          <div>
            <h1 className="text-3xl font-bold">{brand.name}</h1>
            <p className="text-zinc-500 dark:text-zinc-400">{brand.industry}</p>
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: "Total Citations", value: totalCitations.toLocaleString(), color: "" },
            { label: "Unique Sources", value: uniqueDomains.toString(), color: "" },
            { label: "AI Models Citing", value: uniqueModels.toString(), color: "" },
            { label: "GDN Available", value: gdnAvailableCount.toString(), color: "text-emerald-600 dark:text-emerald-400" },
          ].map((kpi) => (
            <div
              key={kpi.label}
              className="p-4 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-sm dark:shadow-none"
            >
              <p className="text-sm text-zinc-500">{kpi.label}</p>
              <p className={`text-2xl font-bold mt-1 ${kpi.color}`}>
                {kpi.value}
              </p>
            </div>
          ))}
        </div>

        {error && (
          <div className="p-4 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 mb-6">
            {error}
          </div>
        )}

        {/* Citation table */}
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden shadow-sm dark:shadow-none">
          <div className="px-6 py-4 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
            <h2 className="font-semibold">Citation Sources</h2>
            <p className="text-sm text-zinc-500 mt-1">
              URLs that AI models cite when answering queries about{" "}
              {brand.name}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 text-left text-sm text-zinc-500">
                  <th className="px-6 py-3 font-medium">URL</th>
                  <th className="px-6 py-3 font-medium">Domain</th>
                  <th className="px-6 py-3 font-medium text-right">Citations</th>
                  <th className="px-6 py-3 font-medium">Models</th>
                  <th className="px-6 py-3 font-medium">GDN</th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-zinc-950">
                {citations.map((citation) => (
                  <tr
                    key={citation.url}
                    className="border-b border-zinc-100 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                  >
                    <td className="px-6 py-3">
                      <a
                        href={
                          citation.url.startsWith("http")
                            ? citation.url
                            : `https://${citation.url}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 truncate block max-w-xs"
                      >
                        {citation.url.replace(/^https?:\/\/(www\.)?/, "")}
                      </a>
                    </td>
                    <td className="px-6 py-3 text-sm text-zinc-500 dark:text-zinc-400">
                      {citation.domain.replace(/^www\./, "")}
                    </td>
                    <td className="px-6 py-3 text-sm font-mono text-right">
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
                      <GdnBadge domain={citation.domain} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {citations.length === 0 && !error && (
            <div className="px-6 py-12 text-center text-zinc-500">
              <p>No citations found for this brand yet.</p>
              <p className="text-sm mt-2">
                Run monitored prompts in AI Rankia to start collecting citation
                data.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
