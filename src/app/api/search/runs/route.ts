import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { createRun } from "@/lib/engine/orchestrator";
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

  const { brandId, mode, seed } = body;
  if (!brandId || !mode || !seed) {
    return NextResponse.json(
      { error: "brandId, mode, and seed are required" },
      { status: 400 }
    );
  }
  if (mode !== "auto" && mode !== "assisted") {
    return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  }

  // Resolve workspaceId from the brand (Supabase, read-only) so the run is
  // scoped to the right workspace + user.
  const {
    data: { session },
  } = await authClient.auth.getSession();
  const readClient = createSupabaseReadClient(session?.access_token);
  const { data: brand } = await readClient
    .from("brand_project")
    .select("id, workspace_id, name, industry, website, description")
    .eq("id", brandId)
    .single();

  if (!brand) {
    return NextResponse.json({ error: "brand not found" }, { status: 404 });
  }

  // Enrich the seed with the full business context we already have on file, so
  // the pipeline plans with real information (name, website, sector) instead of
  // only whatever the user typed. User-typed hints (objective, budget) always
  // win; brand identity is filled from the database where the user left a gap.
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
