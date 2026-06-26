import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { getRunState } from "@/lib/engine/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET: Current state of a run (run + all steps).
export async function GET(
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

  try {
    const state = await getRunState(id);
    return NextResponse.json(state);
  } catch {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
}
