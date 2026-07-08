"use client";

// Centro de Mando meta-edit — Review & apply. Sibling of
// editar/[id]/revisar/revisar-client.tsx, mirrored structurally: same two gate
// surfaces (proactive GatePreview + reactive 409 `blocked` panel), same
// double-submit guard, same approve → execute → rollback state machine over
// the network-agnostic blueprint endpoints. Differences: renders only the 3
// slice-1 verbs, groups by campaign/adset nodes, and carries NO provenance
// (the meta editor never mounts CopilotoDock).
import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Card, SectionLabel, Badge, DataTable, THead, Row, Cell,
  PrimaryButton, SecondaryButton, GhostDangerButton, ErrorCard, UI,
} from "@/components/ui-kit";
import type { EditCompiledAction } from "@/lib/command/edit/diff";
import type { MetaEditDoc } from "@/lib/command/edit/meta-schema";
import type { GatePreview } from "@/lib/command/blueprint/preview";
import type { GateResult, BudgetUpdatePayload } from "@/lib/command/types";

/* ---------------------------------------------------------------------------
 * Presentational helpers — copied verbatim from revisar-client.tsx (same
 * names, same bodies, zero google coupling): money, FieldGrid/Field,
 * GateTable, HonestyBanner, STATUS_TONE.
 * ------------------------------------------------------------------------- */

const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "muted"> = {
  draft: "muted",
  approved: "warn",
  executing: "warn",
  executed: "ok",
  failed: "danger",
};

