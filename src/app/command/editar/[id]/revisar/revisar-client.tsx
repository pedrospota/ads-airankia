"use client";

// Centro de Mando v2.3 edit mode — Review & apply. Sibling of
// crear/[id]/revisar/revisar-client.tsx, mirrored structurally: same two gate surfaces
// (proactive GatePreview summary + reactive 409 `blocked` panel), same double-submit guard,
// same approve -> execute flow. Differences, all driven by the edit-mode brief:
//
// - Renders EditCompiledAction[] (edit/diff.ts), not CompiledAction[] — grouped by campaign
//   tree node the same way, but an RSA-replace pair (a create_ad immediately followed by the
//   pause(old) diffEditDoc pairs it with) renders as ONE card with old vs new side by side,
//   instead of two separate action cards.
// - No "EN PAUSA" badge: this blueprint edits a LIVE campaign, so an honesty banner replaces
//   it, plus the baseline staleness line (doc.loadedAt vs EDIT_BASELINE_MAX_AGE_MS, computed
//   server-side in page.tsx to avoid a Date.now() hydration mismatch).
// - Execute-stage failure adds a "Revertir lo aplicado" action alongside the existing no-retry
//   dead-end (NextSteps) — but ONLY when the failure response indicates the blueprint actually
//   landed on cc_blueprints.status = 'failed' (execute/route.ts). The one 409 case that does
//   NOT reach 'failed' is the blast-radius pre-check refusal (failedSeq === -1, no `blocked`
//   array on the response) — that reverts the blueprint back to 'approved', so offering
//   rollback there would just 409 again at rollback's own status gate.
import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  SectionLabel,
  Badge,
  DataTable,
  THead,
  Row,
  Cell,
  PrimaryButton,
  SecondaryButton,
  GhostDangerButton,
  ErrorCard,
  UI,
} from "@/components/ui-kit";
import type { EditCompiledAction } from "@/lib/command/edit/diff";
import type { GoogleSearchEditDoc } from "@/lib/command/edit/schema";
import type { GatePreview } from "@/lib/command/blueprint/preview";
import { ProvBadge } from "@/components/command/prov-badge";
import type {
  GateResult,
  BudgetUpdatePayload,
  NegativesPayload,
  CreateKeywordsPayload,
  CreateAdPayload,
  UpdateKeywordStatusPayload,
  UpdateCpcPayload,
  RemoveNegativesPayload,
} from "@/lib/command/types";

type EditAdGroupDoc = GoogleSearchEditDoc["campaign"]["adGroups"][number];
type EditAdDoc = EditAdGroupDoc["ads"][number];

const ACTION_LABEL: Record<string, string> = {
  budget_update: "Actualizar presupuesto",
  pause: "Pausar",
  enable: "Habilitar",
  add_negatives: "Agregar negativas",
  create_keywords: "Añadir palabras clave",
  create_ad: "Crear anuncio (RSA)",
  // v2.7 maintenance verbs (weekly loop: pruning + CPC edits + live-negative removal)
  update_keyword_status: "Pausar/Reactivar palabras clave",
  update_cpc: "Cambiar CPC",
  remove_negatives: "Quitar negativas",
};

const ENTITY_KIND_LABEL: Record<string, string> = {
  campaign: "Campaña",
  ad_group: "Grupo de anuncios",
  ad: "Anuncio",
};

const MATCH_LABEL: Record<string, string> = {
  EXACT: "Exacta",
  PHRASE: "Frase",
  BROAD: "Amplia",
};

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

/* ---------------------------------------------------------------------------
 * Grouping — one "Campaña" node (pause/enable/budget_update/add_negatives at the
 * campaign level), then one node per ad group. Edit-mode actions reference ad
 * groups two different ways: pause/enable carry the ad group's numeric `id` as
 * entityRef; create_keywords/create_ad carry the ad group's resourceName in their
 * payload's `adGroupRef`. Both are resolved against `doc` so both land in the same
 * node regardless of which shape produced them.
 * ------------------------------------------------------------------------- */

interface ActionGroup {
  key: string;
  title: string;
  actions: EditCompiledAction[];
}

