// Lazy verification sweep entry point (design spec §c). Fired fire-and-forget
// from the /command and /command/acciones clients on mount, plus a manual
// "Verificar ahora" button. Best-effort: a failure here must never block the
// UI, so errors degrade to a 500 with the message rather than throwing.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { runSweep } from "@/lib/command/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  try {
    const result = await runSweep(access);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
