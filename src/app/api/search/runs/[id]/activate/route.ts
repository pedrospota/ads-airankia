import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { agentRuns } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { runActivatorStep } from "@/lib/engine/orchestrator";
import type { ActivateResponse } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

    const response: ActivateResponse = {
      ok: true,
      googleCampaignId: state.run.googleCampaignId ?? undefined,
      enabled: false, // left PAUSED — recommended default
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
