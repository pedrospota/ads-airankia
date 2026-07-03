// ============================================================================
// POST /api/performance/generate — fire an on-demand generation on the engine
// (re-análisis IA, audit-ai, escaneo de landings, briefs de equipo, resumen de
// reporte). The engine runs the job in a background thread and the fresh data
// appears on the next page refresh (~30 s).
//
// Body: { accountId, kind } with kind in KIND_PATH below. Auth-gated with the
// Supabase session; the engine call happens server-to-server via
// src/lib/sentinel.ts (?key=SENTINEL_API_KEY never reaches the browser).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { engineTrigger } from "@/lib/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** kind → legacy engine GET path (all propose-only / read-only jobs). */
const KIND_PATH: Record<string, (id: string) => string> = {
  "reason-now": (id) => `/account/${id}/reason-now`,
  "audit-ai": (id) => `/account/${id}/audit-ai`,
  "landing-scan-now": (id) => `/account/${id}/landing-scan-now`,
  "landing-brief": (id) => `/account/${id}/landing-brief`,
  "tracking-brief": (id) => `/account/${id}/tracking-brief`,
  "team-brief:creativos": (id) => `/account/${id}/team-brief?kind=creativos`,
  "team-brief:audiencias": (id) => `/account/${id}/team-brief?kind=audiencias`,
  "team-brief:feed": (id) => `/account/${id}/team-brief?kind=feed`,
  "report-summary": (id) => `/account/${id}/report-summary`,
};

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { accountId?: unknown; kind?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const accountId = String(body.accountId ?? "").trim();
  const kind = String(body.kind ?? "").trim();
  const toPath = KIND_PATH[kind];
  if (!accountId || !toPath) {
    return NextResponse.json(
      { error: "accountId y un kind válido son obligatorios" },
      { status: 400 }
    );
  }

  try {
    const { ok, status } = await engineTrigger(toPath(encodeURIComponent(accountId)));
    if (!ok) {
      return NextResponse.json(
        { ok: false, error: `El optimizador respondió ${status}.` },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No se pudo lanzar la generación." },
      { status: 502 }
    );
  }
}
