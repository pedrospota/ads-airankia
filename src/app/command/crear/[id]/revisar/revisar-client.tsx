"use client";

// Centro de Mando v2 — Review & publish. Renders EVERY compiled action's full
// payload, grouped by campaign-tree node (campaign+budget, then one group per
// ad group with its keywords/negatives and each ad), so the operator sees
// exactly what will be sent to Google before anything touches the account.
//
// Two gate surfaces, both spec §10:
// - PROACTIVE: a `GatePreview` computed server-side (blueprint/preview.ts) from the SAME
//   deterministic gates the executor runs at publish time, rendered as a summary strip near
//   the top ("Compuertas de seguridad: N/N") BEFORE the operator ever clicks Publish. Google's
//   validateOnly rehearsal can't run pre-creation, so it's called out separately as deferred.
// - REACTIVE: "Publicar en pausa" runs approve → execute; a 409 with `blocked` renders the
//   same gate-panel pattern as acciones-client.tsx. Neither this nor any other execute-stage
//   failure (blocked or not) auto-retries — see `executeFailed` below.

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
  ErrorCard,
  UI,
} from "@/components/ui-kit";
import { PausedBadge } from "../../builder-preview";
import type { CompiledAction } from "@/lib/command/blueprint/compile";
import type { GatePreview } from "@/lib/command/blueprint/preview";
import type {
  GateResult,
  CreateBudgetPayload,
  CreateCampaignPayload,
  CreateAdGroupPayload,
  CreateKeywordsPayload,
  CreateAdPayload,
  MetaCreateCampaignPayload,
  MetaCreateAdsetPayload,
  MetaCreateAdPayload,
} from "@/lib/command/types";

const ACTION_LABEL: Record<string, string> = {
  create_budget: "Crear presupuesto",
  create_campaign: "Crear campaña",
  create_ad_group: "Crear grupo de anuncios",
  create_keywords: "Añadir palabras clave",
  create_ad: "Crear anuncio (RSA)",
  create_adset: "Crear conjunto de anuncios",
};

const CTA_LABEL: Record<string, string> = {
  LEARN_MORE: "Más información",
  CONTACT_US: "Contáctanos",
  SHOP_NOW: "Comprar ahora",
  SIGN_UP: "Regístrate",
  GET_QUOTE: "Solicitar cotización",
};

const BIDDING_LABEL: Record<string, string> = {
  MAXIMIZE_CONVERSIONS: "Maximizar conversiones",
  TARGET_CPA: "CPA objetivo",
  TARGET_ROAS: "ROAS objetivo",
};

const MATCH_LABEL: Record<string, string> = {
  EXACT: "Exacta",
  PHRASE: "Frase",
  BROAD: "Amplia",
};

const NET_LABEL: Record<string, string> = { google_ads: "Google Ads", meta_ads: "Meta Ads" };

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
 * Grouping — one "Campaña" node (create_budget + create_campaign), then one
 * node per ad group (create_ad_group + create_keywords + each create_ad it
 * contains), matched by entityRef/adGroupRef rather than array position so it
 * holds regardless of how many ad groups the blueprint compiles to.
 * ------------------------------------------------------------------------- */

interface ActionGroup {
  key: string;
  title: string;
  actions: CompiledAction[];
}

function groupByNode(compiled: CompiledAction[]): ActionGroup[] {
  const campaignGroup: ActionGroup = { key: "campaign", title: "Campaña", actions: [] };
  const adGroups: ActionGroup[] = [];
  const adGroupByRef = new Map<string, ActionGroup>();

  for (const action of compiled) {
    if (action.actionType === "create_budget") {
      campaignGroup.actions.push(action);
      continue;
    }
    if (action.actionType === "create_campaign") {
      campaignGroup.title = `Campaña — ${(action.payload as CreateCampaignPayload).name}`;
      campaignGroup.actions.push(action);
      continue;
    }
    if (action.actionType === "create_ad_group") {
      const group: ActionGroup = {
        key: action.entityRef,
        title: `Grupo de anuncios — ${(action.payload as CreateAdGroupPayload).name}`,
        actions: [action],
      };
      adGroupByRef.set(action.entityRef, group);
      adGroups.push(group);
      continue;
    }
    // Meta: create_adset is the adset-level sibling of create_ad_group above — same
    // grouping role (one node per "Conjunto"), reusing adGroupByRef/adGroups so a
    // create_ad below resolves into it exactly like a Google ad resolves into its ad group.
    if (action.actionType === "create_adset") {
      const group: ActionGroup = {
        key: action.entityRef,
        title: `Conjunto de anuncios — ${(action.payload as MetaCreateAdsetPayload).name}`,
        actions: [action],
      };
      adGroupByRef.set(action.entityRef, group);
      adGroups.push(group);
      continue;
    }
    if (action.actionType === "create_keywords") {
      const ref = (action.payload as CreateKeywordsPayload).adGroupRef;
      (adGroupByRef.get(ref) ?? campaignGroup).actions.push(action);
      continue;
    }
    if (action.actionType === "create_ad") {
      // Google ads carry adGroupRef (CreateAdPayload); Meta ads carry adsetRef
      // (MetaCreateAdPayload) — discriminate on the field's presence, mirroring PayloadView.
      const ref = "adsetRef" in action.payload
        ? (action.payload as MetaCreateAdPayload).adsetRef
        : (action.payload as CreateAdPayload).adGroupRef;
      (adGroupByRef.get(ref) ?? campaignGroup).actions.push(action);
      continue;
    }
  }
  return [campaignGroup, ...adGroups];
}

