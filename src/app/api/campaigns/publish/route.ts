import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { campaigns, placements } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createBudget, createCampaign, createAdGroup, addPlacements } from "@/lib/google-ads";

// POST: Publish a draft campaign to Google Ads (creates it PAUSED)
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId } = await request.json() as { campaignId: string };

  // Get campaign from DB
  const [campaign] = await adsDb.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (campaign.googleCampaignId) return NextResponse.json({ error: "Already published to Google Ads" }, { status: 400 });

  // Get placements
  const campPlacements = await adsDb.select().from(placements).where(eq(placements.campaignId, campaignId));
  const uniqueDomains = [...new Set(campPlacements.map((p) => p.domain))];

  if (uniqueDomains.length === 0) {
    return NextResponse.json({ error: "No placements found" }, { status: 400 });
  }

  try {
    // Update status
    await adsDb.update(campaigns).set({ status: "publishing", updatedAt: new Date() }).where(eq(campaigns.id, campaignId));

    // 1. Create budget ($1/day minimum, PAUSED anyway)
    const budgetMicros = Math.max((campaign.dailyBudgetCents || 100) * 10000, 1000000);
    const budgetRn = await createBudget(`${campaign.brandName} - Budget`, budgetMicros);

    // 2. Create Display campaign (ALWAYS PAUSED)
    const camp = await createCampaign(`${campaign.brandName} - Citation Retargeting`, budgetRn);

    // 3. Create ad group
    const ag = await createAdGroup(camp.id, `${campaign.brandName} - Placements`);

    // 4. Add domain placements
    const placementResults = await addPlacements(ag.id, uniqueDomains);

    // 5. Update our DB with Google IDs
    await adsDb.update(campaigns).set({
      googleCampaignId: Number(camp.id),
      googleAdgroupId: Number(ag.id),
      googleAccountId: process.env.GOOGLE_ADS_ACCOUNT_ID || "3531706003",
      status: "paused",
      updatedAt: new Date(),
    }).where(eq(campaigns.id, campaignId));

    return NextResponse.json({
      success: true,
      googleCampaignId: camp.id,
      googleAdgroupId: ag.id,
      placementsAdded: placementResults.success.length,
      placementsFailed: placementResults.failed,
    });
  } catch (e) {
    // Revert to draft on failure
    await adsDb.update(campaigns).set({ status: "draft", updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Google Ads publishing failed" },
      { status: 500 }
    );
  }
}
