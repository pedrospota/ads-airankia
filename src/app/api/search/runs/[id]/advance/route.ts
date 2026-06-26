import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { agentRuns } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { advanceRun } from "@/lib/engine/orchestrator";
import type { AdvanceRequest } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// MODO AUTO runs A1..A5 here and can take 30-90s (fine on a persistent server).
export const maxDuration = 300;

// POST: Drive the run forward. In AUTO this runs A1..A5 up to the activation
// gate; in ASISTIDO it runs exactly one step. The activator is NEVER run here.
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

  // Ownership: only the run's owner may drive it forward (it can trigger Google
  // mutations downstream).
  const [run] = await adsDb
    .select({ userId: agentRuns.userId })
    .from(agentRuns)
    .where(eq(agentRuns.id, id))
    .limit(1);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  if (run.userId !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // The body is optional (accept / run_next / regenerate + sticky override).
  let body: AdvanceRequest | undefined;
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as AdvanceRequest) : undefined;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const state = await advanceRun(id, body);
    return NextResponse.json(state);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "advance failed" },
      { status: 500 }
    );
  }
}
