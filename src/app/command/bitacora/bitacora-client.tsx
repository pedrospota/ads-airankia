"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, DataTable, THead, Row, Cell, Badge, EmptyState, SecondaryButton, GhostDangerButton, UI } from "@/components/ui-kit";
import { executionsToCsv, formatBeforeAfter, type ExecutionDto } from "@/lib/command/report-csv";

export type { ExecutionDto };

/** bitacora-YYYY-MM-DD.csv, from the download instant (browser-local date). */
function csvFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `bitacora-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
}

export default function BitacoraClient({ rows }: { rows: ExecutionDto[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revert(actionId: string) {
    setBusyId(actionId); setError(null);
    try {
      const res = await fetch(`/api/command/actions/${actionId}/rollback`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? (data.blocked ? "Bloqueada por compuertas" : `HTTP ${res.status}`));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error revirtiendo");
    } finally { setBusyId(null); }
  }

  // Client-side only (design spec §e) — serializes the rows already loaded on
  // this page (listExecutions(…, 200) in page.tsx), no new server surface.
  function exportCsv() {
    const csv = executionsToCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFilename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <SecondaryButton onClick={exportCsv} disabled={rows.length === 0}>
          Exportar CSV (últimas 200 ejecuciones visibles)
        </SecondaryButton>
        <SecondaryButton href="/command/bitacora/reporte">Resumen semanal →</SecondaryButton>
      </div>

      <Card>
        {error ? <p style={{ color: UI.danger, marginBottom: 12 }}>{error}</p> : null}
        {rows.length === 0 ? (
          <EmptyState title="Bitácora vacía" hint="Las ejecuciones (reales y ensayos) aparecerán aquí con su antes/después." />
        ) : (
          <DataTable>
            <THead cols={[{ label: "Cuándo" }, { label: "Red / cuenta" }, { label: "Operación" }, { label: "Antes → Después" }, { label: "Actor" }, { label: "Estado" }, { label: "Verificada" }, { label: "" }]} />
            <tbody>
              {rows.map((r) => (
                <Row key={r.id}>
                  <Cell mono>{r.createdAt ? new Date(r.createdAt).toLocaleString("es-MX") : "—"}</Cell>
                  <Cell>{r.network === "google_ads" ? "Google" : "Meta"}<span style={{ color: UI.faint }}> · {r.accountRef}</span></Cell>
                  <Cell>
                    {r.entityName}
                    <span style={{ display: "block", color: UI.faint, fontSize: 12 }}>
                      {r.operation}{r.validateOnly ? " · ensayo (dry-run)" : ""}
                    </span>
                  </Cell>
                  <Cell>{formatBeforeAfter(r.before, r.after)}</Cell>
                  <Cell>{r.actor}</Cell>
                  <Cell><Badge tone={r.status === "done" ? "ok" : r.status === "failed" ? "danger" : "muted"}>{r.status}</Badge></Cell>
                  <Cell>{r.actionStatus === "verified" ? <Badge tone="ok" dot>Sí</Badge> : <span style={{ color: UI.faint }}>—</span>}</Cell>
                  <Cell>
                    {!r.validateOnly && r.status === "done" && (r.actionStatus === "executed" || r.actionStatus === "verified") ? (
                      <GhostDangerButton disabled={busyId === r.actionId} onClick={() => revert(r.actionId)}>
                        {busyId === r.actionId ? "Revirtiendo…" : "Revertir"}
                      </GhostDangerButton>
                    ) : r.rollbackNote ? (
                      <span style={{ color: UI.faint, fontSize: 12 }}>{r.rollbackNote}</span>
                    ) : null}
                  </Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
    </>
  );
}
