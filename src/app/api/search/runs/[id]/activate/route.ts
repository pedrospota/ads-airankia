import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { agentRuns } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { runActivatorStep } from "@/lib/engine/orchestrator";
import type { ActivateResponse, ActivatorOutput } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Same account id the activator mutates against (hyphens stripped for the URL).
const CUSTOMER_ID = process.env.GOOGLE_ADS_ACCOUNT_ID || "3531706003";

// POST: Explicit "Activar". Pushes the campaign to Google ALWAYS PAUSED.
// This does NOT enable the campaign — enabling lives behind /enable only.
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

  // Ownership: only the run's owner may push it to Google.
  const [run] = await adsDb
    .select({ userId: agentRuns.userId })
    .from(agentRuns)
    .where(eq(agentRuns.id, id))
    .limit(1);
  if (!run) {
    return NextResponse.json(
      { ok: false, enabled: false, error: "run not found" } satisfies ActivateResponse,
      { status: 404 }
    );
  }
  if (run.userId !== user.id) {
    return NextResponse.json(
      { ok: false, enabled: false, error: "forbidden" } satisfies ActivateResponse,
      { status: 403 }
    );
  }

  try {
    const state = await runActivatorStep(id);

    if (state.run.status === "failed") {
      const response: ActivateResponse = {
        ok: false,
        enabled: false,
        error: state.run.error ?? "activation failed",
      };
      return NextResponse.json(response, { status: 500 });
    }

    // Surface "what was really created" so the user is never left with a black box.
    const activatorStep = state.steps.find((s) => s.agent === "activator");
    const activatorOutput = (activatorStep?.output ?? null) as ActivatorOutput | null;
    const gid = state.run.googleCampaignId ?? undefined;
    const cidNoHyphens = CUSTOMER_ID.replace(/-/g, "");

    const response: ActivateResponse = {
      ok: true,
      googleCampaignId: gid,
      enabled: false, // left PAUSED — recommended default
      summary: activatorOutput
        ? {
            adGroupsCount: activatorOutput.adGroups?.length ?? 0,
            keywordsCount: activatorOutput.keywordsAdded ?? 0,
            negativesCount: activatorOutput.negativesAdded ?? 0,
            adsCount: activatorOutput.adsCreated ?? 0,
            assetsCount: activatorOutput.assetsLinked ?? 0,
            assetKinds: activatorOutput.assetKinds ?? [],
          }
        : undefined,
      googleAdsDeepLink: gid
        ? `https://ads.google.com/aw/campaigns?campaignId=${gid}&__c=${cidNoHyphens}`
        : undefined,
      conversionDowngradeApplied: activatorOutput?.conversionDowngradeApplied ?? false,
    };
    return NextResponse.json(response);
  } catch (e) {
    const response: ActivateResponse = {
      ok: false,
      enabled: false,
      error: e instanceof Error ? e.message : "activation failed",
    };
    return NextResponse.json(response, { status: 500 });
  }
}
