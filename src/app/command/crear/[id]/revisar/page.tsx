import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, ErrorCard, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { getBlueprint } from "@/lib/command/blueprint/repo";
import { compile, type CompiledAction } from "@/lib/command/blueprint/compile";
import { parseBlueprint } from "@/lib/command/blueprint/schema";
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
  let error: string | null = null;
  try {
    compiled = compile(parseBlueprint(blueprint.doc), id);
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
          subtitle="Cada acción que se enviará a Google Ads, agrupada por nodo de la campaña. Nada toca la cuenta hasta que confirmes abajo — todo nace en pausa."
        />
        {error ? (
          <ErrorCard message={error} />
        ) : (
          <RevisarClient
            blueprintId={id}
            status={blueprint.status}
            network={blueprint.network}
            accountRef={blueprint.accountRef}
            compiled={compiled}
          />
        )}
      </main>
    </div>
  );
}
