"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, DataTable, THead, Row, Cell, Badge, EmptyState, SectionLabel, PrimaryButton, SecondaryButton, GhostDangerButton, UI } from "@/components/ui-kit";

export interface GateDto { id: string; severity: "blocking" | "warning"; status: "pass" | "fail"; evidence: string }
export interface ActionRowDto {
  id: string; network: "google_ads" | "meta_ads"; accountRef: string;
  entityKind: string; entityRef: string; entityName: string | null;
  actionType: string; payload: Record<string, unknown>; source: string;
  status: "proposed" | "approved" | "executing" | "executed" | "verified" | "failed" | "rolled_back" | "rejected" | "expired";
  rationale: string | null; approvedBy: string | null;
  gateResults: GateDto[] | null; error: string | null; createdAt: string | null;
}

const STATUS_TONE: Record<string, "ok" | "accent" | "warn" | "danger" | "muted"> = {
  proposed: "muted", approved: "warn", executing: "accent", executed: "ok",
  verified: "ok", failed: "danger", rolled_back: "muted", rejected: "muted", expired: "muted",
};
const TYPE_LABEL: Record<string, string> = {
  budget_update: "Cambio de presupuesto", pause: "Pausar", enable: "Activar", add_negatives: "Añadir negativas",
};
const NET_LABEL = { google_ads: "Google", meta_ads: "Meta" } as const;

// v2.6: "expired"/"verified" added to the filter row (design spec §c
// "Surface" — statuses cc_actions already types but never filters). Also
// doubles as the allowlist for the ?filter= deep link from the Novedades
// card (resumen/page.tsx) — an unrecognized/missing value falls back to
// "todas" rather than silently rendering an empty table.
const FILTER_OPTIONS = ["todas", "proposed", "approved", "executed", "verified", "failed", "rolled_back", "expired"];

