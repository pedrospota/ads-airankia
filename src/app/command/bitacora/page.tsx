import { redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, ErrorCard, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { listExecutions } from "@/lib/command/actions-repo";
import BitacoraClient, { type ExecutionDto } from "./bitacora-client";

// Auth + DB reads (executions) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function BitacoraPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");

  let error: string | null = null;
  let rows: ExecutionDto[] = [];
  try {
    const executions = await listExecutions(access.workspaceIds, 200);
    rows = executions.map(({ execution: e, action: a }) => ({
      id: e.id,
      actionId: a.id,
      network: a.network,
      accountRef: e.accountRef,
      operation: e.operation,
      validateOnly: e.validateOnly,
      status: e.status,
      actor: e.actor,
      createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : null,
      actionType: a.actionType,
      entityName: a.entityName ?? a.entityRef,
      actionStatus: a.status,
      before: (e.before ?? null) as Record<string, unknown> | null,
      after: (e.after ?? null) as Record<string, unknown> | null,
      rollbackNote: ((e.rollbackRecipe as { note?: string } | null)?.note) ?? null,
    }));
  } catch (e) {
    error = e instanceof Error ? e.message : "Error cargando la bitácora";
  }

  return (
    <div>
      <Header
        breadcrumbs={[{ label: "Centro de Mando", href: "/command" }, { label: "Bitácora" }]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Bitácora"
          subtitle="Registro inmutable de cada ejecución: antes/después, actor, compuertas y receta de reversión."
        />
        {error ? <ErrorCard message={error} /> : null}
        <BitacoraClient rows={rows} />
      </main>
    </div>
  );
}
