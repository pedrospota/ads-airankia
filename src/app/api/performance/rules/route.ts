// ============================================================================
// POST /api/performance/rules — save the account's declared business rules
// (constraints the optimizer respects: objetivo, CPA/ROAS targets, marca
// intencional, fase, notas). Mirrors the engine's BusinessProfile fields.
//
// Body: { accountId, objetivo?, cpa_objetivo?, roas_objetivo?,
//         marca_intencional?, fase?, excluir_campanas?, notas? }.
// Auth-gated with the Supabase session; the engine call is server-to-server
// (SENTINEL_API_KEY never reaches the browser).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { postRules } from "@/lib/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const accountId = String(body.accountId ?? "").trim();
  if (!accountId) {
    return NextResponse.json({ error: "accountId es obligatorio" }, { status: 400 });
  }

  // Only forward the typed BusinessProfile fields (never the raw body).
  const rules: Record<string, unknown> = {
    objetivo: String(body.objetivo ?? "").trim() || null,
    cpa_objetivo: num(body.cpa_objetivo),
    roas_objetivo: num(body.roas_objetivo),
    marca_intencional: Boolean(body.marca_intencional),
    fase: String(body.fase ?? "").trim() || null,
    excluir_campanas: Array.isArray(body.excluir_campanas)
      ? body.excluir_campanas.map((c) => String(c)).filter(Boolean)
      : [],
    notas: String(body.notas ?? "").trim().slice(0, 500) || null,
  };

  try {
    const out = await postRules(accountId, rules);
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No se pudieron guardar las reglas." },
      { status: 502 }
    );
  }
}
