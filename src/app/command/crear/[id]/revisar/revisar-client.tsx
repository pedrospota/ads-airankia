"use client";

// Centro de Mando v2 — Review & publish. Renders EVERY compiled action's full
// payload, grouped by campaign-tree node (campaign+budget, then one group per
// ad group with its keywords/negatives and each ad), so the operator sees
// exactly what will be sent to Google before anything touches the account.
// "Publicar en pausa" runs approve → execute; a 409 with `blocked` renders the
// same gate-panel pattern as acciones-client.tsx and does NOT auto-retry.

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
import type {
  GateResult,
  CreateBudgetPayload,
  CreateCampaignPayload,
  CreateAdGroupPayload,
  CreateKeywordsPayload,
  CreateAdPayload,
} from "@/lib/command/types";

const ACTION_LABEL: Record<string, string> = {
  create_budget: "Crear presupuesto",
  create_campaign: "Crear campaña",
  create_ad_group: "Crear grupo de anuncios",
  create_keywords: "Añadir palabras clave",
  create_ad: "Crear anuncio (RSA)",
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
    if (action.actionType === "create_keywords") {
      const ref = (action.payload as CreateKeywordsPayload).adGroupRef;
      (adGroupByRef.get(ref) ?? campaignGroup).actions.push(action);
      continue;
    }
    if (action.actionType === "create_ad") {
      const ref = (action.payload as CreateAdPayload).adGroupRef;
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
 * Root
 * ------------------------------------------------------------------------- */

export default function RevisarClient({
  blueprintId,
  status,
  network,
  accountRef,
  compiled,
}: {
  blueprintId: string;
  status: string;
  network: string;
  accountRef: string;
  compiled: CompiledAction[];
}) {
  const router = useRouter();
  const [publishing, setPublishing] = useState(false);
  const [blocked, setBlocked] = useState<GateResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => groupByNode(compiled), [compiled]);
  // The blueprint's status the moment this page loaded. If it's already past
  // 'draft' (a reload after publishing, or a stale tab), publishing again would
  // just 409 at the approve step — so the button stays disabled and we point
  // the operator at the Bitácora / builder instead of letting them retry here.
  const alreadyMoved = status !== "draft";
  const canPublish = !publishing && !blocked && !alreadyMoved;

  async function publish() {
    if (!canPublish) return;
    setPublishing(true);
    setError(null);
    setBlocked(null);
    try {
      const approveRes = await fetch(`/api/command/blueprint/${blueprintId}/approve`, { method: "POST" });
      const approveData = await approveRes.json().catch(() => ({}) as { error?: string });
      if (!approveRes.ok) {
        throw new Error(approveData.error ?? `No se pudo aprobar (HTTP ${approveRes.status}).`);
      }

      const execRes = await fetch(`/api/command/blueprint/${blueprintId}/execute`, { method: "POST" });
      const execData = await execRes
        .json()
        .catch(() => ({}) as { error?: string; blocked?: GateResult[]; ok?: boolean });

      if (execRes.status === 409 && Array.isArray(execData.blocked)) {
        // Gate blocked an action — do NOT auto-retry. The operator must go back
        // to the builder to fix the blueprint.
        setBlocked(execData.blocked);
        setPublishing(false);
        return;
      }
      if (!execRes.ok || execData.ok === false) {
        throw new Error(execData.error ?? `No se pudo ejecutar (HTTP ${execRes.status}).`);
      }

      // Full success: redirect to the Bitácora. `publishing` stays true so the
      // button stays disabled/labeled through the navigation — no window for a
      // second click while this component unmounts.
      router.replace("/command/bitacora");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error publicando la campaña.");
      setPublishing(false);
    }
  }

  return (
    <>
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

      {error ? <ErrorCard message={error} style={{ marginBottom: 16 }} /> : null}

      {blocked ? (
        <Card style={{ marginBottom: 16, borderColor: UI.danger }}>
          <SectionLabel>Compuertas — publicación bloqueada</SectionLabel>
          <p style={{ fontSize: 13, color: UI.muted, marginTop: -4, marginBottom: 12 }}>
            El motor bloqueó una acción antes de tocar la cuenta. No se reintenta automáticamente — vuelve al
            constructor para ajustar la campaña.
          </p>
          <DataTable>
            <THead cols={[{ label: "Compuerta" }, { label: "Severidad" }, { label: "Estado" }, { label: "Evidencia" }]} />
            <tbody>
              {blocked.map((g) => (
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
