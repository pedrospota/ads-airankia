// On-demand campaign snapshots for the Centro de Mando Cuentas browser.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { adapterFor } from "@/lib/command/networks";
import type { CcNetwork } from "@/lib/command/types";
import type { CcActionRow } from "@/lib/command/actions-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const network = request.nextUrl.searchParams.get("network");
  const accountRef = request.nextUrl.searchParams.get("account");
  const connectionId = request.nextUrl.searchParams.get("connection");
  if ((network !== "google_ads" && network !== "meta_ads") || !accountRef) {
    return NextResponse.json({ error: "network y account son obligatorios" }, { status: 400 });
  }
  if (network === "google_ads" && !connectionId) {
    return NextResponse.json({ error: "connection es obligatorio para Google" }, { status: 400 });
  }
  try {
    const deps = buildExecutorDeps(access.accessToken);
    const auth = await deps.auth.resolve({
      network, connectionId: connectionId ?? null, workspaceId: access.workspaceIds[0] ?? "",
    } as unknown as CcActionRow);
    const adapter = adapterFor(network as CcNetwork);
    const caps = adapter.capabilities(auth);
    if (!caps.read) return NextResponse.json({ error: caps.reason ?? "sin acceso de lectura" }, { status: 409 });
    const campaigns = await adapter.listCampaigns(auth, accountRef);
    return NextResponse.json({ campaigns, capabilities: caps });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 502 });
  }
}
