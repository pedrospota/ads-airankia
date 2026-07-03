// ============================================================================
// /api/security/brand-domains — anti-hijack allowlist manager.
//
// GET  → list the brand domains the monitor treats as legitimate.
// POST → { action: "add" | "remove", domain, scope? } — mutate the allowlist.
//
// Auth-gated with the Supabase session; the engine call is server-to-server
// (SENTINEL_API_KEY never reaches the browser). `by` is stamped with the
// session user's email so the engine records who touched the list.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { fetchBrandDomains, postBrandDomain } from "@/lib/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const out = await fetchBrandDomains();
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "No se pudo cargar la lista de dominios.",
      },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { action?: unknown; domain?: unknown; scope?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const action =
    body.action === "add" ? "add" : body.action === "remove" ? "remove" : null;
  if (!action) {
    return NextResponse.json(
      { error: "action debe ser 'add' o 'remove'" },
      { status: 400 }
    );
  }

  const domain = String(body.domain ?? "")
    .trim()
    .toLowerCase()
    // por si llega una URL pegada: quitar protocolo, ruta y puerto
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split("?")[0]
    .split(":")[0];
  if (!domain) {
    return NextResponse.json({ error: "domain es obligatorio" }, { status: 400 });
  }

  const scope = String(body.scope ?? "global").trim() || "global";

  try {
    const out = await postBrandDomain({
      action,
      domain,
      scope,
      by: user.email ?? "plataforma",
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "No se pudo actualizar la lista de dominios.",
      },
      { status: 502 }
    );
  }
}
