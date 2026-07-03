// ============================================================================
// POST /api/performance/ga4-event — set (or clear) the TRUE GA4 conversion
// event for a property. Forwarded to the engine's legacy POST /ga4-event via
// enginePostForm (urlencoded, key inside the body) — SENTINEL_API_KEY never
// reaches the browser. Read-only for Google Ads: it only changes what the
// next scan counts as conversion.
//
// Accepts BOTH:
//   • JSON  { property_id, chosen_event }            → responds { ok }
//   • HTML form post (application/x-www-form-urlencoded, from Ajustes)
//     → responds 303 back to /performance/ajustes?ga4=ok|err
// chosen_event vacío = volver a "auto (sin basura)".
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { enginePostForm } from "@/lib/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function backToAjustes(request: NextRequest, flag: "ok" | "err"): NextResponse {
  return NextResponse.redirect(
    new URL(`/performance/ajustes?ga4=${flag}`, request.url),
    { status: 303 }
  );
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const isJson = (request.headers.get("content-type") ?? "").includes("application/json");

  let propertyId = "";
  let chosenEvent = "";
  try {
    if (isJson) {
      const body = (await request.json()) as { property_id?: unknown; chosen_event?: unknown };
      propertyId = String(body.property_id ?? "").trim();
      chosenEvent = String(body.chosen_event ?? "").trim();
    } else {
      const form = await request.formData();
      propertyId = String(form.get("property_id") ?? "").trim();
      chosenEvent = String(form.get("chosen_event") ?? "").trim();
    }
  } catch {
    return isJson
      ? NextResponse.json({ error: "invalid_body" }, { status: 400 })
      : backToAjustes(request, "err");
  }

  if (!propertyId) {
    return isJson
      ? NextResponse.json({ error: "property_id es obligatorio" }, { status: 400 })
      : backToAjustes(request, "err");
  }

  try {
    // enginePostForm injects the key into the form body ("key" field).
    const out = await enginePostForm("/ga4-event", {
      property_id: propertyId,
      chosen_event: chosenEvent,
    });
    if (isJson) {
      return NextResponse.json({ ok: out.ok });
    }
    return backToAjustes(request, out.ok ? "ok" : "err");
  } catch (e) {
    if (isJson) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "No se pudo guardar el evento GA4." },
        { status: 502 }
      );
    }
    return backToAjustes(request, "err");
  }
}