function groupByNode(compiled: EditCompiledAction[], doc: GoogleSearchEditDoc): ActionGroup[] {
  const campaignGroup: ActionGroup = { key: "campaign", title: `Campaña — ${doc.campaign.base.name}`, actions: [] };
  const adGroupNodes = new Map<string, ActionGroup>();
  const resourceNameToGroupId = new Map<string, string>();
  const adResourceNameToGroupId = new Map<string, string>();
  const order: string[] = [];

  for (const g of doc.campaign.adGroups) {
    adGroupNodes.set(g.id, { key: g.id, title: `Grupo de anuncios — ${g.base.name}`, actions: [] });
    resourceNameToGroupId.set(g.resourceName, g.id);
    for (const ad of g.ads) adResourceNameToGroupId.set(ad.resourceName, g.id);
    order.push(g.id);
  }

  function targetFor(action: EditCompiledAction): ActionGroup {
    if (action.actionType === "create_keywords" || action.actionType === "create_ad") {
      const ref = (action.payload as CreateKeywordsPayload | CreateAdPayload).adGroupRef;
      const gid = resourceNameToGroupId.get(ref);
      return (gid && adGroupNodes.get(gid)) || campaignGroup;
    }
    if (action.entityKind === "ad_group") return adGroupNodes.get(action.entityRef) ?? campaignGroup;
    if (action.entityKind === "ad") {
      const gid = adResourceNameToGroupId.get(action.entityRef);
      return (gid && adGroupNodes.get(gid)) || campaignGroup;
    }
    return campaignGroup;
  }

  for (const action of compiled) {
    targetFor(action).actions.push(action);
  }

  return [campaignGroup, ...order.map((id) => adGroupNodes.get(id)!)].filter((g) => g.actions.length > 0);
}

/** Within a node's own action list (already in seq order), fold an adjacent
 * create_ad + pause(old ad) — diffEditDoc always pushes an RSA replacement's pair
 * back to back (edit/diff.ts Phase D2) — into a single displayable "pair" row. */
type DisplayRow =
  | { kind: "single"; action: EditCompiledAction }
  | { kind: "pair"; create: EditCompiledAction; pause: EditCompiledAction };

function toDisplayRows(actions: EditCompiledAction[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const next = actions[i + 1];
    if (a.actionType === "create_ad" && next && next.actionType === "pause" && next.entityKind === "ad") {
      rows.push({ kind: "pair", create: a, pause: next });
      i += 1;
      continue;
    }
    rows.push({ kind: "single", action: a });
  }
  return rows;
}

/* ---------------------------------------------------------------------------
 * Payload rendering
 * ------------------------------------------------------------------------- */

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

function KeywordChips({ items, negative }: { items: Array<{ text: string; match: string }>; negative?: boolean }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {items.map((k, i) => (
        <span
          key={`${k.text}-${i}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            borderRadius: 999,
            padding: "3px 9px",
            fontSize: 12,
            fontFamily: UI.fontMono,
            color: negative ? UI.danger : UI.text,
            background: negative
              ? `color-mix(in srgb, ${UI.danger} 8%, transparent)`
              : UI.surface2,
            border: `1px solid ${negative ? `color-mix(in srgb, ${UI.danger} 30%, transparent)` : UI.border}`,
          }}
        >
          {negative ? "−" : ""}
          {k.text}
          <span style={{ opacity: 0.65 }}>· {MATCH_LABEL[k.match] ?? k.match}</span>
        </span>
      ))}
    </div>
  );
}

/** v2.7 — plain text chips for update_keyword_status's payload (resourceName + text
 * only, no match type carried — match isn't needed to identify a pause/reactivate). */
function TextChips({ items }: { items: string[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {items.map((text, i) => (
        <span
          key={`${text}-${i}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            borderRadius: 999,
            padding: "3px 9px",
            fontSize: 12,
            fontFamily: UI.fontMono,
            color: UI.text,
            background: UI.surface2,
            border: `1px solid ${UI.border}`,
          }}
        >
          {text}
        </span>
      ))}
    </div>
  );
}

