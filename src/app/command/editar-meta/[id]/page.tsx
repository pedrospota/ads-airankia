import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/header";
import { UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { getBlueprint } from "@/lib/command/blueprint/repo";
import { parseMetaEditDoc } from "@/lib/command/edit/meta-schema";
import MetaEditorClient from "./meta-editor-client";

// Auth + DB reads (blueprint) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Meta edit docs are keyed by this literal docType — the mutual-exclusion
 * mirror of editar/[id]/page.tsx's google guard (a load-bearing fail-closed
 * check: each editor only ever renders its own doc family). */
function isMetaEditDoc(doc: unknown): boolean {
  return (doc as { docType?: unknown } | null)?.docType === "meta_edit_v1";
}

export default async function EditarCampanaMetaPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  const { id } = await params;

  const blueprint = await getBlueprint(id, access.workspaceIds);
  if (!blueprint || !isMetaEditDoc(blueprint.doc)) notFound();

  let doc;
  try {
    doc = parseMetaEditDoc(blueprint.doc);
  } catch {
    notFound();
  }

  return (
    <div>
      <Header
        breadcrumbs={[
          { label: "Centro de Mando", href: "/command" },
          { label: "Cuentas", href: "/command/cuentas" },
          { label: "Editar campaña Meta" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <MetaEditorClient
          key={blueprint.id}
          blueprintId={blueprint.id}
          doc={doc}
          status={blueprint.status}
          accountRef={blueprint.accountRef}
        />
      </main>
    </div>
  );
}