function money(micros: number): string {
  return `$${(micros / 1_000_000).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function FieldGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "10px 20px" }}>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: UI.muted,
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13.5, color: UI.text, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

function GateTable({ rows }: { rows: GateResult[] }) {
  return (
    <DataTable>
      <THead cols={[{ label: "Compuerta" }, { label: "Severidad" }, { label: "Estado" }, { label: "Evidencia" }]} />
      <tbody>
        {rows.map((g) => (
          <Row key={g.id}>
            <Cell mono>{g.id}</Cell>
            <Cell>{g.severity}</Cell>
            <Cell>
              <Badge tone={g.status === "pass" ? "ok" : g.severity === "blocking" ? "danger" : "warn"}>
                {g.status}
              </Badge>
            </Cell>
            <Cell>{g.evidence}</Cell>
          </Row>
        ))}
      </tbody>
    </DataTable>
  );
}

/** The no-retry next step, shown once approve has already succeeded and execute has failed —
 * a same-screen retry would only 409 again at the approve step (the blueprint is no longer
 * 'draft'). Adds a "Revertir lo aplicado" action when the failure response indicates the
 * blueprint actually reached cc_blueprints.status = 'failed' (see the publish() comment). */
function NextSteps({
  blueprintId,
  canRollback,
  rollbackBusy,
  rollbackDone,
  rollbackError,
  onRollback,
}: {
  blueprintId: string;
  canRollback: boolean;
  rollbackBusy: boolean;
  rollbackDone: boolean;
  rollbackError: string | null;
  onRollback: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <SecondaryButton href={`/command/editar-meta/${blueprintId}`}>Volver al editor</SecondaryButton>
        <SecondaryButton href="/command/bitacora">Ver Bitácora</SecondaryButton>
        {rollbackDone ? (
          <Badge tone="ok">Revertido</Badge>
        ) : canRollback ? (
          <GhostDangerButton disabled={rollbackBusy} onClick={onRollback}>
            {rollbackBusy ? "Revirtiendo…" : "Revertir lo aplicado"}
          </GhostDangerButton>
        ) : null}
      </div>
      {rollbackError ? <ErrorCard message={rollbackError} /> : null}
    </div>
  );
}

/** Honesty banner (spec §f-3): an edit blueprint targets a campaign that is already live, so
 * there is no paused-on-create safety net. Also carries the baseline staleness line:
 * `baselineAgeMs` is computed server-side in page.tsx (Date.now() at request time), never
 * recomputed client-side, so there is no server/client hydration skew. */
function HonestyBanner({ baselineAgeMs, baselineStale }: { baselineAgeMs: number; baselineStale: boolean }) {
  const minutes = Math.max(0, Math.round(baselineAgeMs / 60_000));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          fontSize: 12.5,
          color: UI.text,
          border: `1px dashed ${UI.danger}`,
          borderRadius: UI.radiusSm,
          padding: "9px 12px",
          background: `color-mix(in srgb, ${UI.danger} 8%, transparent)`,
        }}
      >
        <span style={{ color: UI.danger, fontWeight: 700, fontSize: 11, letterSpacing: "0.06em", flexShrink: 0 }}>
          EN VIVO
        </span>
        <span>Estos cambios se aplican a una campaña EN VIVO al publicar.</span>
      </div>
      <span style={{ fontSize: 11.5, color: baselineStale ? UI.danger : UI.faint }}>
        Baseline cargado hace {minutes} min
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Meta-specific constants
 * ------------------------------------------------------------------------- */

const ACTION_LABEL: Record<string, string> = {
  budget_update: "Actualizar presupuesto",
  pause: "Pausar",
  enable: "Habilitar",
};

const ENTITY_KIND_LABEL: Record<string, string> = {
  campaign: "Campaña",
  adset: "Conjunto de anuncios",
  ad: "Anuncio",
};

/* ---------------------------------------------------------------------------
 * Grouping — one campaign node + one node per adset; ad actions resolve to
 * their parent adset via the doc.
 * ------------------------------------------------------------------------- */

interface ActionGroup {
  key: string;
  title: string;
  actions: EditCompiledAction[];
}

function groupByNode(compiled: EditCompiledAction[], doc: MetaEditDoc): ActionGroup[] {
  const campaignGroup: ActionGroup = { key: "campaign", title: `Campaña — ${doc.campaign.base.name}`, actions: [] };
  const adsetNodes = new Map<string, ActionGroup>();
  const adIdToAdsetId = new Map<string, string>();
  const order: string[] = [];

  for (const as of doc.campaign.adsets) {
    adsetNodes.set(as.id, { key: as.id, title: `Conjunto de anuncios — ${as.base.name}`, actions: [] });
    for (const ad of as.ads) adIdToAdsetId.set(ad.id, as.id);
    order.push(as.id);
  }

  for (const action of compiled) {
    if (action.entityKind === "adset") {
      (adsetNodes.get(action.entityRef) ?? campaignGroup).actions.push(action);
    } else if (action.entityKind === "ad") {
      const parent = adIdToAdsetId.get(action.entityRef);
      ((parent && adsetNodes.get(parent)) || campaignGroup).actions.push(action);
    } else {
      campaignGroup.actions.push(action);
    }
  }

  return [campaignGroup, ...order.map((id) => adsetNodes.get(id)!)].filter((g) => g.actions.length > 0);
}

/* ---------------------------------------------------------------------------
 * Payload rendering — only the 3 slice-1 verbs.
 * ------------------------------------------------------------------------- */

function PayloadView({ action }: { action: EditCompiledAction }) {
  switch (action.actionType) {
    case "budget_update": {
      const p = action.payload as BudgetUpdatePayload;
      const before = action.expected?.dailyBudgetMicros;
      return (
        <FieldGrid>
          <Field label="Presupuesto anterior">{typeof before === "number" ? money(before) : "—"}</Field>
          <Field label="Presupuesto nuevo">{money(p.newDailyBudgetMicros)}</Field>
        </FieldGrid>
      );
    }
    case "pause":
    case "enable":
      return (
        <FieldGrid>
          <Field label="Entidad">{action.entityName ?? action.entityRef}</Field>
          <Field label="Tipo">{ENTITY_KIND_LABEL[action.entityKind] ?? action.entityKind}</Field>
        </FieldGrid>
      );
    default:
      return null;
  }
}

function ActionCard({ action }: { action: EditCompiledAction }) {
  return (
    <div style={{ border: `1px solid ${UI.border}`, borderRadius: UI.radiusSm, padding: 16, marginTop: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Badge tone="muted">#{action.seq + 1}</Badge>
          <span style={{ fontWeight: 600, fontSize: 13.5, color: UI.text }}>
            {ACTION_LABEL[action.actionType] ?? action.actionType}
          </span>
        </div>
        <span style={{ fontSize: 11.5, color: UI.faint, fontFamily: UI.fontMono }}>
          {action.entityKind} · {action.localRef ?? action.entityRef}
        </span>
      </div>
      <p style={{ fontSize: 13, color: UI.muted, margin: "0 0 12px" }}>{action.note}</p>
      <PayloadView action={action} />
    </div>
  );
}

/** Proactive summary (spec §10), identical shape to the google edit flow's — the deterministic
 * gates run server-side against the account's real settings/quota BEFORE the operator ever
 * clicks Aplicar cambios. Footnote swapped for the meta truth: Meta v1 verbs have no rehearsal
 * (gates.ts passes VALIDATE_ONLY "No aplica"). */
function GatesSummaryCard({ preview }: { preview: GatePreview }) {
  const ok = preview.summary.blockingCount === 0;
  const passing = preview.summary.gatesRun - preview.summary.blockingCount;
  const blockedActions = preview.perAction.filter((a) => a.blocking.length > 0);

  return (
    <Card style={{ marginBottom: 16, ...(ok ? {} : { borderColor: UI.danger }) }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <SectionLabel>Compuertas de seguridad</SectionLabel>
          <Badge tone={ok ? "ok" : "danger"} dot>
            {passing}/{preview.summary.gatesRun} {ok ? "✓" : ""}
          </Badge>
        </div>
        <span style={{ fontSize: 12, color: UI.muted, maxWidth: 420 }}>
          Meta no ofrece ensayo (validate_only) para estos verbos de edición —
          las compuertas deterministas de arriba son la verificación previa completa.
        </span>
      </div>
      {!ok ? (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 13, color: UI.muted, margin: 0 }}>
            {preview.summary.blockingCount} compuerta(s) bloqueante(s) detectadas antes de aplicar.
            Aplicar cambios quedará deshabilitado hasta que ajustes la campaña en el editor.
          </p>
          {blockedActions.map((a) => (
            <div key={a.seq}>
              <div style={{ fontSize: 11.5, color: UI.faint, fontFamily: UI.fontMono, marginBottom: 6 }}>
                #{a.seq + 1} · {ACTION_LABEL[a.actionType] ?? a.actionType}
              </div>
              <GateTable rows={a.blocking} />
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * Root
 * ------------------------------------------------------------------------- */

export default function MetaRevisarClient({
  blueprintId, status, accountRef, doc, compiled, gatePreview, baselineAgeMs, baselineStale,
}: {
  blueprintId: string;
  status: string;
  accountRef: string;
  doc: MetaEditDoc;
  compiled: EditCompiledAction[];
  gatePreview: GatePreview;
  baselineAgeMs: number;
  baselineStale: boolean;
}) {
  const router = useRouter();
  const [publishing, setPublishing] = useState(false);
  const [blocked, setBlocked] = useState<GateResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executeFailed, setExecuteFailed] = useState(false);
  const [rollbackOffered, setRollbackOffered] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackDone, setRollbackDone] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const groups = useMemo(() => groupByNode(compiled, doc), [compiled, doc]);
  const alreadyMoved = status !== "draft";
  const gatesPass = gatePreview.summary.blockingCount === 0;
  const canPublish = !publishing && !blocked && !executeFailed && !alreadyMoved && gatesPass && !baselineStale;

  async function publish() {
    if (!canPublish) return;
    setPublishing(true);
    setError(null); setBlocked(null); setExecuteFailed(false);
    setRollbackOffered(false); setRollbackDone(false); setRollbackError(null);

    // Stage 1 — approve (leaves 'draft' untouched on failure; retry is safe).
    try {
      const approveRes = await fetch(`/api/command/blueprint/${blueprintId}/approve`, { method: "POST" });
      const approveData = await approveRes.json().catch(() => ({}) as { error?: string });
      if (!approveRes.ok) throw new Error(approveData.error ?? `No se pudo aprobar (HTTP ${approveRes.status}).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error aprobando los cambios.");
      setPublishing(false);
      return;
    }

    // Stage 2 — execute. Same 3-way failure contract as the google revisar
    // client (409+blocked → 'failed', rollback offered; bare 409 = blast-radius
    // pre-check, reverted to 'approved', NO rollback; other non-ok → 'failed',
    // rollback offered; network throw → unknown, NO rollback).
    try {
      const execRes = await fetch(`/api/command/blueprint/${blueprintId}/execute`, { method: "POST" });
      const execData = await execRes.json().catch(() => ({}) as { error?: string; blocked?: GateResult[]; ok?: boolean });

      if (execRes.status === 409 && Array.isArray(execData.blocked)) {
        setBlocked(execData.blocked);
        setExecuteFailed(true);
        setRollbackOffered(true);
        setPublishing(false);
        return;
      }
      if (execRes.status === 409) {
        setError(execData.error ?? `No se pudo ejecutar (HTTP ${execRes.status}).`);
        setExecuteFailed(true);
        setPublishing(false);
        return;
      }
      if (!execRes.ok || execData.ok === false) {
        setError(execData.error ?? `No se pudo ejecutar (HTTP ${execRes.status}).`);
        setExecuteFailed(true);
        setRollbackOffered(true);
        setPublishing(false);
        return;
      }
      router.replace("/command/bitacora"); // publishing stays true — no second-click window
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error aplicando los cambios.");
      setExecuteFailed(true);
      setPublishing(false);
    }
  }

  async function rollback() {
    setRollbackBusy(true);
    setRollbackError(null);
    try {
      const res = await fetch(`/api/command/blueprint/${blueprintId}/rollback`, { method: "POST" });
      const data = await res.json().catch(() => ({}) as { error?: string });
      if (!res.ok) throw new Error(data.error ?? `No se pudo revertir (HTTP ${res.status}).`);
      setRollbackDone(true);
      setRollbackOffered(false);
    } catch (e) {
      setRollbackError(e instanceof Error ? e.message : "Error revirtiendo los cambios.");
    } finally {
      setRollbackBusy(false);
    }
  }

  return (
    <>
      <GatesSummaryCard preview={gatePreview} />

      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
            <Field label="Cuenta">{accountRef}</Field>
            <Field label="Campaña">{doc.campaign.base.name}</Field>
            <Field label="Estado del blueprint">
              <Badge tone={STATUS_TONE[status] ?? "muted"}>{status}</Badge>
            </Field>
            <Field label="Acciones compiladas">{compiled.length}</Field>
          </div>
          <HonestyBanner baselineAgeMs={baselineAgeMs} baselineStale={baselineStale} />
        </div>
      </Card>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        <SecondaryButton href={`/command/editar-meta/${blueprintId}`}>Volver al editor</SecondaryButton>
        <PrimaryButton disabled={!canPublish} onClick={() => void publish()}>
          {publishing ? "Aplicando…" : "Aplicar cambios"}
        </PrimaryButton>
      </div>

      {baselineStale ? (
        <ErrorCard
          style={{ marginBottom: 16 }}
          message={
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <span>
                El baseline de esta revisión tiene más de 60 minutos — la campaña en vivo pudo haber cambiado desde
                entonces. Recarga los datos en el editor antes de aplicar.
              </span>
              <div>
                <SecondaryButton href={`/command/editar-meta/${blueprintId}`}>Recargar</SecondaryButton>
              </div>
            </div>
          }
        />
      ) : null}

      {alreadyMoved ? (
        <ErrorCard
          style={{ marginBottom: 16 }}
          message={
            status === "executed"
              ? "Este blueprint ya fue aplicado. Revisa el resultado en la Bitácora."
              : `Este blueprint ya salió de borrador (estado actual: ${status}) — no se puede volver a aplicar desde aquí. Vuelve al editor si necesitas ajustar algo.`
          }
        />
      ) : null}

      {error ? (
        <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <ErrorCard message={error} />
          {executeFailed ? (
            <NextSteps
              blueprintId={blueprintId}
              canRollback={rollbackOffered}
              rollbackBusy={rollbackBusy}
              rollbackDone={rollbackDone}
              rollbackError={rollbackError}
              onRollback={() => void rollback()}
            />
          ) : null}
        </div>
      ) : null}

      {blocked ? (
        <Card style={{ marginBottom: 16, borderColor: UI.danger }}>
          <SectionLabel>Compuertas — aplicación bloqueada</SectionLabel>
          <p style={{ fontSize: 13, color: UI.muted, marginTop: -4, marginBottom: 12 }}>
            El motor bloqueó una acción antes de tocar la cuenta. No se reintenta automáticamente — vuelve al
            editor para ajustar la campaña.
          </p>
          <GateTable rows={blocked} />
          <div style={{ marginTop: 12 }}>
            <NextSteps
              blueprintId={blueprintId}
              canRollback={rollbackOffered}
              rollbackBusy={rollbackBusy}
              rollbackDone={rollbackDone}
              rollbackError={rollbackError}
              onRollback={() => void rollback()}
            />
          </div>
        </Card>
      ) : null}

      {groups.map((g) => (
        <Card key={g.key} style={{ marginBottom: 16 }}>
          <SectionLabel>{g.title}</SectionLabel>
          {g.actions.map((action) => (
            <ActionCard key={action.seq} action={action} />
          ))}
        </Card>
      ))}
    </>
  );
}
