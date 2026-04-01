import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { campaigns, placements } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createBudget, createCampaign, createAdGroup, addPlacements } from "@/lib/google-ads";

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

  // Extract unique domains for Google Ads placements
  const uniqueDomains = [...new Set(urls.map((u) => u.domain.replace(/^www\./, "").replace(/^m\./, "")))];

  try {
    // 1. Create in our DB first
    const [campaign] = await adsDb.insert(campaigns).values({
      brandId, workspaceId, userId: user.id,
      status: "creating",
      dailyBudgetCents: dailyBudgetCents || 100, // min $1
      totalBudgetCents: 0, spentCents: 0,
      landingPageUrl: landingPageUrl || brandWebsite,
      brandName, brandWebsite,
    }).returning();

    // 2. Insert placements in our DB
    for (const u of urls) {
      await adsDb.insert(placements).values({
        campaignId: campaign.id,
        url: u.url,
        domain: u.domain.replace(/^www\./, "").replace(/^m\./, ""),
        gdnAvailable: true,
      });
    }

    // 3. Create in Google Ads — ALWAYS PAUSED
    let googleCampaignId: string | null = null;
    let googleAdgroupId: string | null = null;
    let placementResults: { success: string[]; failed: string[] } = { success: [], failed: [] };

    try {
      // Budget ($1/day minimum, campaign is PAUSED anyway)
      const budgetRn = await createBudget(
        `${campaignName} Budget`,
        Math.max((dailyBudgetCents || 100) * 10000, 1000000) // cents → micros, min $1
      );

      // Campaign (PAUSED)
      const camp = await createCampaign(campaignName, budgetRn);
      googleCampaignId = camp.id;

      // Ad group
      const ag = await createAdGroup(camp.id, `${campaignName} - Placements`);
      googleAdgroupId = ag.id;

      // Add domain placements
      placementResults = await addPlacements(ag.id, uniqueDomains);

      // Update our DB with Google IDs
      await adsDb.update(campaigns).set({
        googleCampaignId: Number(googleCampaignId),
        googleAdgroupId: Number(googleAdgroupId),
        googleAccountId: process.env.GOOGLE_ADS_ACCOUNT_ID || "3531706003",
        status: "paused",
        updatedAt: new Date(),
      }).where(eq(campaigns.id, campaign.id));

    } catch (e) {
      // Google Ads failed — campaign stays as draft in our DB
      await adsDb.update(campaigns).set({
        status: "draft",
        updatedAt: new Date(),
      }).where(eq(campaigns.id, campaign.id));

      return NextResponse.json({
        campaign: {
          id: campaign.id,
          status: "draft",
          placementCount: urls.length,
          googleAdsError: e instanceof Error ? e.message : "Google Ads creation failed",
        },
      });
    }

    return NextResponse.json({
      campaign: {
        id: campaign.id,
        status: "paused",
        googleCampaignId,
        googleAdgroupId,
        placementCount: urls.length,
        placementsAdded: placementResults.success.length,
        placementsFailed: placementResults.failed,
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

  const result = await adsDb.select().from(campaigns).where(eq(campaigns.brandId, brandId));
  return NextResponse.json({ campaigns: result });
}
