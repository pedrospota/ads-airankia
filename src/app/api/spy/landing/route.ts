import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { recordCost } from "@/lib/cost-ledger";
import { toUrl } from "@/lib/benchmark/page-fetch";
import { analyzeLanding } from "@/lib/spy/landing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/spy/landing
// Body: { url, adHeadline?, adDescription? }
// Scrapes a competitor's landing page (Firecrawl → fallback fetch), mines its
// tracking stack, and runs one LLM extraction pass into a LandingSlice (offer,
// pricing, CTA, value props, social proof, funnel, message-match verdict).
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to run this." }, { status: 401 });

  let body: { url?: string; adHeadline?: string; adDescription?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Coerce — JSON types are erased at runtime; a non-string url/adHeadline would
  // throw on .trim() and escape as an unhandled 500. Always return cleanly.
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const url = toUrl(str(body.url) ?? "");
  if (!url) {
    return NextResponse.json({ error: "Enter a valid landing URL or domain (e.g. competitor.com/pricing)." }, { status: 400 });
  }

  const result = await analyzeLanding({
    url,
    adHeadline: str(body.adHeadline),
    adDescription: str(body.adDescription),
  });

  // Meter both legs to the cost ledger (best-effort, never throws).
  if (result.scrape.provider === "firecrawl") {
    void recordCost({
      category: "external_api", provider: "firecrawl", resource: "markdown_scrape",
      units: result.scrape.creditsUsed, costMicros: Math.round(result.cost * 1_000_000),
      userId: user.id, brandId: null, workspaceId: null, runId: null,
      meta: { module: "spy", tool: "landing", domain: result.domain },
    });
  }
  if (result.llm.ran || result.llm.tokensIn || result.llm.tokensOut) {
    void recordCost({
      category: "llm", provider: "openrouter", resource: result.llm.model ?? "unknown",
      tokensIn: result.llm.tokensIn, tokensOut: result.llm.tokensOut, costMicros: 0,
      userId: user.id, brandId: null, workspaceId: null, runId: null,
      meta: { module: "spy", tool: "landing", domain: result.domain },
    });
  }

  // Page genuinely unreadable → 502 so the client shows a clear error.
  if (result.error && !result.scrape.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({
    url: result.url,
    domain: result.domain,
    title: result.title,
    slice: result.slice,
    scrape: result.scrape,
    llm: { ran: result.llm.ran, model: result.llm.model, error: result.llm.error },
    llmError: result.llm.error,
    cost: result.cost,
    source: result.source,
  });
}