/* ---------------------------------------------------------------------------
 * Payload rendering — readable fields per actionType, not a raw JSON dump.
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

function PayloadView({ action }: { action: CompiledAction }) {
  switch (action.actionType) {
    case "create_budget": {
      const p = action.payload as CreateBudgetPayload;
      return (
        <FieldGrid>
          <Field label="Nombre">{p.name}</Field>
          <Field label="Monto diario">{money(p.amountMicros)}</Field>
        </FieldGrid>
      );
    }
    case "create_campaign": {
      // Meta (MetaCreateCampaignPayload) and Google (CreateCampaignPayload) both compile to
      // actionType "create_campaign" but carry disjoint payload shapes — "objective" only
      // exists on the Meta variant, so it's a safe discriminator (mirrors groupByNode's
      // "adsetRef" check below).
      if ("objective" in action.payload) {
        const p = action.payload as MetaCreateCampaignPayload;
        return (
          <FieldGrid>
            <Field label="Nombre">{p.name}</Field>
            <Field label="Objetivo">{p.objective}</Field>
            <Field label="Estado inicial">
              <Badge tone="warn" dot>
                EN PAUSA
              </Badge>
            </Field>
            <Field label="Categorías especiales">
              {p.specialAdCategories.length > 0 ? p.specialAdCategories.join(", ") : "Ninguna"}
            </Field>
          </FieldGrid>
        );
      }
      const p = action.payload as CreateCampaignPayload;
      return (
        <FieldGrid>
          <Field label="Nombre">{p.name}</Field>
          <Field label="Canal">{p.channel === "SEARCH" ? "Búsqueda" : p.channel}</Field>
          <Field label="Estado inicial">
            <Badge tone="warn" dot>
              EN PAUSA
            </Badge>
          </Field>
          <Field label="Presupuesto">{p.budgetRef}</Field>
          <Field label="Estrategia de puja">
            {BIDDING_LABEL[p.bidding.strategy] ?? p.bidding.strategy}
            {p.bidding.strategy === "TARGET_CPA" && typeof p.bidding.targetCpaMicros === "number"
              ? ` · objetivo ${money(p.bidding.targetCpaMicros)}`
              : null}
            {p.bidding.strategy === "TARGET_ROAS" && typeof p.bidding.targetRoas === "number"
              ? ` · objetivo ${p.bidding.targetRoas}x`
              : null}
          </Field>
          <Field label="Ubicaciones">
            {p.geoTargetIds.join(", ")}
            {p.presenceOnly ? " (solo presencia física)" : ""}
          </Field>
          {p.languageId ? <Field label="Idioma (ID de constante)">{p.languageId}</Field> : null}
        </FieldGrid>
      );
    }
    case "create_adset": {
      const p = action.payload as MetaCreateAdsetPayload;
      return (
        <FieldGrid>
          <Field label="Nombre">{p.name}</Field>
          <Field label="Campaña">{p.campaignRef}</Field>
          <Field label="Estado inicial">
            <Badge tone="warn" dot>
              EN PAUSA
            </Badge>
          </Field>
          <Field label="Presupuesto diario">{money(p.dailyBudgetMicros)}</Field>
          <Field label="Países">{p.targeting.countryCodes.join(", ")}</Field>
          <Field label="Edades">
            {p.targeting.ageMin}–{p.targeting.ageMax}
          </Field>
          <Field label="Optimización">
            {p.optimizationGoal} · {p.billingEvent}
          </Field>
          <Field label="Estrategia de puja">{p.bidStrategy}</Field>
        </FieldGrid>
      );
    }
    case "create_ad_group": {
      const p = action.payload as CreateAdGroupPayload;
      return (
        <FieldGrid>
          <Field label="Nombre">{p.name}</Field>
          <Field label="Campaña">{p.campaignRef}</Field>
          {typeof p.cpcBidMicros === "number" ? <Field label="Puja CPC">{money(p.cpcBidMicros)}</Field> : null}
        </FieldGrid>
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
      // Same disjoint-payload situation as create_campaign above: Meta ads carry a
      // "creative" sub-object (MetaCreateAdPayload) that Google's CreateAdPayload never has.
      if ("creative" in action.payload) {
        const p = action.payload as MetaCreateAdPayload;
        const { link, message, headline, description, callToActionType, imageUrl } = p.creative;
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FieldGrid>
              <Field label="Conjunto de anuncios">{p.adsetRef}</Field>
              <Field label="Enlace">{link}</Field>
              {headline ? <Field label="Título">{headline}</Field> : null}
              {callToActionType ? (
                <Field label="Llamado a la acción">{CTA_LABEL[callToActionType] ?? callToActionType}</Field>
              ) : null}
            </FieldGrid>
            <Field label="Mensaje">{message}</Field>
            {description ? <Field label="Descripción">{description}</Field> : null}
            {imageUrl ? <Field label="Imagen">{imageUrl}</Field> : null}
          </div>
        );
      }
      const p = action.payload as CreateAdPayload;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FieldGrid>
            <Field label="Grupo de anuncios">{p.adGroupRef}</Field>
            <Field label="URL final">{p.finalUrl}</Field>
            {p.path1 ? <Field label="Ruta 1">{p.path1}</Field> : null}
            {p.path2 ? <Field label="Ruta 2">{p.path2}</Field> : null}
          </FieldGrid>
          <Field label={`Títulos (${p.headlines.length})`}>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {p.headlines.map((h, i) => (
                <li key={i}>
                  {h.text}
                  {h.pinnedField ? <span style={{ color: UI.faint }}> · fijado: {h.pinnedField}</span> : null}
                </li>
              ))}
            </ol>
          </Field>
          <Field label={`Descripciones (${p.descriptions.length})`}>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {p.descriptions.map((d, i) => (
                <li key={i}>{d.text}</li>
              ))}
            </ol>
          </Field>
        </div>
      );
    }
    default:
      return null;
  }
}

function ActionCard({ action }: { action: CompiledAction }) {
  return (
    <div
      style={{
        border: `1px solid ${UI.border}`,
        borderRadius: UI.radiusSm,
        padding: 16,
        marginTop: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
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
          {action.entityKind} · {action.localRef}
        </span>
      </div>
      <PayloadView action={action} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Gate rendering — ONE table shape shared by the proactive summary (below) and
 * the reactive 409 `blocked` panel, so the operator sees the same vocabulary
 * whether a gate was caught before or after clicking Publish.
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

/** The "no-retry" next step, shown once approve has already succeeded and execute has
 * failed — a same-screen Publish retry would only 409 again at the approve step (the
 * blueprint is no longer 'draft'), so point the operator at the two places that ARE
 * actionable: fix the blueprint in the builder, or check what (if anything) already landed. */
