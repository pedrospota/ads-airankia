import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getBlueprint, saveBlueprintDoc } from "@/lib/command/blueprint/repo";
import { compile } from "@/lib/command/blueprint/compile";
import { parseBlueprint } from "@/lib/command/blueprint/schema";
import { diffEditDoc } from "@/lib/command/edit/diff";
import { mergeEditDoc, parseEditDoc } from "@/lib/command/edit/schema";

/** v2.3 edit docs are keyed by this literal docType, distinct from the v2 create-blueprint doc. */
function isEditDoc(doc: unknown): boolean {
  return (doc as { docType?: unknown } | null)?.docType === "google_search_edit_v1";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  try {
    const blueprint = await getBlueprint(id, access.workspaceIds);
    if (!blueprint) return NextResponse.json({ error: "no encontrado" }, { status: 404 });
    // v2.3 EDIT-DOC BRANCH: edit docs preview through diffEditDoc (the differ), not the
    // v2 create compiler — same response shape (`compiled`), each EditCompiledAction
    // already carries `note`/`expected` for the review UI.
    const compiled = isEditDoc(blueprint.doc)
      ? diffEditDoc(parseEditDoc(blueprint.doc), id)
      : compile(parseBlueprint(blueprint.doc), id);
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

  // v2.3 EDIT-DOC BRANCH: docs saved by the edit-tree flow carry docType
  // "google_search_edit_v1" and are applied through mergeEditDoc (client-owned fields
  // merged onto the server-owned baseline/resourceNames), never parseBlueprint. The
  // create-doc path below this block is untouched for every other docType.
  if (isEditDoc(blueprint.doc)) {
    let merged;
    try {
      merged = mergeEditDoc(parseEditDoc(blueprint.doc), body.doc);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "doc de edición inválido" }, { status: 400 });
    }

    if (blueprint.status !== "draft") {
      return NextResponse.json({ error: `No se puede editar desde estado ${blueprint.status}` }, { status: 409 });
    }

    try {
      const updated = await saveBlueprintDoc(id, merged, access.workspaceIds);
      if (!updated) {
        return NextResponse.json({ error: "El blueprint ya no está en borrador." }, { status: 409 });
      }
      return NextResponse.json({ blueprint: updated });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
    }
  }

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
