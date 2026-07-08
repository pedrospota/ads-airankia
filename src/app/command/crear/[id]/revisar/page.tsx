import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, ErrorCard, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { getBlueprint } from "@/lib/command/blueprint/repo";
import { compile, type CompiledAction } from "@/lib/command/blueprint/compile";
import { compileMeta } from "@/lib/command/blueprint/meta-compile";
import { parseBlueprint } from "@/lib/command/blueprint/schema";
import { parseMetaBlueprint } from "@/lib/command/blueprint/meta-schema";
import { previewBlueprintGates, type GatePreview } from "@/lib/command/blueprint/preview";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { deriveAiMarkers, readProv } from "@/lib/command/patch/schema";
import RevisarClient from "./revisar-client";

// Auth + DB reads (blueprint) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function RevisarPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  const { id } = await params;

  const blueprint = await getBlueprint(id, access.workspaceIds);
  if (!blueprint) notFound();

  let compiled: CompiledAction[] = [];
  let gatePreview: GatePreview | null = null;
  let error: string | null = null;
  // v2.4 Copiloto — the compiled action's own `localRef` matched against deriveAiMarkers'
  // output is EXACTLY repo.ts's `aiPaths.has(action.localRef)` read path (google create only —
  // `_ai`/`_prov` are a google-blueprint-only convention, meta docs never carry them), reused
  // here purely for display (which cards get the "✦ IA" badge), never for gating.
  let aiMarkers: string[] = [];
  try {
    // v2.2: dispatch on the ROW's `network` column, mirroring repo.ts's
    // compileBlueprintToActions and the [id] GET route — meta_ads blueprints compile via
    // compileMeta/parseMetaBlueprint, never the google-only compile/parseBlueprint below
    // (whose schema literal-rejects a "meta_ads" doc). Without this branch the review
    // screen could never render a Meta blueprint's action list.
    if (blueprint.network === "meta_ads") {
      compiled = compileMeta(parseMetaBlueprint(blueprint.doc), id);
    } else {
      const doc = parseBlueprint(blueprint.doc);
      compiled = compile(doc, id);
      aiMarkers = deriveAiMarkers(doc, readProv(blueprint.doc));
    }
    // Proactive gate preview (spec §10): run the SAME deterministic gates the executor runs
    // at publish time, server-side, so the review screen can show "compuertas: N/N" BEFORE
    // the operator clicks Publish — not only reactively, after a 409. Reuses the exact
    // settings/countExecutedToday accessors buildExecutorDeps wires for the real execute path.
    const execDeps = buildExecutorDeps(access.accessToken);
    gatePreview = await previewBlueprintGates(id, access.workspaceIds, {
      settings: execDeps.settings,
      repo: execDeps.repo,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : "Error compilando el blueprint";
  }

  return (
    <div>
      <Header
        breadcrumbs={[
          { label: "Centro de Mando", href: "/command" },
          { label: "Constructor", href: "/command/crear" },
          { label: "Revisión" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Revisar y publicar"
          subtitle={`Cada acción que se enviará a ${blueprint.network === "meta_ads" ? "Meta Ads" : "Google Ads"}, agrupada por nodo de la campaña. Nada toca la cuenta hasta que confirmes abajo — todo nace en pausa.`}
        />
        {error || !gatePreview ? (
          <ErrorCard message={error ?? "Error preparando la vista previa de compuertas."} />
        ) : (
          <RevisarClient
            blueprintId={id}
            status={blueprint.status}
            network={blueprint.network}
            accountRef={blueprint.accountRef}
            compiled={compiled}
            gatePreview={gatePreview}
            aiMarkers={aiMarkers}
          />
        )}
      </main>
    </div>
  );
}
