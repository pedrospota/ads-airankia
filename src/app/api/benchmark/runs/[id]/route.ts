import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { adsDb } from "@/lib/ads-db";
import { benchmarkRuns } from "@/lib/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/benchmark/runs/[id] — full state of one run (incl. result when done).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [run] = await adsDb
    .select()
    .from(benchmarkRuns)
    .where(eq(benchmarkRuns.id, id))
    .limit(1);

  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (run.userId !== user.id)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  return NextResponse.json({ run });
}