function NextSteps() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <SecondaryButton href="/command/crear">Volver al constructor</SecondaryButton>
      <SecondaryButton href="/command/bitacora">Ver Bitácora</SecondaryButton>
    </div>
  );
}

/** Proactive summary (spec §10): the deterministic gates, run server-side against the SAME
 * real settings/quota the executor uses, BEFORE the operator ever clicks Publish. Google's
 * validateOnly rehearsal can't run pre-creation (no live resourceName yet) — called out
 * separately as deferred-to-publish rather than folded into the pass/fail count. */
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
          La validación en vivo de Google (validateOnly) corre al publicar — no puede
          ejecutarse antes de crear los recursos.
        </span>
      </div>
      {!ok ? (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 13, color: UI.muted, margin: 0 }}>
            {preview.summary.blockingCount} compuerta(s) bloqueante(s) detectadas antes de publicar.
            Publicar quedará deshabilitado hasta que ajustes la campaña en el constructor.
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

export default function RevisarClient({
  blueprintId,
  status,
  network,
  accountRef,
  compiled,
  gatePreview,
}: {
  blueprintId: string;
  status: string;
  network: string;
  accountRef: string;
  compiled: CompiledAction[];
  gatePreview: GatePreview;
}) {
  const router = useRouter();
  const [publishing, setPublishing] = useState(false);
  const [blocked, setBlocked] = useState<GateResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once approve has already succeeded and execute then fails — for ANY reason (gate
  // block, quota refusal, 502/500 mutation failure). All of those leave cc_blueprints.status
  // at 'approved' or 'failed', never back at 'draft' (see execute/route.ts), so a same-screen
  // Publish retry would only 409 again at the approve step. This flag locks that dead end out;
  // approve-STAGE failures (below) never set it, since those legitimately leave status='draft'.
  const [executeFailed, setExecuteFailed] = useState(false);

  const groups = useMemo(() => groupByNode(compiled), [compiled]);
  // The blueprint's status the moment this page loaded. If it's already past
  // 'draft' (a reload after publishing, or a stale tab), publishing again would
  // just 409 at the approve step — so the button stays disabled and we point
  // the operator at the Bitácora / builder instead of letting them retry here.
  const alreadyMoved = status !== "draft";
  const gatesPass = gatePreview.summary.blockingCount === 0;
  const canPublish = !publishing && !blocked && !executeFailed && !alreadyMoved && gatesPass;

  async function publish() {
    if (!canPublish) return;
    setPublishing(true);
    setError(null);
    setBlocked(null);
    setExecuteFailed(false);

    // Stage 1 — approve. compileBlueprintToActions/approveBlueprint only run under
    // status==='draft' and never mutate blueprint.status on failure (approve/route.ts's
    // catch just returns 500 — no setBlueprintStatus call), so a failure here leaves the
    // blueprint exactly where it started: 'draft'. Retrying Publish is legitimately safe.
    try {
      const approveRes = await fetch(`/api/command/blueprint/${blueprintId}/approve`, { method: "POST" });
      const approveData = await approveRes.json().catch(() => ({}) as { error?: string });
      if (!approveRes.ok) {
        throw new Error(approveData.error ?? `No se pudo aprobar (HTTP ${approveRes.status}).`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error aprobando la campaña.");
      setPublishing(false);
      return;
    }

    // Stage 2 — execute. Approve already succeeded, so the blueprint has moved past
    // 'draft'. Any failure from here (gate-blocked 409, quota-refusal 409, or a 502/500
    // mutation failure) leaves the blueprint 'approved' or 'failed' — never 'draft' — so a
    // same-screen retry would only 409 again at the approve step. No retry is offered;
    // `executeFailed` locks the button and NextSteps points at the builder or the Bitácora.
    try {
      const execRes = await fetch(`/api/command/blueprint/${blueprintId}/execute`, { method: "POST" });
      const execData = await execRes
        .json()
        .catch(() => ({}) as { error?: string; blocked?: GateResult[]; ok?: boolean });

      if (execRes.status === 409 && Array.isArray(execData.blocked)) {
        setBlocked(execData.blocked);
        setExecuteFailed(true);
        setPublishing(false);
        return;
      }
      if (!execRes.ok || execData.ok === false) {
        setError(execData.error ?? `No se pudo ejecutar (HTTP ${execRes.status}).`);
        setExecuteFailed(true);
        setPublishing(false);
        return;
      }

      // Full success: redirect to the Bitácora. `publishing` stays true so the
      // button stays disabled/labeled through the navigation — no window for a
      // second click while this component unmounts.
      router.replace("/command/bitacora");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error publicando la campaña.");
      setExecuteFailed(true);
      setPublishing(false);
    }
  }

  return (
    <>
      <GatesSummaryCard preview={gatePreview} />

      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
            <Field label="Red">{NET_LABEL[network] ?? network}</Field>
            <Field label="Cuenta">{accountRef}</Field>
            <Field label="Estado del blueprint">
              <Badge tone={STATUS_TONE[status] ?? "muted"}>{status}</Badge>
            </Field>
            <Field label="Acciones compiladas">{compiled.length}</Field>
          </div>
          <PausedBadge elementCount={compiled.length} />
        </div>
      </Card>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        <SecondaryButton href="/command/crear">Volver al constructor</SecondaryButton>
        <PrimaryButton disabled={!canPublish} onClick={() => void publish()}>
          {publishing ? "Publicando…" : "Publicar en pausa"}
        </PrimaryButton>
      </div>

      {alreadyMoved ? (
        <ErrorCard
          style={{ marginBottom: 16 }}
          message={
            status === "executed"
              ? "Este blueprint ya fue publicado. Revisa el resultado en la Bitácora."
              : `Este blueprint ya salió de borrador (estado actual: ${status}) — no se puede volver a publicar desde aquí. Vuelve al constructor si necesitas ajustar algo.`
          }
        />
      ) : null}

      {error ? (
        <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <ErrorCard message={error} />
          {executeFailed ? <NextSteps /> : null}
        </div>
      ) : null}

      {blocked ? (
        <Card style={{ marginBottom: 16, borderColor: UI.danger }}>
          <SectionLabel>Compuertas — publicación bloqueada</SectionLabel>
          <p style={{ fontSize: 13, color: UI.muted, marginTop: -4, marginBottom: 12 }}>
            El motor bloqueó una acción antes de tocar la cuenta. No se reintenta automáticamente — vuelve al
            constructor para ajustar la campaña.
          </p>
          <GateTable rows={blocked} />
          <div style={{ marginTop: 12 }}>
            <NextSteps />
          </div>
        </Card>
      ) : null}

      {groups.map((g) => (
        <Card key={g.key} style={{ marginBottom: 16 }}>
          <SectionLabel>{g.title}</SectionLabel>
          {g.actions.map((a) => (
            <ActionCard key={a.seq} action={a} />
          ))}
        </Card>
      ))}
    </>
  );
}
