import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getBlueprint, saveBlueprintDoc } from "@/lib/command/blueprint/repo";
import { compile } from "@/lib/command/blueprint/compile";
import { parseBlueprint } from "@/lib/command/blueprint/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  try {
    const blueprint = await getBlueprint(id, access.workspaceIds);
    if (!blueprint) return NextResponse.json({ error: "no encontrado" }, { status: 404 });
    const compiled = compile(parseBlueprint(blueprint.doc), id);
    return NextResponse.json({ blueprint, compiled });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}

interface SaveBody {
  doc?: unknown;
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  let body: SaveBody;
  try { body = (await request.json()) as SaveBody; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const blueprint = await getBlueprint(id, access.workspaceIds);
  if (!blueprint) return NextResponse.json({ error: "no encontrado" }, { status: 404 });

  try {
    // Re-validate on every save — reject an invalid doc with the Zod message rather than
    // persisting it. The parsed value is only used to prove validity; the RAW body.doc is
    // what gets saved (parseBlueprint strips the optional `_ai` copiloto-marker sibling
    // that compileBlueprintToActions later reads off the raw jsonb).
    parseBlueprint(body.doc);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "doc de blueprint inválido" }, { status: 400 });
  }

  if (blueprint.status !== "draft") {
    return NextResponse.json({ error: `No se puede editar desde estado ${blueprint.status}` }, { status: 409 });
  }

  try {
    const updated = await saveBlueprintDoc(id, body.doc, access.workspaceIds);
    if (!updated) {
      return NextResponse.json({ error: "El blueprint ya no está en borrador." }, { status: 409 });
    }
    return NextResponse.json({ blueprint: updated });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
