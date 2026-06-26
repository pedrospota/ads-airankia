import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { agentRuns, agentSteps, campaigns } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { setCampaignStatus } from "@/lib/google-ads";
import type { AgentId, QAOutput } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST: THE SINGLE ENABLE CHOKEPOINT.
// No other agent or route may set a campaign ENABLED. Proceed ONLY if:
//   - the policy_qa step verdict is NOT 'block', AND
//   - the activator step is COMPLETED, AND
//   - the campaign already has a googleCampaignId (was pushed to Google).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Load run.
  const [run] = await adsDb
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, id))
    .limit(1);
  if (!run) {
    return NextResponse.json(
      { ok: false, enabled: false, error: "run not found" },
      { status: 404 }
    );
  }

  // Ownership: only the run's owner may enable it (prevents IDOR — spending
  // another tenant's budget by guessing a run id).
  if (run.userId !== user.id) {
    return NextResponse.json(
      { ok: false, enabled: false, error: "forbidden" },
      { status: 403 }
    );
  }

  // Load steps + campaign.
  const steps = await adsDb
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, id));

  const [campaign] = run.campaignId
    ? await adsDb
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, run.campaignId))
        .limit(1)
    : [];

  // ---- GUARD ---------------------------------------------------------------
  const qaStep = steps.find((s) => (s.agent as AgentId) === "policy_qa");
  const qa = (qaStep?.userOverride ?? qaStep?.output) as QAOutput | null;
  if (qa?.verdict === "block") {
    return NextResponse.json(
      { ok: false, enabled: false, error: "Bloqueado por calidad/politica (QA)" },
      { status: 409 }
    );
  }

  const activatorStep = steps.find((s) => (s.agent as AgentId) === "activator");
  if (activatorStep?.status !== "COMPLETED") {
    return NextResponse.json(
      {
        ok: false,
        enabled: false,
        error: "La campana aun no se ha activado (PAUSED) en Google",
      },
      { status: 409 }
    );
  }

  if (!campaign?.googleCampaignId) {
    return NextResponse.json(
      { ok: false, enabled: false, error: "La campana no existe en Google Ads" },
      { status: 409 }
    );
  }

  // SAFETY: this chokepoint owns Search campaigns only. Never enable a Display
  // row from here (preserves the Display/Search isolation invariant).
  if (campaign.campaignType !== "search") {
    return NextResponse.json(
      { ok: false, enabled: false, error: "La campana no es de busqueda" },
      { status: 409 }
    );
  }
  // --------------------------------------------------------------------------

  try {
    await setCampaignStatus(String(campaign.googleCampaignId), "ENABLED");
    await adsDb
      .update(campaigns)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(campaigns.id, campaign.id));

    return NextResponse.json({ ok: true, enabled: true });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        enabled: false,
        error: e instanceof Error ? e.message : "No se pudo activar la campana",
      },
      { status: 500 }
    );
  }
}