export default function AccionesClient({ initialActions }: { initialActions: ActionRowDto[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [actions, setActions] = useState(initialActions);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [gatePanel, setGatePanel] = useState<{ id: string; gates: GateDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Preset from ?filter=<status> (Novedades deep link), one-time on mount —
  // additive on top of the existing local-only filter buttons, which still
  // work exactly as before once the operator clicks a different one.
  const [filter, setFilter] = useState<string>(() => {
    const fromUrl = searchParams.get("filter");
    return fromUrl && FILTER_OPTIONS.includes(fromUrl) ? fromUrl : "todas";
  });
  const [importForm, setImportForm] = useState({ engineAccountId: "", connectionId: "", accountRef: "" });
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const visible = useMemo(
    () => (filter === "todas" ? actions : actions.filter((a) => a.status === filter)),
    [actions, filter]
  );

  // Lazy verification sweep (design spec §c), mirrors resumen-client.tsx:
  // fire-and-forget on mount, refresh only if the sweep changed something.
  useEffect(() => {
    fetch("/api/command/verify", { method: "POST" })
      .then((r) => r.json())
      .then((res) => {
        if (res.expired || res.verified || res.drifted) router.refresh();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // router.refresh() re-renders the server page with fresh rows, but useState only
  // consumes initialActions on mount — re-sync so a post-sweep refresh actually
  // updates the table (expired/verified/drifted rows would otherwise render stale).
  useEffect(() => {
    setActions(initialActions);
  }, [initialActions]);

  async function call(id: string, verb: "approve" | "reject" | "execute" | "rollback") {
    setBusyId(id); setError(null); setGatePanel(null);
    try {
      const res = await fetch(`/api/command/actions/${id}/${verb}`, { method: "POST" });
      const data = await res.json();
      if (res.status === 409 && data.blocked) {
        setGatePanel({ id, gates: data.blocked });
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.refresh();
      // optimistic local update so the row reflects immediately
      setActions((prev) => prev.map((a) => a.id === id ? {
        ...a,
        status: verb === "approve" ? "approved" : verb === "reject" ? "rejected"
          : verb === "execute" ? (data.dryRun ? "approved" : "executed") : "rolled_back",
      } : a));
      if (data.dryRun) setError("Modo CC_DRY_RUN activo: se registró un ensayo, no una ejecución real.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally { setBusyId(null); }
  }

  async function importEngine() {
    setImportMsg(null); setError(null);
    try {
      const res = await fetch("/api/command/import-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine_account_id: importForm.engineAccountId,
          connection_id: importForm.connectionId,
          account_ref: importForm.accountRef,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setImportMsg(`Importadas ${data.imported} (duplicadas ${data.duplicated}, no mapeables ${data.skipped}).`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error importando del motor");
    }
  }

  const inputStyle = { background: UI.surface2, border: `1px solid ${UI.border}`, borderRadius: 8, color: UI.text, padding: "8px 10px", fontSize: 13 } as const;

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <SectionLabel>Importar del motor (Google)</SectionLabel>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input style={inputStyle} placeholder="ID de cuenta en el motor" value={importForm.engineAccountId}
            onChange={(e) => setImportForm((f) => ({ ...f, engineAccountId: e.target.value }))} />
          <input style={inputStyle} placeholder="connection_id (Conexiones)" value={importForm.connectionId}
            onChange={(e) => setImportForm((f) => ({ ...f, connectionId: e.target.value }))} />
          <input style={inputStyle} placeholder="customer_id destino" value={importForm.accountRef}
            onChange={(e) => setImportForm((f) => ({ ...f, accountRef: e.target.value }))} />
          <SecondaryButton onClick={importEngine}>Importar recomendaciones</SecondaryButton>
          {importMsg ? <span style={{ color: UI.accent, fontSize: 13 }}>{importMsg}</span> : null}
        </div>
      </Card>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {FILTER_OPTIONS.map((s) => (
          <SecondaryButton key={s} onClick={() => setFilter(s)}
            style={filter === s ? { borderColor: UI.accent, color: UI.accent } : undefined}>
            {s === "todas" ? "Todas" : s}
          </SecondaryButton>
        ))}
      </div>

      {error ? <p style={{ color: UI.warn, marginBottom: 12 }}>{error}</p> : null}

      {gatePanel ? (
        <Card style={{ marginBottom: 16, borderColor: UI.danger }}>
          <SectionLabel>Compuertas — ejecución bloqueada</SectionLabel>
          <DataTable>
            <THead cols={[{ label: "Compuerta" }, { label: "Severidad" }, { label: "Estado" }, { label: "Evidencia" }]} />
            <tbody>
              {gatePanel.gates.map((g) => (
                <Row key={g.id}>
                  <Cell mono>{g.id}</Cell>
                  <Cell>{g.severity}</Cell>
                  <Cell><Badge tone={g.status === "pass" ? "ok" : g.severity === "blocking" ? "danger" : "warn"}>{g.status}</Badge></Cell>
                  <Cell>{g.evidence}</Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        </Card>
      ) : null}

      <Card>
        {visible.length === 0 ? (
          <EmptyState title="Sin acciones" hint="Importa recomendaciones del motor o propón acciones desde Cuentas." />
        ) : (
          <DataTable>
            <THead cols={[{ label: "Red" }, { label: "Acción" }, { label: "Entidad" }, { label: "Origen" }, { label: "Estado" }, { label: "" }]} />
            <tbody>
              {visible.map((a) => (
                <Row key={a.id}>
                  <Cell><Badge tone="muted">{NET_LABEL[a.network]}</Badge></Cell>
                  <Cell>
                    {TYPE_LABEL[a.actionType] ?? a.actionType}
                    {a.actionType === "budget_update" && typeof a.payload.newDailyBudgetMicros === "number"
                      ? ` → ${(Number(a.payload.newDailyBudgetMicros) / 1_000_000).toFixed(2)}/día` : ""}
                    {a.rationale ? <span style={{ display: "block", color: UI.faint, fontSize: 12 }}>{a.rationale}</span> : null}
                    {a.error ? <span style={{ display: "block", color: UI.danger, fontSize: 12 }}>{a.error}</span> : null}
                  </Cell>
                  <Cell mono>{a.entityName ?? a.entityRef}<span style={{ color: UI.faint }}> · {a.accountRef}</span></Cell>
                  <Cell>{a.source}</Cell>
                  <Cell><Badge tone={STATUS_TONE[a.status] ?? "muted"}>{a.status}{a.approvedBy ? ` · ${a.approvedBy}` : ""}</Badge></Cell>
                  <Cell>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {a.status === "proposed" || a.status === "failed" ? (
                        <>
                          <PrimaryButton disabled={busyId === a.id} onClick={() => call(a.id, "approve")}>Aprobar</PrimaryButton>
                          <GhostDangerButton disabled={busyId === a.id} onClick={() => call(a.id, "reject")}>Rechazar</GhostDangerButton>
                        </>
                      ) : null}
                      {a.status === "approved" ? (
                        <PrimaryButton disabled={busyId === a.id} onClick={() => call(a.id, "execute")}>
                          {busyId === a.id ? "Ejecutando…" : "Ejecutar"}
                        </PrimaryButton>
                      ) : null}
                      {a.status === "executed" || a.status === "verified" ? (
                        <GhostDangerButton disabled={busyId === a.id} onClick={() => call(a.id, "rollback")}>Revertir</GhostDangerButton>
                      ) : null}
                    </div>
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
