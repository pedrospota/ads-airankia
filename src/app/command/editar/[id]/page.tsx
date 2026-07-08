import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/header";
import { UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { getBlueprint } from "@/lib/command/blueprint/repo";
import { parseEditDoc } from "@/lib/command/edit/schema";
import { readProv } from "@/lib/command/patch/schema";
import EditorClient from "./editor-client";

// Auth + DB reads (blueprint) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** v2.3 edit docs are keyed by this literal docType, distinct from the v2 create-blueprint doc
 * (mirrors the same check in src/app/api/command/blueprint/[id]/route.ts). */
function isEditDoc(doc: unknown): boolean {
  return (doc as { docType?: unknown } | null)?.docType === "google_search_edit_v1";
}

export default async function EditarCampanaPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  const { id } = await params;

  const blueprint = await getBlueprint(id, access.workspaceIds);
  if (!blueprint || !isEditDoc(blueprint.doc)) notFound();

  let doc;
  try {
    doc = parseEditDoc(blueprint.doc);
  } catch {
    notFound();
  }

  return (
    <div>
      <Header
        breadcrumbs={[
          { label: "Centro de Mando", href: "/command" },
          { label: "Cuentas", href: "/command/cuentas" },
          { label: "Editar campaña" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <EditorClient
          key={blueprint.id}
          blueprintId={blueprint.id}
          doc={doc}
          status={blueprint.status}
          connectionId={blueprint.connectionId}
          accountRef={blueprint.accountRef}
          // v2.4 Copiloto — the RAW `_prov` sibling (parseEditDoc strips it, same convention
          // as `_ai`) so accepted-AI badges survive a reload, not just the in-session state.
          initialProv={readProv(blueprint.doc)}
        />
      </main>
    </div>
  );
}
