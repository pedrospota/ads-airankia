"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, DataTable, THead, Row, Cell, Badge, EmptyState, GhostDangerButton, UI } from "@/components/ui-kit";

export interface ExecutionDto {
  id: string; actionId: string; network: string; accountRef: string;
  operation: string; validateOnly: boolean; status: string; actor: string;
  createdAt: string | null; actionType: string; entityName: string; actionStatus: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  rollbackNote: string | null;
}

function fmtBudget(v: unknown): string {
  return typeof v === "number" ? (v / 1_000_000).toFixed(2) : "—";
}
function diffLine(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!before) return "—";
  const b = `estado ${before.status ?? "?"} · $${fmtBudget(before.dailyBudgetMicros)}/día`;
  if (!after) return b;
  return `${b} → estado ${after.status ?? "?"} · $${fmtBudget(after.dailyBudgetMicros)}/día`;
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

  return (
    <Card>
      {error ? <p style={{ color: UI.danger, marginBottom: 12 }}>{error}</p> : null}
      {rows.length === 0 ? (
        <EmptyState title="Bitácora vacía" hint="Las ejecuciones (reales y ensayos) aparecerán aquí con su antes/después." />
      ) : (
        <DataTable>
          <THead cols={[{ label: "Cuándo" }, { label: "Red / cuenta" }, { label: "Operación" }, { label: "Antes → Después" }, { label: "Actor" }, { label: "Estado" }, { label: "" }]} />
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
                <Cell>{diffLine(r.before, r.after)}</Cell>
                <Cell>{r.actor}</Cell>
                <Cell><Badge tone={r.status === "done" ? "ok" : r.status === "failed" ? "danger" : "muted"}>{r.status}</Badge></Cell>
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
  );
}
