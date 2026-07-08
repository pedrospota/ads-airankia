import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, ErrorCard, EmptyState, SecondaryButton, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { getBlueprint } from "@/lib/command/blueprint/repo";
import type { EditCompiledAction } from "@/lib/command/edit/diff";
import { diffMetaEditDoc } from "@/lib/command/edit/meta-diff";
import { EDIT_BASELINE_MAX_AGE_MS, parseMetaEditDoc, type MetaEditDoc } from "@/lib/command/edit/meta-schema";
import { previewBlueprintGates, type GatePreview } from "@/lib/command/blueprint/preview";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import MetaRevisarClient from "./meta-revisar-client";

// Auth + DB reads (blueprint) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isMetaEditDoc(doc: unknown): boolean {
  return (doc as { docType?: unknown } | null)?.docType === "meta_edit_v1";
}

/** One-time Date.now() read at request time (see revisar/page.tsx's ageMs for
 * the purity-lint rationale). Frozen into a prop — no hydration skew. */
function ageMs(loadedAt: string): number {
  return Date.now() - Date.parse(loadedAt);
}

export default async function RevisarMetaEditPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  const { id } = await params;

  const blueprint = await getBlueprint(id, access.workspaceIds);
  if (!blueprint || !isMetaEditDoc(blueprint.doc)) notFound();

  let doc: MetaEditDoc | null = null;
  let compiled: EditCompiledAction[] = [];
  let gatePreview: GatePreview | null = null;
  let error: string | null = null;
  let noChanges = false;

  try {
    doc = parseMetaEditDoc(blueprint.doc);
    compiled = diffMetaEditDoc(doc, id);
    if (compiled.length === 0) {
      noChanges = true;
    } else {
      const execDeps = buildExecutorDeps(access.accessToken);
      gatePreview = await previewBlueprintGates(id, access.workspaceIds, {
        settings: execDeps.settings,
        repo: execDeps.repo,
      });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Error calculando los cambios del blueprint";
  }

  const baselineAgeMs = doc ? ageMs(doc.loadedAt) : 0;
  const baselineStale = !doc || !Number.isFinite(baselineAgeMs) || baselineAgeMs > EDIT_BASELINE_MAX_AGE_MS;

  return (
    <div>
      <Header
        breadcrumbs={[
          { label: "Centro de Mando", href: "/command" },
          { label: "Editar campaña Meta", href: `/command/editar-meta/${id}` },
          { label: "Revisión" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Revisar y aplicar cambios"
          subtitle="Cada acción que se enviará a Meta, agrupada por nodo de la campaña. Estos cambios se aplican a una campaña EN VIVO al publicar."
        />
        {noChanges ? (
          <EmptyState
            title="No hay cambios que aplicar"
            hint="No se detectaron diferencias entre el borrador y la campaña en vivo."
            action={<SecondaryButton href={`/command/editar-meta/${id}`}>Volver al editor</SecondaryButton>}
          />
        ) : error || !doc || !gatePreview ? (
          <ErrorCard message={error ?? "Error preparando la vista previa de compuertas."} />
        ) : (
          <MetaRevisarClient
            blueprintId={id}
            status={blueprint.status}
            accountRef={blueprint.accountRef}
            doc={doc}
            compiled={compiled}
            gatePreview={gatePreview}
            baselineAgeMs={baselineAgeMs}
            baselineStale={baselineStale}
          />
        )}
      </main>
    </div>
  );
}
