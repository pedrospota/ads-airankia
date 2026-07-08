"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Card, DataTable, THead, Row, Cell, Badge, EmptyState, SecondaryButton, PrimaryButton, UI } from "@/components/ui-kit";
import type { CampaignMetrics, CcMetricsRange } from "@/lib/command/types";

export interface UnifiedAccount {
  network: "google_ads" | "meta_ads";
  accountRef: string;
  name: string;
  connectionId: string | null;
}

interface CampaignRow {
  entityKind: string;
  entityRef: string;
  name?: string | null;
  status?: string;
  dailyBudgetMicros?: number | null;
  learningPhase?: string;
}

const NET_LABEL = { google_ads: "Google Ads", meta_ads: "Meta Ads" } as const;

// v2.6 — 7d/30d segmented range toggle for the campaign metrics columns.
// Same segmented-control styling as editar/editor-panels.tsx's StatusToggle.
function RangeToggle({ value, onChange }: { value: CcMetricsRange; onChange: (r: CcMetricsRange) => void }) {
  const segStyle = (active: boolean): CSSProperties => ({
    border: `1px solid ${active ? UI.accent : UI.borderStrong}`,
    background: active ? UI.accentSoft : "none",
    color: active ? UI.text : UI.muted,
    borderRadius: UI.radiusSm,
    padding: "6px 14px",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
  });
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <button type="button" style={segStyle(value === "7d")} onClick={() => onChange("7d")}>
        7 días
      </button>
      <button type="button" style={segStyle(value === "30d")} onClick={() => onChange("30d")}>
        30 días
      </button>
    </div>
  );
}

