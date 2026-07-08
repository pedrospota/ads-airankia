"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, DataTable, THead, Row, Cell, Badge, EmptyState, SectionLabel, PrimaryButton, SecondaryButton, GhostDangerButton, UI } from "@/components/ui-kit";
import type { UnifiedDestinationAccount } from "@/lib/command/accounts-list";

export interface GateDto { id: string; severity: "blocking" | "warning"; status: "pass" | "fail"; evidence: string }
export interface ActionRowDto {
  id: string; network: "google_ads" | "meta_ads"; accountRef: string;
  entityKind: string; entityRef: string; entityName: string | null;
  actionType: string; payload: Record<string, unknown>; source: string;
  status: "proposed" | "approved" | "executing" | "executed" | "verified" | "failed" | "rolled_back" | "rejected" | "expired";
  rationale: string | null; approvedBy: string | null;
  gateResults: GateDto[] | null; error: string | null; createdAt: string | null;
  // v2.6 (design spec §b) — the approve-time baseline snapshot, needed
  // client-side only to compute the batch execute confirm's budget-delta
  // sum (payload.newDailyBudgetMicros - expected.dailyBudgetMicros). The
  // DRIFT gate already reads this jsonb column server-side; this is purely
  // an additive read, no new write path.
  expected: { dailyBudgetMicros?: number | null; status?: string | null } | null;
}

export interface EngineAccountOption { id: string; label: string }

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

// v2.6 (design spec §b) — batch approve/reject/execute over the SAME
// per-action endpoints as the single-row buttons. No batch mutation route.
type BatchVerb = "approve" | "reject" | "execute";
const ACTIONABLE_STATUSES = new Set<ActionRowDto["status"]>(["proposed", "failed", "approved"]);
// Mirrors cc_settings' maxActionsPerAccountDay default (types.ts
// CC_SETTINGS_DEFAULTS) — a client-side speed bump only; server gates
// remain the real enforcement (BLAST_RADIUS reads the live setting).
const BATCH_CAP = 20;
const VERB_DONE_LABEL: Record<BatchVerb, string> = { approve: "aprobada ✓", reject: "rechazada ✓", execute: "ejecutada ✓" };
const VERB_PAST_PLURAL: Record<BatchVerb, string> = { approve: "aprobadas", reject: "rechazadas", execute: "ejecutadas" };

interface BatchOutcomeEntry {
  status: "ok" | "blocked" | "error";
  verb: BatchVerb;
  gates?: GateDto[];
  message?: string;
}

// Shared outcome of one fetch to a per-action endpoint, classified for the
// batch loop's stop/continue rule: ANY 409 (gate block, TTL expiry, a
// transition conflict) is "blocked" (continue); anything else non-ok
// (404/5xx) or a network exception is "error" (stop). Also does the exact
// same optimistic local state update the single-row call() always did, so
// both paths render identically on success.
type CallOutcome =
  | { status: "ok"; dryRun: boolean }
  | { status: "blocked"; gates?: GateDto[]; message: string }
  | { status: "error"; message: string };

const isDrift = (a: ActionRowDto) => a.status === "executed" && !!a.error;