function AdCreativeView({
  finalUrl,
  headlines,
  descriptions,
  path1,
  path2,
  muted,
}: {
  finalUrl?: string;
  headlines: Array<{ text: string; pinnedField?: string }>;
  descriptions: Array<{ text: string }>;
  path1?: string;
  path2?: string;
  muted?: boolean;
}) {
  return (
    <div style={{ opacity: muted ? 0.6 : 1, display: "flex", flexDirection: "column", gap: 10 }}>
      <FieldGrid>
        {finalUrl ? <Field label="URL final">{finalUrl}</Field> : null}
        {path1 ? <Field label="Ruta 1">{path1}</Field> : null}
        {path2 ? <Field label="Ruta 2">{path2}</Field> : null}
      </FieldGrid>
      <Field label={`Títulos (${headlines.length})`}>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {headlines.map((h, i) => (
            <li key={i}>
              {h.text}
              {h.pinnedField ? <span style={{ color: UI.faint }}> · fijado: {h.pinnedField}</span> : null}
            </li>
          ))}
        </ol>
      </Field>
      <Field label={`Descripciones (${descriptions.length})`}>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {descriptions.map((d, i) => (
            <li key={i}>{d.text}</li>
          ))}
        </ol>
      </Field>
    </div>
  );
}

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
    case "add_negatives": {
      const p = action.payload as NegativesPayload;
      return <KeywordChips items={p.negatives} negative />;
    }
    case "update_keyword_status": {
      const p = action.payload as UpdateKeywordStatusPayload;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Estado nuevo">{p.status === "PAUSED" ? "Pausada" : "Activa"}</Field>
          <Field label={`Palabras clave (${p.keywords.length})`}>
            <TextChips items={p.keywords.map((k) => k.text)} />
          </Field>
        </div>
      );
    }
    case "update_cpc": {
      const p = action.payload as UpdateCpcPayload;
      const before = action.expected?.cpcBidMicros;
      return (
        <FieldGrid>
          <Field label="CPC anterior">{typeof before === "number" ? money(before) : before === null ? "(auto)" : "—"}</Field>
          <Field label="CPC nuevo">{money(p.newCpcBidMicros)}</Field>
        </FieldGrid>
      );
    }
    case "remove_negatives": {
      const p = action.payload as RemoveNegativesPayload;
      const removed = p.removed ?? [];
      return removed.length > 0 ? (
        <KeywordChips items={removed} negative />
      ) : (
        <span style={{ color: UI.faint, fontSize: 12.5 }}>{p.resourceNames.length} negativa(s)</span>
      );
    }
    case "create_keywords": {
      const p = action.payload as CreateKeywordsPayload;
      const positives = p.keywords.filter((k) => !k.negative);
      const negatives = p.keywords.filter((k) => k.negative);
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label={`Palabras clave (${positives.length})`}>
            {positives.length > 0 ? <KeywordChips items={positives} /> : <span style={{ color: UI.faint }}>—</span>}
          </Field>
          {negatives.length > 0 ? (
            <Field label={`Negativas (${negatives.length})`}>
              <KeywordChips items={negatives} negative />
            </Field>
          ) : null}
        </div>
      );
    }
    case "create_ad": {
      const p = action.payload as CreateAdPayload;
      return (
        <AdCreativeView
          finalUrl={p.finalUrl}
          headlines={p.headlines}
          descriptions={p.descriptions}
          path1={p.path1}
          path2={p.path2}
        />
      );
    }
    default:
      return null;
  }
}

