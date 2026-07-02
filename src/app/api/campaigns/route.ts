import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { campaigns, placements } from "@/lib/schema";
import { and, eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { getAccessibleBrand } from "@/lib/brand-access";

// POST: Create campaign as DRAFT (DB only, no Google Ads)
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const { brandId, brandName, brandWebsite, workspaceId, campaignName, landingPageUrl, dailyBudgetCents, urls } = body as {
    brandId: string; brandName: string; brandWebsite: string; workspaceId: string;
    campaignName: string; landingPageUrl: string; dailyBudgetCents: number;
    urls: { url: string; domain: string }[];
  };

  if (!brandId || !campaignName || !urls?.length) {
    return NextResponse.json({ error: "brandId, campaignName, and urls are required" }, { status: 400 });
  }

  // Membership check via RLS: the caller must belong to the brand's workspace.
  // Also the workspace_id comes from the brand itself, never trusted from the body.
  const brand = await getAccessibleBrand(supabase, brandId);
  if (!brand) {
    return NextResponse.json({ error: "brand not found" }, { status: 404 });
  }

  try {
    // 1. Create campaign as draft in our DB
    const [campaign] = await adsDb.insert(campaigns).values({
      brandId, workspaceId: brand.workspace_id || workspaceId, userId: user.id,
      status: "draft",
      dailyBudgetCents: Math.max(dailyBudgetCents || 100, 100),
      totalBudgetCents: 0, spentCents: 0,
      landingPageUrl: landingPageUrl || brandWebsite,
      brandName, brandWebsite,
    }).returning();

    // 2. Insert placements
    for (const u of urls) {
      await adsDb.insert(placements).values({
        campaignId: campaign.id,
        url: u.url,
        domain: u.domain.replace(/^www\./, "").replace(/^m\./, ""),
        gdnAvailable: true,
      });
    }

    return NextResponse.json({
      campaign: {
        id: campaign.id,
        status: "draft",
        placementCount: urls.length,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Campaign creation failed" },
      { status: 500 }
    );
  }
}

// GET: List campaigns for a brand
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const brandId = searchParams.get("brandId");

  if (!brandId) {
    return NextResponse.json({ error: "brandId required" }, { status: 400 });
  }

  // Membership check via RLS — a signed-in user must not list another
  // workspace's campaigns by guessing brandIds.
  const brand = await getAccessibleBrand(supabase, brandId);
  if (!brand) {
    return NextResponse.json({ error: "brand not found" }, { status: 404 });
  }

  // Display-only: Search campaigns live behind the Search engine routes and must
  // never surface here (keeps the Display/Search paths isolated).
  const result = await adsDb
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.brandId, brandId), eq(campaigns.campaignType, "display")));
  return NextResponse.json({ campaigns: result });
}
