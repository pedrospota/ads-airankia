import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { agentRuns, campaigns } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { setCampaignStatus } from "@/lib/google-ads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST: Discard / undo a Search campaign.
//
// This is the user's "deshacer" button. It removes the campaign from Google Ads
// if it was already created, then resets the local row so the campaign no longer
// shows up as something to finish. It is safe for the normal case because the
// campaign is created PAUSED and so has never spent.
//
// SAFETY: an ACTIVE campaign is one the user already enabled and that may be
// spending right now. We refuse to silently remove it here (the UI already hides
// the button in that state, but a direct call or a race must not slip through).
// To take down a live campaign the user pauses it first.
//
// Only the run's owner may discard it, and only Search campaigns are touched
// (the Display path is never affected).
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
      { ok: false, error: "La campaña no es de búsqueda" },
      { status: 409 }
    );
  }

  // SAFETY: never auto-remove a campaign the user already turned on — it may be
  // live and spending. They must pause it first, then discard.
  if (campaign && campaign.status === "active") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Esta campaña está activa. Ponla en pausa en Google Ads antes de descartarla.",
      },
      { status: 409 }
    );
  }

  try {
    // 1) If it reached Google, take it down (soft-delete). It's PAUSED, so this
    //    can never have spent and can never spend.
    if (campaign?.googleCampaignId) {
      await setCampaignStatus(String(campaign.googleCampaignId), "REMOVED");
    }

    // 2) Reset the local campaign so it disappears from the user's active list
    //    and leaves no dangling reference to the now-removed Google campaign.
    if (campaign) {
      await adsDb
        .update(campaigns)
        .set({
          status: "removed",
          googleCampaignId: null,
          googleAdgroupId: null,
          googleAccountId: null,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaign.id));
    }

    // 3) Mark the run as discarded so nothing tries to resume or re-activate it.
    await adsDb
      .update(agentRuns)
      .set({ status: "aborted", updatedAt: new Date() })
      .where(eq(agentRuns.id, id));

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error:
          e instanceof Error ? e.message : "No se pudo descartar la campaña",
      },
      { status: 500 }
    );
  }
}
