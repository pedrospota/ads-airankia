import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import {
  agentRuns,
  agentSteps,
  agentEvents,
  campaigns,
  campaignPlans,
  keywordResearchRuns,
  googleMutations,
  adGroups,
  keywords,
  negativeKeywords,
  searchAds,
  rsaVariants,
  campaignAssets,
  assetLinks,
  lpAnalysis,
  biddingLadderEvents,
  placements,
  performance,
  bannerAssets,
  transactions,
} from "@/lib/schema";
import { eq, inArray } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { setCampaignStatus } from "@/lib/google-ads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST: PERMANENTLY delete a Search build run and its campaign — a hard purge to
// clean up test campaigns. Unlike /discard (which soft-removes: it flips status
// flags but keeps every row), this physically removes every row the run/campaign
// produced from the ads DB, so the test clutter is truly gone and never reappears.
//
// What it deliberately KEEPS: cost_events. The tokens/$ a run actually spent are
// real money and stay in the cost ledger, so the /admin Costs panel keeps an
// accurate running total even after the test campaign itself is purged.
//
// SAFETY (the same guardrails as /discard):
//  - owner-only (the run's userId must match the caller),
//  - Search campaigns only — a Display row is never touched,
//  - never an ACTIVE campaign (it may be live and spending — pause it first),
//  - if it reached Google it is removed there first (it is PAUSED, so never spent).
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const [run] = await adsDb
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, id))
    .limit(1);
  if (!run) {
    return NextResponse.json({ ok: false, error: "run not found" }, { status: 404 });
  }
  if (run.userId !== user.id) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const [campaign] = run.campaignId
    ? await adsDb
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, run.campaignId))
        .limit(1)
    : [];

  // SAFETY: this route owns Search campaigns only. Never touch a Display row.
  if (campaign && campaign.campaignType !== "search") {
    return NextResponse.json(
      { ok: false, error: "This isn't a Search campaign" },
      { status: 409 }
    );
  }

  // SAFETY: never delete a campaign the user already turned on — it may be live
  // and spending. They must pause it in Google Ads first, then delete.
  if (campaign && campaign.status === "active") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This campaign is active. Pause it in Google Ads before deleting it.",
      },
      { status: 409 }
    );
  }

  try {
    // 1) If it reached Google, take it down first. It's PAUSED, so it can never
    //    have spent and can never spend.
    if (campaign?.googleCampaignId) {
      await setCampaignStatus(String(campaign.googleCampaignId), "REMOVED");
    }

    const campaignId = campaign?.id ?? null;

    // Every run tied to this campaign. createRun makes exactly one, but purge any
    // strays too so no run is left dangling at a now-deleted campaign. Always
    // include the run we were called with (it may have no campaign at all).
    const runIdSet = new Set<string>([run.id]);
    if (campaignId) {
      const cRuns = await adsDb
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.campaignId, campaignId));
      for (const r of cRuns) runIdSet.add(r.id);
    }
    const runIds = Array.from(runIdSet);

    // One transaction. There are no ON DELETE CASCADE constraints in this schema,
    // so we delete children before parents, in dependency order.
    await adsDb.transaction(async (tx) => {
      if (campaignId) {
        const ags = await tx
          .select({ id: adGroups.id })
          .from(adGroups)
          .where(eq(adGroups.campaignId, campaignId));
        const adGroupIds = ags.map((a) => a.id);

        const assets = await tx
          .select({ id: campaignAssets.id })
          .from(campaignAssets)
          .where(eq(campaignAssets.campaignId, campaignId));
        const assetIds = assets.map((a) => a.id);

        // rsa_variants → ad_groups + search_ads: delete before either parent.
        if (adGroupIds.length > 0) {
          await tx
            .delete(rsaVariants)
            .where(inArray(rsaVariants.adGroupId, adGroupIds));
        }
        // asset_links → campaign_assets.
        if (assetIds.length > 0) {
          await tx
            .delete(assetLinks)
            .where(inArray(assetLinks.assetId, assetIds));
        }

        // Leaf rows hanging off the campaign and/or its ad groups.
        await tx.delete(keywords).where(eq(keywords.campaignId, campaignId));
        await tx
          .delete(negativeKeywords)
          .where(eq(negativeKeywords.campaignId, campaignId));
        await tx.delete(searchAds).where(eq(searchAds.campaignId, campaignId));
        await tx.delete(lpAnalysis).where(eq(lpAnalysis.campaignId, campaignId));
        if (adGroupIds.length > 0) {
          await tx
            .delete(keywords)
            .where(inArray(keywords.adGroupId, adGroupIds));
          await tx
            .delete(negativeKeywords)
            .where(inArray(negativeKeywords.adGroupId, adGroupIds));
          await tx
            .delete(searchAds)
            .where(inArray(searchAds.adGroupId, adGroupIds));
          await tx
            .delete(lpAnalysis)
            .where(inArray(lpAnalysis.adGroupId, adGroupIds));
        }

        await tx.delete(adGroups).where(eq(adGroups.campaignId, campaignId));
        await tx
          .delete(campaignAssets)
          .where(eq(campaignAssets.campaignId, campaignId));
        await tx
          .delete(biddingLadderEvents)
          .where(eq(biddingLadderEvents.campaignId, campaignId));

        // Display-only tables can never hold Search rows, but their FK to
        // campaigns would block the delete if they somehow did — clear defensively.
        await tx.delete(placements).where(eq(placements.campaignId, campaignId));
        await tx
          .delete(performance)
          .where(eq(performance.campaignId, campaignId));
        await tx
          .delete(bannerAssets)
          .where(eq(bannerAssets.campaignId, campaignId));
        await tx
          .delete(transactions)
          .where(eq(transactions.campaignId, campaignId));
      }

      // Run-scoped substrate (steps, events, plans, mutations, research).
      await tx
        .delete(googleMutations)
        .where(inArray(googleMutations.runId, runIds));
      await tx
        .delete(keywordResearchRuns)
        .where(inArray(keywordResearchRuns.runId, runIds));
      await tx.delete(campaignPlans).where(inArray(campaignPlans.runId, runIds));
      await tx.delete(agentEvents).where(inArray(agentEvents.runId, runIds));
      await tx.delete(agentSteps).where(inArray(agentSteps.runId, runIds));

      // Any campaign-keyed plans/research that weren't run-keyed.
      if (campaignId) {
        await tx
          .delete(campaignPlans)
          .where(eq(campaignPlans.campaignId, campaignId));
        await tx
          .delete(keywordResearchRuns)
          .where(eq(keywordResearchRuns.campaignId, campaignId));
      }

      // Finally the campaign and the runs themselves.
      if (campaignId) {
        await tx.delete(campaigns).where(eq(campaigns.id, campaignId));
      }
      await tx.delete(agentRuns).where(inArray(agentRuns.id, runIds));

      // NOTE: cost_events is intentionally NOT deleted — the spend already
      // happened and must stay visible in the /admin Costs panel.
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error:
          e instanceof Error ? e.message : "We couldn't delete the campaign",
      },
      { status: 500 }
    );
  }
}
