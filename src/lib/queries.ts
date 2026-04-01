import { createSupabaseReadClient } from "./supabase-server";

export interface Brand {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  logo_url: string | null;
  workspace_id: string;
}

export interface CitationAggregation {
  url: string;
  domain: string;
  citation_count: number;
  models: string[];
}

export interface BrandVisibility {
  date: string;
  total_results: number;
  mentioned_in: number;
  avg_score: number;
}

// Fetch brands for multiple workspaces
export async function getBrands(workspaceIds: string[]): Promise<Brand[]> {
  const supabase = createSupabaseReadClient();
  const { data, error } = await supabase
    .from("brand_project")
    .select("id, name, industry, website, logo_url, workspace_id")
    .in("workspace_id", workspaceIds)
    .order("name");

  if (error) throw error;
  return data ?? [];
}

// Fetch aggregated citations for a brand
export async function getCitationsForBrand(
  brandId: string
): Promise<CitationAggregation[]> {
  const supabase = createSupabaseReadClient();

  // Get all query_run_results for prompts attached to this brand
  const { data: queries, error: qError } = await supabase
    .from("queries")
    .select("id")
    .eq("attached_brand_id", brandId);

  if (qError) throw qError;
  if (!queries || queries.length === 0) return [];

  const queryIds = queries.map((q) => q.id);

  const { data: results, error: rError } = await supabase
    .from("query_run_results")
    .select("citations, llm_name")
    .in("query_id", queryIds)
    .not("citations", "is", null);

  if (rError) throw rError;
  if (!results) return [];

  // Aggregate citations client-side
  const citationMap = new Map<
    string,
    { url: string; domain: string; count: number; models: Set<string> }
  >();

  for (const result of results) {
    const citations = result.citations as Array<{
      url?: string;
      domain?: string;
    }> | null;
    if (!citations || !Array.isArray(citations)) continue;

    for (const citation of citations) {
      if (!citation.url) continue;
      const key = citation.url;
      const existing = citationMap.get(key);
      if (existing) {
        existing.count++;
        if (result.llm_name) existing.models.add(result.llm_name);
      } else {
        citationMap.set(key, {
          url: citation.url,
          domain: citation.domain || new URL(citation.url).hostname,
          count: 1,
          models: new Set(result.llm_name ? [result.llm_name] : []),
        });
      }
    }
  }

  return Array.from(citationMap.values())
    .map((c) => ({
      url: c.url,
      domain: c.domain,
      citation_count: c.count,
      models: Array.from(c.models),
    }))
    .sort((a, b) => b.citation_count - a.citation_count)
    .slice(0, 50);
}

// Known GDN-available domains
const GDN_DOMAINS = new Set([
  "g2.com",
  "capterra.com",
  "trustradius.com",
  "techradar.com",
  "pcmag.com",
  "cnet.com",
  "tomsguide.com",
  "forbes.com",
  "businessinsider.com",
  "bloomberg.com",
  "nytimes.com",
  "theguardian.com",
  "bbc.com",
  "hubspot.com",
  "semrush.com",
  "moz.com",
  "reddit.com",
  "medium.com",
  "zdnet.com",
  "wired.com",
  "theverge.com",
  "arstechnica.com",
  "creativebloq.com",
  "rtings.com",
  "windowscentral.com",
  "gamesradar.com",
  "seranking.com",
  "ninjaseo.es",
  "inboundcycle.com",
]);

export function isGdnAvailable(domain: string): boolean {
  const clean = domain.replace(/^www\./, "");
  return GDN_DOMAINS.has(clean);
}
