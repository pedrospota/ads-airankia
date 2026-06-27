import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { createRun } from "@/lib/engine/orchestrator";
import { getBrandAiContext } from "@/lib/queries";
import type {
  StartRunRequest,
  StartRunResponse,
  BrandSeed,
} from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST: Start a new Search-build run (creates a draft campaign + run + steps).
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: StartRunRequest;
  try {
    body = (await request.json()) as StartRunRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { brandId, seed } = body;
  if (!brandId || !seed) {
    return NextResponse.json(
      { error: "brandId and seed are required" },
      { status: 400 }
    );
  }
  // The user is never forced to choose a run mode. Default to "auto" (the AI
  // runs end to end). "assisted" is an explicit opt-in for step-by-step review;
  // any other/missing value falls back to "auto" instead of erroring.
  const mode: "auto" | "assisted" =
    body.mode === "assisted" ? "assisted" : "auto";

  // Resolve workspaceId from the brand (Supabase, read-only) so the run is
  // scoped to the right workspace + user.
  const {
    data: { session },
  } = await authClient.auth.getSession();
  const readClient = createSupabaseReadClient(session?.access_token);
  const { data: brand, error: brandError } = await readClient
    .from("brand_project")
    .select(
      "id, workspace_id, name, industry, website, description:business_entity_description, business_entity_offering, audience_client, audience_plural, audience_singular, brand_voice, competitors, main_country"
    )
    .eq("id", brandId)
    .single();

  if (brandError || !brand) {
    console.error("[search/runs] brand lookup failed", brandError);
    return NextResponse.json({ error: "brand not found" }, { status: 404 });
  }

  // Enrich the seed with the full business context we already have on file, so
  // the pipeline plans with real information (name, website, sector, what they
  // offer, who they sell to, competitors) instead of only whatever the user
  // typed. User-typed hints (objective, budget) always win; brand identity is
  // filled from the database where the user left a gap.
  const fullSeed: BrandSeed = {
    ...seed,
    brandId,
    brandName: (seed.brandName?.trim() || brand.name || "").trim(),
  };
  if (!fullSeed.brandWebsite && brand.website) {
    fullSeed.brandWebsite = brand.website;
    fullSeed.landingPageUrl = fullSeed.landingPageUrl ?? brand.website;
  }
  if (brand.industry && !fullSeed.industry) {
    fullSeed.industry = brand.industry;
  }
  if (brand.description && !fullSeed.description) {
    fullSeed.description = brand.description;
  }

  // Richer brand profile (only fill gaps the user didn't type).
  const offering = (brand.business_entity_offering ?? "").trim();
  if (offering && !fullSeed.offering) fullSeed.offering = offering;
  const audience = (
    brand.audience_client ||
    brand.audience_plural ||
    brand.audience_singular ||
    ""
  ).trim();
  if (audience && !fullSeed.audience) fullSeed.audience = audience;
  const brandVoice = (brand.brand_voice ?? "").trim();
  if (brandVoice && !fullSeed.brandVoice) fullSeed.brandVoice = brandVoice;
  if (!fullSeed.competitors && Array.isArray(brand.competitors)) {
    const comps = brand.competitors
      .map((c: unknown) => (typeof c === "string" ? c.trim() : ""))
      .filter(Boolean)
      .slice(0, 8);
    if (comps.length) fullSeed.competitors = comps;
  }
  const mainCountry = (brand.main_country ?? "").trim();
  if (mainCountry && !fullSeed.mainCountry) fullSeed.mainCountry = mainCountry;

  // Live AI-visibility signals (real prompts + cited domains). Best-effort and
  // bounded — never blocks campaign creation if AirAnkia has nothing yet.
  const aiContext = await getBrandAiContext(brandId, session?.access_token);
  if (aiContext.topQueries.length || aiContext.citationDomains.length) {
    fullSeed.aiContext = aiContext;
  }

  const { runId } = await createRun({
    brandId,
    workspaceId: brand.workspace_id,
    userId: user.id,
    mode,
    seed: fullSeed,
  });

  const response: StartRunResponse = { runId };
  return NextResponse.json(response);
}
