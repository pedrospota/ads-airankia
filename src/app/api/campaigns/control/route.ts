import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { campaigns } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { setCampaignStatus, getCampaignPerformance } from "@/lib/google-ads";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId, action } = await request.json() as {
    campaignId: string;
    action: "pause" | "activate" | "sync";
  };

  // Get campaign from our DB
  const [campaign] = await adsDb.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (!campaign.googleCampaignId) return NextResponse.json({ error: "Campaign not synced to Google Ads" }, { status: 400 });

  try {
    if (action === "pause") {
      await setCampaignStatus(String(campaign.googleCampaignId), "PAUSED");
      await adsDb.update(campaigns).set({ status: "paused", updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
      return NextResponse.json({ status: "paused" });
    }

    if (action === "activate") {
      await setCampaignStatus(String(campaign.googleCampaignId), "ENABLED");
      await adsDb.update(campaigns).set({ status: "active", updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
      return NextResponse.json({ status: "active" });
    }

    if (action === "sync") {
      const perf = await getCampaignPerformance(String(campaign.googleCampaignId));
      await adsDb.update(campaigns).set({
        spentCents: Math.round(perf.costMicros / 10000),
        status: perf.status === "ENABLED" ? "active" : perf.status === "PAUSED" ? "paused" : campaign.status,
        updatedAt: new Date(),
      }).where(eq(campaigns.id, campaignId));
      return NextResponse.json({ performance: perf });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Action failed" }, { status: 500 });
  }
}