function ActionCard({ action, isIa }: { action: EditCompiledAction; isIa: boolean }) {
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
          {isIa ? <ProvBadge kind="ia" /> : null}
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

/** RSA-replace pair: Google won't let an existing ad's creative be edited in place, so
 * diffEditDoc emits a create_ad for the new copy immediately followed by a pause of the old
 * one (edit/diff.ts Phase D2). Rendered as ONE card, old (greyed) vs new side by side, rather
 * than two separate action cards, so the operator reads it as a single logical edit. */
function ReplacePairCard({
  create,
  pause,
  oldAd,
  isIa,
}: {
  create: EditCompiledAction;
  pause: EditCompiledAction;
  oldAd: EditAdDoc | undefined;
  isIa: boolean;
}) {
  const p = create.payload as CreateAdPayload;
  return (
    <div style={{ border: `1px solid ${UI.warn}`, borderRadius: UI.radiusSm, padding: 16, marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <Badge tone="warn">
          #{create.seq + 1}–{pause.seq + 1}
        </Badge>
        <span style={{ fontWeight: 600, fontSize: 13.5, color: UI.text }}>Reemplazo de anuncio (RSA)</span>
        {isIa ? <ProvBadge kind="ia" /> : null}
      </div>
      <p style={{ fontSize: 12.5, color: UI.muted, marginTop: 0, marginBottom: 14 }}>
        Google no permite editar anuncios publicados: se creará uno nuevo y se pausará el anterior.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 }}>
        <div>
          <SectionLabel>Antes — se pausará</SectionLabel>
          {oldAd ? (
            <AdCreativeView
              finalUrl={oldAd.base.finalUrl}
              headlines={oldAd.base.headlines}
              descriptions={oldAd.base.descriptions}
              path1={oldAd.base.path1}
              path2={oldAd.base.path2}
              muted
            />
          ) : (
            <span style={{ color: UI.faint, fontSize: 12.5 }}>Anuncio original no disponible.</span>
          )}
        </div>
        <div>
          <SectionLabel>Después — nuevo</SectionLabel>
          <AdCreativeView finalUrl={p.finalUrl} headlines={p.headlines} descriptions={p.descriptions} path1={p.path1} path2={p.path2} />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Gate rendering — identical shape to crear/[id]/revisar/revisar-client.tsx, so the
 * operator sees the same vocabulary whether a gate was caught before or after clicking
 * Aplicar cambios.
 * ------------------------------------------------------------------------- */

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
        <SecondaryButton href={`/command/editar/${blueprintId}`}>Volver al editor</SecondaryButton>
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

/** Proactive summary (spec §10), identical to the create flow's — the deterministic gates
 * run server-side against the account's real settings/quota BEFORE the operator ever clicks
 * Aplicar cambios. */
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
          La validación en vivo de Google (validateOnly) corre al aplicar — no puede
          ejecutarse antes de tocar la cuenta.
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

/** Honesty banner (spec §f-3): replaces the "EN PAUSA" badge the create flow shows — an edit
 * blueprint targets a campaign that is already live, so there is no paused-on-create safety
 * net. Also carries the baseline staleness line: `baselineAgeMs` is computed server-side in
 * page.tsx (Date.now() at request time), never recomputed client-side, so there is no
 * server/client hydration skew. */
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
 * Root
 * ------------------------------------------------------------------------- */

export default function RevisarClient({
  blueprintId,
  status,
  accountRef,
  doc,
  compiled,
  gatePreview,
  baselineAgeMs,
  baselineStale,
  aiMarkers,
}: {
  blueprintId: string;
  status: string;
  accountRef: string;
  doc: GoogleSearchEditDoc;
  compiled: EditCompiledAction[];
  gatePreview: GatePreview;
  baselineAgeMs: number;
  baselineStale: boolean;
  /** v2.4 Copiloto — deriveAiMarkers(doc, prov) computed server-side (page.tsx); matched
   * against each EditCompiledAction's own `entityRef`, the SAME identity repo.ts's edit
   * branch uses to stamp `cc_actions.source`. Optional so any other caller keeps compiling. */
  aiMarkers?: string[];
}) {
  const router = useRouter();
  const [publishing, setPublishing] = useState(false);
  const [blocked, setBlocked] = useState<GateResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once approve has already succeeded and execute then fails, for ANY reason. All of
  // those leave cc_blueprints.status at 'approved' or 'failed', never back at 'draft' (see
  // execute/route.ts) — a same-screen retry would only 409 again at the approve step. This
  // flag locks that dead end out; approve-STAGE failures (below) never set it, since those
  // legitimately leave status='draft'.
  const [executeFailed, setExecuteFailed] = useState(false);
  // True only for the execute-stage failures that leave cc_blueprints.status = 'failed' (see
  // publish()'s comments) — the one case that does NOT (the blast-radius pre-check refusal)
  // never sets this, since rollback would just 409 at its own status gate.
  const [rollbackOffered, setRollbackOffered] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackDone, setRollbackDone] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const groups = useMemo(() => groupByNode(compiled, doc), [compiled, doc]);
  const aiPaths = useMemo(() => new Set(aiMarkers ?? []), [aiMarkers]);
  const adByResourceName = useMemo(() => {
    const m = new Map<string, EditAdDoc>();
    for (const g of doc.campaign.adGroups) for (const ad of g.ads) m.set(ad.resourceName, ad);
    return m;
  }, [doc]);

  // The blueprint's status the moment this page loaded. If it's already past 'draft' (a
  // reload after publishing, or a stale tab), applying again would just 409 at the approve
  // step — so the button stays disabled and we point the operator at the Bitácora / editor.
  const alreadyMoved = status !== "draft";
  const gatesPass = gatePreview.summary.blockingCount === 0;
  const canPublish = !publishing && !blocked && !executeFailed && !alreadyMoved && gatesPass && !baselineStale;

  async function publish() {
    if (!canPublish) return;
    setPublishing(true);
    setError(null);
    setBlocked(null);
    setExecuteFailed(false);
    setRollbackOffered(false);
    setRollbackDone(false);
    setRollbackError(null);

    // Stage 1 — approve. compileBlueprintToActions/approveBlueprint only run under
    // status==='draft' and never mutate blueprint.status on failure, so a failure here leaves
    // the blueprint exactly where it started: 'draft'. Retrying Aplicar is legitimately safe.
    try {
      const approveRes = await fetch(`/api/command/blueprint/${blueprintId}/approve`, { method: "POST" });
      const approveData = await approveRes.json().catch(() => ({}) as { error?: string });
      if (!approveRes.ok) {
        throw new Error(approveData.error ?? `No se pudo aprobar (HTTP ${approveRes.status}).`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error aprobando los cambios.");
      setPublishing(false);
      return;
    }

    // Stage 2 — execute. Approve already succeeded, so the blueprint has moved past 'draft'.
    try {
      const execRes = await fetch(`/api/command/blueprint/${blueprintId}/execute`, { method: "POST" });
      const execData = await execRes
        .json()
        .catch(() => ({}) as { error?: string; blocked?: GateResult[]; ok?: boolean });

      // 409 with a `blocked` gate array: a downstream gate stopped an action mid-plan.
      // execute/route.ts stamps the blueprint 'failed' in this case — rollback is offered.
      if (execRes.status === 409 && Array.isArray(execData.blocked)) {
        setBlocked(execData.blocked);
        setExecuteFailed(true);
        setRollbackOffered(true);
        setPublishing(false);
        return;
      }

      // 409 WITHOUT a `blocked` array is the blast-radius pre-check refusal (failedSeq === -1
      // in execute/route.ts) — nothing executed, and the blueprint is reverted back to
      // 'approved', never 'failed'. Rollback would just 409 again at its own status gate, so
      // it is not offered here.
      if (execRes.status === 409) {
        setError(execData.error ?? `No se pudo ejecutar (HTTP ${execRes.status}).`);
        setExecuteFailed(true);
        setPublishing(false);
        return;
      }

      if (!execRes.ok || execData.ok === false) {
        // Any other failure (502 downstream mutation failure, 500 unexpected exception) also
        // leaves the blueprint 'failed' (execute/route.ts stamps it before responding) —
        // rollback is offered.
        setError(execData.error ?? `No se pudo ejecutar (HTTP ${execRes.status}).`);
        setExecuteFailed(true);
        setRollbackOffered(true);
        setPublishing(false);
        return;
      }

      // Full success: redirect to the Bitácora. `publishing` stays true so the button stays
      // disabled/labeled through the navigation — no window for a second click.
      router.replace("/command/bitacora");
    } catch (e) {
      // A network-level failure never reached the server, so it is unknown whether the
      // blueprint moved to 'failed' — don't offer a rollback that might just 409.
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
        <SecondaryButton href={`/command/editar/${blueprintId}`}>Volver al editor</SecondaryButton>
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
                <SecondaryButton href={`/command/editar/${blueprintId}`}>Recargar</SecondaryButton>
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

      {groups.map((g) => {
        const iaCount = g.actions.filter((a) => aiPaths.has(a.entityRef)).length;
        return (
          <Card key={g.key} style={{ marginBottom: 16 }}>
            <SectionLabel style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {g.title}
              {iaCount > 0 ? (
                <span style={{ color: UI.accent, fontWeight: 500, textTransform: "none", letterSpacing: "normal" }}>
                  ✦ {iaCount} campo{iaCount === 1 ? "" : "s"} de IA
                </span>
              ) : null}
            </SectionLabel>
            {toDisplayRows(g.actions).map((row) =>
              row.kind === "pair" ? (
                <ReplacePairCard
                  key={`pair-${row.create.seq}`}
                  create={row.create}
                  pause={row.pause}
                  oldAd={adByResourceName.get(row.pause.entityRef)}
                  isIa={aiPaths.has(row.create.entityRef) || aiPaths.has(row.pause.entityRef)}
                />
              ) : (
                <ActionCard key={row.action.seq} action={row.action} isIa={aiPaths.has(row.action.entityRef)} />
              )
            )}
          </Card>
        );
      })}
    </>
  );
}
