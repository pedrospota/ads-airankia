// ============================================================================
// POST /api/performance/engine-csv — proxy one of the engine's CSV/JSONL
// exports to the logged-in user as a file download.
//
// Body: { path } STRICTLY allowlisted (exact base or base + "?query") — the
// browser never sees the engine URL nor the key. The engine response is
// streamed straight through with its content-type; Content-Disposition is
// always attachment.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { engineCsv } from "@/lib/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only these engine exports can be proxied (optional query allowed). */
const ALLOWED_PATHS = [
  "/export/approved.csv", // optional &account=
  "/export/recommendations.csv",
  "/export/decision-records.csv",
  "/export/decision-records.jsonl",
  "/export/playbook.csv",
  "/optimizers.csv", // optional &days=&account=
] as const;

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { path?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const path = String(body.path ?? "").trim();
  // startsWith against the allowlist: the exact base, optionally followed by a
  // query string. Control chars / whitespace never allowed.
  const base = ALLOWED_PATHS.find(
    (p) => path === p || path.startsWith(`${p}?`)
  );
  // eslint-disable-next-line no-control-regex
  if (!base || /[\s\u0000-\u001f]/.test(path)) {
    return NextResponse.json({ error: "path no permitido" }, { status: 400 });
  }

  try {
    const upstream = await engineCsv(path);
    if (upstream.status !== 200 || !upstream.body) {
      return NextResponse.json(
        { error: `El optimizador respondió ${upstream.status} en ${base}.` },
        { status: 502 }
      );
    }

    const filename = base.split("/").pop() as string;
    const headers = new Headers();
    headers.set(
      "Content-Type",
      upstream.headers.get("content-type") ??
        (base.endsWith(".jsonl") ? "application/x-ndjson" : "text/csv")
    );
    headers.set(
      "Content-Disposition",
      upstream.headers.get("content-disposition") ??
        `attachment; filename=${filename}`
    );
    headers.set("Cache-Control", "no-store");
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No se pudo descargar el export." },
      { status: 502 }
    );
  }
}
