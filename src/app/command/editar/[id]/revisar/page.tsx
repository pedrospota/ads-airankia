import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, ErrorCard, EmptyState, SecondaryButton, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { getBlueprint } from "@/lib/command/blueprint/repo";
import { diffEditDoc, type EditCompiledAction } from "@/lib/command/edit/diff";
import { EDIT_BASELINE_MAX_AGE_MS, parseEditDoc, type GoogleSearchEditDoc } from "@/lib/command/edit/schema";
import { previewBlueprintGates, type GatePreview } from "@/lib/command/blueprint/preview";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import RevisarClient from "./revisar-client";

// Auth + DB reads (blueprint) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** v2.3 edit docs are keyed by this literal docType, distinct from the v2 create-blueprint doc
 * (mirrors the same check in editar/[id]/page.tsx and blueprint/route.ts). */
function isEditDoc(doc: unknown): boolean {
  return (doc as { docType?: unknown } | null)?.docType === "google_search_edit_v1";
}

/** Milliseconds since `loadedAt` — a plain helper (not inlined in the component body) so the
 * one-time Date.now() read at request time doesn't trip react-hooks/purity's "no impure calls
 * during render" check (see src/app/performance/simulacion/page.tsx's daysOpen() for the same
 * pattern). Mirrors the TTL check compileBlueprintToActions runs before recompiling (repo.ts). */
function ageMs(loadedAt: string): number {
  return Date.now() - Date.parse(loadedAt);
}

export default async function RevisarEditPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  const { id } = await params;

  const blueprint = await getBlueprint(id, access.workspaceIds);
  if (!blueprint || !isEditDoc(blueprint.doc)) notFound();

  let doc: GoogleSearchEditDoc | null = null;
  let compiled: EditCompiledAction[] = [];
  let gatePreview: GatePreview | null = null;
  let error: string | null = null;
  let noChanges = false;

  try {
    doc = parseEditDoc(blueprint.doc);
    compiled = diffEditDoc(doc, id);
    if (compiled.length === 0) {
      noChanges = true;
    } else {
      // Proactive gate preview (spec §10), same as the create flow: run the SAME
      // deterministic gates the executor runs at publish time, server-side, so the review
      // screen can show "compuertas: N/N" BEFORE the operator clicks Aplicar cambios.
      const execDeps = buildExecutorDeps(access.accessToken);
      gatePreview = await previewBlueprintGates(id, access.workspaceIds, {
        settings: execDeps.settings,
        repo: execDeps.repo,
      });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Error calculando los cambios del blueprint";
  }

  // Baseline staleness: computed server-side, once, at request time. Frozen into a prop
  // rather than recomputed client-side, so there is no server/client Date.now() hydration
  // skew.
  const baselineAgeMs = doc ? ageMs(doc.loadedAt) : 0;
  const baselineStale = !doc || !Number.isFinite(baselineAgeMs) || baselineAgeMs > EDIT_BASELINE_MAX_AGE_MS;

  return (
    <div>
      <Header
        breadcrumbs={[
          { label: "Centro de Mando", href: "/command" },
          { label: "Editar campaña", href: `/command/editar/${id}` },
          { label: "Revisión" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Revisar y aplicar cambios"
          subtitle="Cada acción que se enviará a Google Ads, agrupada por nodo de la campaña. Estos cambios se aplican a una campaña EN VIVO al publicar."
        />
        {noChanges ? (
          <EmptyState
            title="No hay cambios que aplicar"
            hint="No se detectaron diferencias entre el borrador y la campaña en vivo."
            action={<SecondaryButton href={`/command/editar/${id}`}>Volver al editor</SecondaryButton>}
          />
        ) : error || !doc || !gatePreview ? (
          <ErrorCard message={error ?? "Error preparando la vista previa de compuertas."} />
        ) : (
          <RevisarClient
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