// Micros → currency units, 2 decimals (matches the existing budget column style).
function fmtMicros(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

export default function CuentasClient({
  accounts,
  metaWritable,
  metaReason,
}: {
  accounts: UnifiedAccount[];
  metaWritable: boolean;
  metaReason: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<UnifiedAccount | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [range, setRange] = useState<CcMetricsRange>("30d");
  const [metrics, setMetrics] = useState<CampaignMetrics[] | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposing, setProposing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingRef, setEditingRef] = useState<string | null>(null);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  // Fetch stays gated behind an explicit trigger (the "Ver campañas" click, or
  // the range toggle once an account is already selected) — never on render.
  async function loadCampaigns(account: UnifiedAccount, r: CcMetricsRange = range) {
    setSelected(account);
    setCampaigns(null);
    setMetrics(null);
    setMetricsError(null);
    setError(null);
    setBusy(true);
    try {
      const qs = new URLSearchParams({ network: account.network, account: account.accountRef, range: r });
      if (account.connectionId) qs.set("connection", account.connectionId);
      const res = await fetch(`/api/command/campaigns?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCampaigns(data.campaigns ?? []);
      setMetrics(data.metrics ?? []);
      setMetricsError(data.metricsError ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error cargando campañas");
    } finally {
      setBusy(false);
    }
  }

  function changeRange(r: CcMetricsRange) {
    setRange(r);
    if (selected) void loadCampaigns(selected, r);
  }

  // Zero-impression campaigns are never dropped from `campaigns` (the entity
  // list is the untouched source of truth — see types.ts CampaignMetrics doc),
  // but a campaign absent from `metrics` (or the whole read failing/missing)
  // has no known spend/clicks/conv for the range: the cells render "—", never
  // a fabricated 0.
  const metricsByRef = new Map((metrics ?? []).map((m) => [m.entityRef, m]));

  async function propose(campaign: CampaignRow, actionType: "pause" | "enable") {
    if (!selected) return;
    setProposing(campaign.entityRef);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/command/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: selected.network,
          connection_id: selected.connectionId,
          account_ref: selected.accountRef,
          entity_kind: campaign.entityKind,
          entity_ref: campaign.entityRef,
          entity_name: campaign.name ?? null,
          action_type: actionType,
          payload: {},
          rationale: `Propuesta manual desde Cuentas (${NET_LABEL[selected.network]})`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNotice(`Acción "${actionType}" propuesta para ${campaign.name ?? campaign.entityRef}. Revísala en Acciones.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error proponiendo acción");
    } finally {
      setProposing(null);
    }
  }

  // Loads a live Google Search campaign into a v2.3 edit-mode draft blueprint and
  // navigates to the workbench. The campaigns DTO (EntitySnapshot) doesn't carry
  // advertising_channel_type, so we can't gate this to SEARCH-only rows client-side —
  // the route itself refuses non-SEARCH campaigns with a 409, surfaced here inline.
  async function startEdit(campaign: CampaignRow) {
    if (!selected || selected.network !== "google_ads" || !selected.connectionId) return;
    setEditingRef(campaign.entityRef);
    setEditErrors((prev) => ({ ...prev, [campaign.entityRef]: "" }));
    try {
      const res = await fetch("/api/command/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "google_ads",
          connection_id: selected.connectionId,
          account_ref: selected.accountRef,
          campaign_id: campaign.entityRef,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.push(`/command/editar/${data.id}`);
    } catch (e) {
      setEditErrors((prev) => ({ ...prev, [campaign.entityRef]: e instanceof Error ? e.message : "Error abriendo el editor" }));
    } finally {
      setEditingRef(null);
    }
  }

  return (
    <>
      <Card>
        {accounts.length === 0 ? (
          <EmptyState
            title="Sin cuentas operables"
            hint="Habilita cuentas en Conexiones (Google) o configura META_AD_ACCOUNT_IDS (Meta)."
          />
        ) : (
          <DataTable>
            <THead cols={[{ label: "Red" }, { label: "Cuenta" }, { label: "Referencia" }, { label: "" }]} />
            <tbody>
              {accounts.map((a) => (
                <Row key={`${a.network}:${a.accountRef}`}>
                  <Cell>
                    <Badge tone={a.network === "google_ads" ? "accent" : a.network === "meta_ads" && !metaWritable ? "muted" : "ok"}>
                      {NET_LABEL[a.network]}
                    </Badge>
                  </Cell>
                  <Cell>{a.name}</Cell>
                  <Cell mono>{a.accountRef}</Cell>
                  <Cell>
                    <SecondaryButton disabled={busy} onClick={() => loadCampaigns(a)}>
                      Ver campañas
                    </SecondaryButton>
                  </Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        )}
        {!metaWritable && metaReason ? (
          <p style={{ color: UI.muted, fontSize: 13, marginTop: 12 }}>Meta: {metaReason}</p>
        ) : null}
      </Card>

      {selected ? (
        <Card style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontWeight: 600 }}>Campañas · {selected.name}</h3>
            <RangeToggle value={range} onChange={changeRange} />
          </div>
          {error ? <p style={{ color: UI.danger }}>{error}</p> : null}
          {notice ? <p style={{ color: UI.accent }}>{notice}</p> : null}
          {metricsError ? (
            <p style={{ color: UI.warn, fontSize: 13 }}>No se pudieron cargar las métricas: {metricsError}</p>
          ) : null}
          {busy ? <p style={{ color: UI.muted }}>Cargando…</p> : null}
          {campaigns && campaigns.length === 0 ? <EmptyState title="Sin campañas" /> : null}
          {campaigns && campaigns.length > 0 ? (
            <DataTable>
              <THead
                cols={[
                  { label: "Campaña" },
                  { label: "Estado" },
                  { label: "Presupuesto/día", align: "right" },
                  { label: "Inversión", align: "right" },
                  { label: "Clics", align: "right" },
                  { label: "Conv.", align: "right" },
                  { label: "CPA", align: "right" },
                  { label: "Aprendizaje" },
                  { label: "Acciones" },
                ]}
              />
              <tbody>
                {campaigns.map((c) => {
                  const m = metricsByRef.get(c.entityRef);
                  return (
                  <Row key={c.entityRef}>
                    <Cell>{c.name ?? c.entityRef}</Cell>
                    <Cell>
                      <Badge tone={c.status === "ENABLED" ? "ok" : c.status === "PAUSED" ? "warn" : "muted"}>
                        {c.status ?? "?"}
                      </Badge>
                    </Cell>
                    <Cell align="right" mono>
                      {c.dailyBudgetMicros != null ? (c.dailyBudgetMicros / 1_000_000).toFixed(2) : "—"}
                    </Cell>
                    <Cell align="right" mono>{m ? fmtMicros(m.spendMicros) : "—"}</Cell>
                    <Cell align="right" mono>{m ? m.clicks : "—"}</Cell>
                    <Cell align="right" mono>{m ? m.conversions.toFixed(2) : "—"}</Cell>
                    <Cell align="right" mono>
                      {m && m.conversions !== 0 ? fmtMicros(m.spendMicros / m.conversions) : "—"}
                    </Cell>
                    <Cell>{c.learningPhase ?? "—"}</Cell>
                    <Cell>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                        <div style={{ display: "flex", gap: 8 }}>
                          {c.status === "ENABLED" ? (
                            <SecondaryButton disabled={proposing === c.entityRef} onClick={() => propose(c, "pause")}>
                              Proponer pausa
                            </SecondaryButton>
                          ) : c.status === "PAUSED" ? (
                            <PrimaryButton disabled={proposing === c.entityRef} onClick={() => propose(c, "enable")}>
                              Proponer activación
                            </PrimaryButton>
                          ) : null}
                          {selected.network === "google_ads" ? (
                            <SecondaryButton disabled={editingRef === c.entityRef} onClick={() => void startEdit(c)}>
                              {editingRef === c.entityRef ? "Abriendo…" : "Editar"}
                            </SecondaryButton>
                          ) : null}
                        </div>
                        {editErrors[c.entityRef] ? (
                          <span style={{ color: UI.danger, fontSize: 12 }}>{editErrors[c.entityRef]}</span>
                        ) : null}
                      </div>
                    </Cell>
                  </Row>
                  );
                })}
              </tbody>
            </DataTable>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