export default function AccionesClient({
  initialActions,
  engineAccounts,
  destinationAccounts,
}: {
  initialActions: ActionRowDto[];
  engineAccounts: EngineAccountOption[];
  destinationAccounts: UnifiedDestinationAccount[];
}) {
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

  // Batch selection + run state.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchOutcomes, setBatchOutcomes] = useState<Record<string, BatchOutcomeEntry>>({});
  const [batchSummary, setBatchSummary] = useState<string | null>(null);

  const visible = useMemo(
    () => (filter === "todas" ? actions : actions.filter((a) => a.status === filter)),
    [actions, filter]
  );

  // Selection is scoped to "the current status filter" (design spec §b) so
  // a batch is always verb-homogeneous — switching filters starts fresh.
  useEffect(() => {
    setSelected(new Set());
    setBatchOutcomes({});
    setBatchSummary(null);
  }, [filter]);

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

  // Core fetch+decide+optimistic-update path — the SAME logic the single-row
  // call() has always run, extracted so the batch loop can invoke it row by
  // row without a second mutation path (design spec §b: "Every mutation
  // still enters POST .../execute → executeAction... its own ledger row").
  async function performAction(id: string, verb: "approve" | "reject" | "execute" | "rollback"): Promise<CallOutcome> {
    try {
      const res = await fetch(`/api/command/actions/${id}/${verb}`, { method: "POST" });
      const data = await res.json();
      if (res.status === 409) {
        const message = typeof data.error === "string" ? data.error : "bloqueada por compuertas";
        return { status: "blocked", gates: Array.isArray(data.blocked) ? data.blocked : undefined, message };
      }
      if (!res.ok) {
        return { status: "error", message: typeof data.error === "string" ? data.error : `HTTP ${res.status}` };
      }
      // optimistic local update so the row reflects immediately
      setActions((prev) => prev.map((a) => a.id === id ? {
        ...a,
        status: verb === "approve" ? "approved" : verb === "reject" ? "rejected"
          : verb === "execute" ? (data.dryRun ? "approved" : "executed") : "rolled_back",
      } : a));
      return { status: "ok", dryRun: Boolean(data.dryRun) };
    } catch (e) {
      return { status: "error", message: e instanceof Error ? e.message : "Error de red" };
    }
  }

  async function call(id: string, verb: "approve" | "reject" | "execute" | "rollback") {
    setBusyId(id); setError(null); setGatePanel(null);
    // Clear any stale batch-run chip for this row now that it's being
    // driven individually again.
    setBatchOutcomes((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev }; delete next[id]; return next;
    });
    const outcome = await performAction(id, verb);
    if (outcome.status === "blocked") {
      if (outcome.gates && outcome.gates.length > 0) setGatePanel({ id, gates: outcome.gates });
      else setError(outcome.message);
    } else if (outcome.status === "error") {
      setError(outcome.message);
    } else {
      router.refresh();
      if (outcome.dryRun) setError("Modo CC_DRY_RUN activo: se registró un ensayo, no una ejecución real.");
    }
    setBusyId(null);
  }

  // Sequential batch loop (design spec §b) — NEVER parallel: countExecutedToday
  // is read-then-gate inside executeAction, so parallel executes would race
  // BLAST_RADIUS/MAX_ACTIONS_PER_DAY. Continue past 409s (gate blocks, TTL
  // expiry, transition conflicts — all "bloqueada"); stop on the first
  // non-409 error and leave whatever wasn't reached yet still selected.
  async function runBatch(ids: string[], verb: BatchVerb) {
    const capped = ids.slice(0, BATCH_CAP);
    if (capped.length === 0 || batchRunning) return;
    setBatchRunning(true);
    setBatchSummary(null);
    setBatchOutcomes({});
    setError(null);
    let okCount = 0;
    let blockedCount = 0;
    let stopped = false;
    for (let i = 0; i < capped.length; i++) {
      const id = capped[i];
      setBatchProgress({ done: i, total: capped.length });
      const outcome = await performAction(id, verb);
      setBatchProgress({ done: i + 1, total: capped.length });
      // The row was attempted (whichever the outcome) — it's no longer
      // "unprocessed", so drop it from the selection. Only ids past the
      // stop point (never reached) remain selected.
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
      if (outcome.status === "ok") {
        okCount += 1;
        setBatchOutcomes((prev) => ({ ...prev, [id]: { status: "ok", verb } }));
        if (outcome.dryRun) setError("Modo CC_DRY_RUN activo: se registró un ensayo, no una ejecución real.");
      } else if (outcome.status === "blocked") {
        blockedCount += 1;
        setBatchOutcomes((prev) => ({ ...prev, [id]: { status: "blocked", verb, gates: outcome.gates, message: outcome.message } }));
      } else {
        setBatchOutcomes((prev) => ({ ...prev, [id]: { status: "error", verb, message: outcome.message } }));
        setError(outcome.message);
        stopped = true;
        break;
      }
    }
    setBatchProgress(null);
    setBatchRunning(false);
    router.refresh();
    setBatchSummary(
      `${okCount} ${VERB_PAST_PLURAL[verb]} · ${blockedCount} bloqueadas${stopped ? " · 1 error — proceso detenido" : ""}`
    );
  }

  function actionLabel(a: ActionRowDto): string {
    const budget = a.actionType === "budget_update" && typeof a.payload.newDailyBudgetMicros === "number"
      ? ` → ${(Number(a.payload.newDailyBudgetMicros) / 1_000_000).toFixed(2)}/día` : "";
    return `${NET_LABEL[a.network]} · ${TYPE_LABEL[a.actionType] ?? a.actionType}${budget} · ${a.entityName ?? a.entityRef}`;
  }

  function budgetDeltaSumMicros(rows: ActionRowDto[]): number {
    return rows.reduce((sum, a) => {
      if (a.actionType !== "budget_update") return sum;
      const next = typeof a.payload.newDailyBudgetMicros === "number" ? a.payload.newDailyBudgetMicros : null;
      const prev = a.expected?.dailyBudgetMicros ?? null;
      if (next == null || prev == null) return sum;
      return sum + (next - prev);
    }, 0);
  }

  // Execute is the only batch verb with a confirm (design spec §b) — count,
  // per-action labels, the summed budget delta, and the explicit ordering
  // caveat. Approve/reject are reversible (re-approve / re-propose) so they
  // fire immediately, same as their single-row buttons always have.
  function confirmAndRunExecuteBatch(rows: ActionRowDto[]) {
    if (rows.length === 0) return;
    const deltaMicros = budgetDeltaSumMicros(rows);
    const deltaStr = `${deltaMicros >= 0 ? "+" : ""}${(deltaMicros / 1_000_000).toFixed(2)}/día`;
    const msg =
      `Se ejecutarán ${rows.length} acciones:\n${rows.map(actionLabel).join("\n")}\n\n` +
      `Delta de presupuesto (suma): ${deltaStr}\n\n` +
      `Se ejecutan en orden, las bloqueadas se omiten.`;
    if (!window.confirm(msg)) return;
    runBatch(rows.map((a) => a.id), "execute");
  }

  const visibleActionableIds = useMemo(
    () => visible.filter((a) => ACTIONABLE_STATUSES.has(a.status)).map((a) => a.id),
    [visible]
  );

  function selectVisible() {
    setSelected(new Set(visibleActionableIds.slice(0, BATCH_CAP)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < BATCH_CAP) next.add(id);
      return next;
    });
  }

  const approvableSelected = useMemo(
    () => visible.filter((a) => selected.has(a.id) && (a.status === "proposed" || a.status === "failed")),
    [visible, selected]
  );
  const executableSelected = useMemo(
    () => visible.filter((a) => selected.has(a.id) && a.status === "approved"),
    [visible, selected]
  );

  function renderOutcomeChip(id: string, outcome: BatchOutcomeEntry) {
    if (outcome.status === "ok") {
      return <Badge tone="ok" dot>{VERB_DONE_LABEL[outcome.verb]}</Badge>;
    }
    if (outcome.status === "blocked") {
      const clickable = Boolean(outcome.gates && outcome.gates.length > 0);
      return (
        <span
          title={outcome.message}
          onClick={clickable ? () => setGatePanel({ id, gates: outcome.gates! }) : undefined}
          style={clickable ? { cursor: "pointer" } : undefined}
        >
          <Badge tone="warn" dot>bloqueada por compuertas</Badge>
        </span>
      );
    }
    return (
      <span title={outcome.message}>
        <Badge tone="danger" dot>error</Badge>
      </span>
    );
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
  const destinationValue = importForm.connectionId && importForm.accountRef ? `${importForm.connectionId}::${importForm.accountRef}` : "";

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <SectionLabel>Importar del motor (Google)</SectionLabel>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          {engineAccounts.length > 0 ? (
            <select
              style={inputStyle}
              value={importForm.engineAccountId}
              onChange={(e) => setImportForm((f) => ({ ...f, engineAccountId: e.target.value }))}
            >
              <option value="">Cuenta del motor…</option>
              {engineAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          ) : (
            <input style={inputStyle} placeholder="ID de cuenta en el motor" value={importForm.engineAccountId}
              onChange={(e) => setImportForm((f) => ({ ...f, engineAccountId: e.target.value }))} />
          )}
          {destinationAccounts.length > 0 ? (
            <select
              style={inputStyle}
              value={destinationValue}
              onChange={(e) => {
                const [connectionId, accountRef] = e.target.value.split("::");
                setImportForm((f) => ({ ...f, connectionId: connectionId ?? "", accountRef: accountRef ?? "" }));
              }}
            >
              <option value="">Cuenta destino…</option>
              {destinationAccounts.map((a) => (
                <option key={`${a.connectionId}::${a.accountRef}`} value={`${a.connectionId}::${a.accountRef}`}>{a.label}</option>
              ))}
            </select>
          ) : (
            <>
              <input style={inputStyle} placeholder="connection_id (Conexiones)" value={importForm.connectionId}
                onChange={(e) => setImportForm((f) => ({ ...f, connectionId: e.target.value }))} />
              <input style={inputStyle} placeholder="customer_id destino" value={importForm.accountRef}
                onChange={(e) => setImportForm((f) => ({ ...f, accountRef: e.target.value }))} />
            </>
          )}
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

      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <SecondaryButton onClick={selectVisible} disabled={batchRunning || visibleActionableIds.length === 0}>
          Seleccionar visibles
        </SecondaryButton>
        {selected.size > 0 ? (
          <>
            <span style={{ fontSize: 12.5, color: UI.muted }}>
              {selected.size} seleccionada{selected.size === 1 ? "" : "s"}{selected.size >= BATCH_CAP ? " (máx. 20)" : ""}
            </span>
            <button type="button" onClick={clearSelection} disabled={batchRunning}
              style={{ background: "none", border: "none", color: UI.faint, fontSize: 12.5, cursor: batchRunning ? "not-allowed" : "pointer", textDecoration: "underline", padding: 0 }}>
              Limpiar selección
            </button>
          </>
        ) : null}
      </div>

      {selected.size > 0 ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          {approvableSelected.length > 0 ? (
            <>
              <PrimaryButton disabled={batchRunning} onClick={() => runBatch(approvableSelected.map((a) => a.id), "approve")}>
                Aprobar seleccionadas ({approvableSelected.length})
              </PrimaryButton>
              <GhostDangerButton disabled={batchRunning} onClick={() => runBatch(approvableSelected.map((a) => a.id), "reject")}>
                Rechazar seleccionadas ({approvableSelected.length})
              </GhostDangerButton>
            </>
          ) : null}
          {executableSelected.length > 0 ? (
            <PrimaryButton disabled={batchRunning} onClick={() => confirmAndRunExecuteBatch(executableSelected)}>
              Ejecutar seleccionadas ({executableSelected.length})
            </PrimaryButton>
          ) : null}
          {batchProgress ? (
            <span style={{ fontSize: 12.5, color: UI.accent }}>{batchProgress.done}/{batchProgress.total}…</span>
          ) : null}
        </div>
      ) : null}

      {batchSummary ? <p style={{ color: UI.muted, marginBottom: 12, fontSize: 13 }}>{batchSummary}</p> : null}

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
            <THead cols={[{ label: "", width: 34 }, { label: "Red" }, { label: "Acción" }, { label: "Entidad" }, { label: "Origen" }, { label: "Estado" }, { label: "" }]} />
            <tbody>
              {visible.map((a) => (
                <Row key={a.id} style={isDrift(a) ? { background: `color-mix(in srgb, ${UI.danger} 6%, transparent)` } : undefined}>
                  <Cell>
                    {ACTIONABLE_STATUSES.has(a.status) ? (
                      <input
                        type="checkbox"
                        checked={selected.has(a.id)}
                        disabled={batchRunning || (!selected.has(a.id) && selected.size >= BATCH_CAP)}
                        onChange={() => toggleRow(a.id)}
                        aria-label={`Seleccionar acción ${a.entityName ?? a.entityRef}`}
                      />
                    ) : null}
                  </Cell>
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
                  <Cell>
                    <Badge tone={STATUS_TONE[a.status] ?? "muted"}>{a.status}{a.approvedBy ? ` · ${a.approvedBy}` : ""}</Badge>
                    {isDrift(a) ? <div style={{ marginTop: 4 }}><Badge tone="danger" dot>con deriva</Badge></div> : null}
                    {batchOutcomes[a.id] ? <div style={{ marginTop: 4 }}>{renderOutcomeChip(a.id, batchOutcomes[a.id])}</div> : null}
                  </Cell>
                  <Cell>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {a.status === "proposed" || a.status === "failed" ? (
                        <>
                          <PrimaryButton disabled={busyId === a.id || batchRunning} onClick={() => call(a.id, "approve")}>Aprobar</PrimaryButton>
                          <GhostDangerButton disabled={busyId === a.id || batchRunning} onClick={() => call(a.id, "reject")}>Rechazar</GhostDangerButton>
                        </>
                      ) : null}
                      {a.status === "approved" ? (
                        <PrimaryButton disabled={busyId === a.id || batchRunning} onClick={() => call(a.id, "execute")}>
                          {busyId === a.id ? "Ejecutando…" : "Ejecutar"}
                        </PrimaryButton>
                      ) : null}
                      {a.status === "executed" || a.status === "verified" ? (
                        <GhostDangerButton disabled={busyId === a.id || batchRunning} onClick={() => call(a.id, "rollback")}>Revertir</GhostDangerButton>
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
