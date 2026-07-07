import { redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, ErrorCard, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { listActions } from "@/lib/command/actions-repo";
import AccionesClient, { type ActionRowDto } from "./acciones-client";

// Auth + DB reads (actions) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AccionesPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");

  let error: string | null = null;
  let actions: ActionRowDto[] = [];
  try {
    const rows = await listActions(access.workspaceIds, { limit: 200 });
    actions = rows.map((r) => ({
      id: r.id,
      network: r.network as ActionRowDto["network"],
      accountRef: r.accountRef,
      entityKind: r.entityKind,
      entityRef: r.entityRef,
      entityName: r.entityName,
      actionType: r.actionType,
      payload: r.payload as Record<string, unknown>,
      source: r.source,
      status: r.status as ActionRowDto["status"],
      rationale: r.rationale,
      approvedBy: r.approvedBy,
      gateResults: (r.gateResults ?? null) as ActionRowDto["gateResults"],
      error: r.error,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    }));
  } catch (e) {
    error = e instanceof Error ? e.message : "Error cargando acciones";
  }

  return (
    <div>
      <Header
        breadcrumbs={[{ label: "Centro de Mando", href: "/command" }, { label: "Acciones" }]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Acciones"
          subtitle="Cola multi-red. Dos pasos siempre: Aprobar registra el baseline; Ejecutar corre las compuertas y solo entonces toca la red."
        />
        {error ? <ErrorCard message={error} /> : null}
        <AccionesClient initialActions={actions} />
      </main>
    </div>
  );
}
