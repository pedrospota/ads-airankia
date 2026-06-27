import { createSupabaseReadClient } from "./supabase-server";
import type { BrandAiContext } from "./engine/types";

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
export async function getBrands(workspaceIds: string[], accessToken?: string): Promise<Brand[]> {
  const supabase = createSupabaseReadClient(accessToken);
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
  brandId: string,
  accessToken?: string
): Promise<CitationAggregation[]> {
  const supabase = createSupabaseReadClient(accessToken);

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
    .sort((a, b) => b.citation_count - a.citation_count);
}

// Live AI-visibility context for a brand, drawn from the data AirAnkia already
// collected: the real prompts people ask AI assistants about the brand/market
// (queries.query, linked by attached_brand_id) and the domains those answers
// cite. Both lists are kept SMALL and the whole thing is best-effort — if the
// brand has no prompts yet, or anything fails, we return empty lists so the
// campaign pipeline keeps working exactly as before.
const MAX_AI_QUERIES = 12;
const MAX_CITATION_DOMAINS = 8;

export async function getBrandAiContext(
  brandId: string,
  accessToken?: string
): Promise<BrandAiContext> {
  const empty: BrandAiContext = { topQueries: [], citationDomains: [] };
  try {
    const supabase = createSupabaseReadClient(accessToken);

    // Most-recent prompts attached to this brand.
    const { data: queries } = await supabase
      .from("queries")
      .select("id, query, last_analysis_at")
      .eq("attached_brand_id", brandId)
      .order("last_analysis_at", { ascending: false, nullsFirst: false })
      .limit(40);

    if (!queries || queries.length === 0) return empty;

    // Distinct, trimmed prompt texts (most recent first), capped.
    const seen = new Set<string>();
    const topQueries: string[] = [];
    for (const q of queries) {
      const text = (q.query ?? "").trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      topQueries.push(text.length > 160 ? `${text.slice(0, 157)}…` : text);
      if (topQueries.length >= MAX_AI_QUERIES) break;
    }

    // Domains cited across this brand's answers (bounded scan).
    const queryIds = queries.map((q) => q.id);
    const { data: results } = await supabase
      .from("query_run_results")
      .select("citations")
      .in("query_id", queryIds)
      .not("citations", "is", null)
      .limit(200);

    const domainCount = new Map<string, number>();
    for (const r of results ?? []) {
      const cites = r.citations as Array<{ url?: string; domain?: string }> | null;
      if (!Array.isArray(cites)) continue;
      for (const c of cites) {
        let domain = (c.domain ?? "").trim().toLowerCase();
        if (!domain && c.url) {
          try {
            domain = new URL(c.url).hostname.toLowerCase();
          } catch {
            domain = "";
          }
        }
        domain = domain.replace(/^www\./, "");
        if (!domain) continue;
        domainCount.set(domain, (domainCount.get(domain) ?? 0) + 1);
      }
    }
    const citationDomains = Array.from(domainCount.entries())
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_CITATION_DOMAINS);

    return { topQueries, citationDomains };
  } catch (e) {
    console.error("[getBrandAiContext] failed (non-fatal)", e);
    return empty;
  }
}

// GDN availability is now checked dynamically via ads.txt + scraping
// and cached in the ad_inventory table. The isGdnAvailable function
// is kept as a sync fallback for server-side rendering — real data
// comes from the /api/check-gdn endpoint called client-side.
export function isGdnAvailable(_domain: string): boolean {
  return false; // default unknown — client will fetch real status
}
