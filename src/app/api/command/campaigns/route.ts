// On-demand campaign snapshots (+ v2.6 range-scoped metrics) for the Centro de
// Mando Cuentas browser.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { adapterFor } from "@/lib/command/networks";
import type { CampaignMetrics, CcMetricsRange, CcNetwork } from "@/lib/command/types";
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
  const rangeParam = request.nextUrl.searchParams.get("range") ?? "30d";
  if ((network !== "google_ads" && network !== "meta_ads") || !accountRef) {
    return NextResponse.json({ error: "network y account son obligatorios" }, { status: 400 });
  }
  if (network === "google_ads" && !connectionId) {
    return NextResponse.json({ error: "connection es obligatorio para Google" }, { status: 400 });
  }
  if (rangeParam !== "7d" && rangeParam !== "30d") {
    return NextResponse.json({ error: "range debe ser 7d o 30d" }, { status: 400 });
  }
  const range: CcMetricsRange = rangeParam;
  try {
    const deps = buildExecutorDeps(access.accessToken);
    const auth = await deps.auth.resolve({
      network, connectionId: connectionId ?? null, workspaceId: access.workspaceIds[0] ?? "",
    } as unknown as CcActionRow);
    const adapter = adapterFor(network as CcNetwork);
    const caps = adapter.capabilities(auth);
    if (!caps.read) return NextResponse.json({ error: caps.reason ?? "sin acceso de lectura" }, { status: 409 });

    // Metrics is a sibling read (spec risk #1): its promise is caught INSIDE the
    // Promise.all leg so a rejection there can never fail — or filter — the
    // entity list. Adapters without the optional method resolve to null here,
    // same shape as a caught failure, and both surface as `metrics: []` below.
    const metricsPromise = (adapter.listCampaignMetrics?.(auth, accountRef, range) ?? Promise.resolve(null))
      .then((metrics: CampaignMetrics[] | null) => ({ metrics, error: null as string | null }))
      .catch((e: unknown) => ({
        metrics: null as CampaignMetrics[] | null,
        error: e instanceof Error ? e.message : "error cargando métricas",
      }));

    const [campaigns, metricsResult] = await Promise.all([
      adapter.listCampaigns(auth, accountRef),
      metricsPromise,
    ]);

    return NextResponse.json({
      campaigns,
      metrics: metricsResult.metrics ?? [],
      range,
      ...(metricsResult.error ? { metricsError: metricsResult.error } : {}),
      capabilities: caps,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 502 });
  }
}
