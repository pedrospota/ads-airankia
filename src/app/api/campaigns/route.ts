import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { campaigns, placements } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";

// Google Ads config from env
const GOOGLE_ADS_ACCOUNT_ID = process.env.GOOGLE_ADS_ACCOUNT_ID || "3531706003";
const GOOGLE_ADS_API_BASE = "https://googleads.googleapis.com/v19";

export async function POST(request: NextRequest) {
  // Auth check
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const { brandId, brandName, brandWebsite, workspaceId, campaignName, landingPageUrl, dailyBudgetCents, urls } = body as {
    brandId: string;
    brandName: string;
    brandWebsite: string;
    workspaceId: string;
    campaignName: string;
    landingPageUrl: string;
    dailyBudgetCents: number;
    urls: { url: string; domain: string }[];
  };

  if (!brandId || !campaignName || !urls?.length) {
    return NextResponse.json({ error: "brandId, campaignName, and urls are required" }, { status: 400 });
  }

  try {
    // 1. Create campaign in our DB first
    const [campaign] = await adsDb.insert(campaigns).values({
      brandId,
      workspaceId,
      userId: user.id,
      status: "creating",
      dailyBudgetCents: dailyBudgetCents || 0,
      totalBudgetCents: 0,
      spentCents: 0,
      landingPageUrl: landingPageUrl || brandWebsite,
      brandName,
      brandWebsite,
    }).returning();

    // 2. Insert placements in our DB
    for (const u of urls) {
      await adsDb.insert(placements).values({
        campaignId: campaign.id,
        url: u.url,
        domain: u.domain,
        gdnAvailable: true,
      });
    }

    // 3. Try to create in Google Ads via MCP (this will be called from the frontend)
    // For now, store the campaign and let the user trigger Google Ads creation
    // via a separate "activate" action. This keeps campaign creation fast.
    await adsDb
      .update(campaigns)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(campaigns.id, campaign.id));

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

// List campaigns for a brand
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const brandId = searchParams.get("brandId");

  if (!brandId) {
    return NextResponse.json({ error: "brandId required" }, { status: 400 });
  }

  const result = await adsDb
    .select()
    .from(campaigns)
    .where(eq(campaigns.brandId, brandId));

  return NextResponse.json({ campaigns: result });
}
