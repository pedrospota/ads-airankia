"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ----------------------------------------------------------------------------
// Cost-observability panel. Reads /api/admin/costs and shows per-day, per-user,
// per-provider and per-model spend (LLM tokens + external API calls) so we can
// answer "what did each user cost us today?" at a glance. All money arrives in
// micros; we format it here.
// ----------------------------------------------------------------------------

interface Totals {
  cost_micros: number;
  tokens_in: number;
  tokens_out: number;
  events: number;
  users: number;
  runs: number;
}
interface DayRow {
  day: string;
  cost_micros: number;
  tokens_in: number;
  tokens_out: number;
  events: number;
}
interface ProviderRow {
  provider: string | null;
  cost_micros: number;
  events: number;
}
interface CategoryRow {
  category: string;
  cost_micros: number;
  events: number;
}
interface ModelRow {
  resource: string | null;
  provider: string | null;
  cost_micros: number;
  tokens_in: number;
  tokens_out: number;
  events: number;
}
interface UserRow {
  user_id: string | null;
  cost_micros: number;
  tokens_in: number;
  tokens_out: number;
  events: number;
  runs: number;
}
interface RecentRow {
  occurred_at: string;
  category: string;
  provider: string | null;
  resource: string | null;
  cost_micros: number;
  tokens_in: number;
  tokens_out: number;
  units: number;
  user_id: string | null;
  run_id: string | null;
}
interface ToolRow {
  module: string | null;
  tool: string | null;
  cost_micros: number;
  tokens_in: number;
  tokens_out: number;
  events: number;
}
interface CostsResp {
  days: number;
  currency: string;
  totals: Totals;
  byDay: DayRow[];
  byProvider: ProviderRow[];
  byCategory: CategoryRow[];
  byModel: ModelRow[];
  byTool: ToolRow[];
  byUser: UserRow[];
  recent: RecentRow[];
}

// ----------------------------------------------------------------------------
// Styles (match admin-model-settings.tsx dark theme)
// ----------------------------------------------------------------------------
const card: React.CSSProperties = {
  padding: 20,
  borderRadius: 12,
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  marginBottom: 16,
};
const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  opacity: 0.5,
  fontWeight: 600,
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 13,
  borderTop: "1px solid rgba(255,255,255,0.06)",
  whiteSpace: "nowrap",
};
const rangeChip = (active: boolean): React.CSSProperties => ({
  padding: "5px 12px",
  borderRadius: 999,
  fontSize: 12,
  cursor: "pointer",
  fontWeight: 600,
  background: active ? "#6366F1" : "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: active ? "#fff" : "#FAFAFA",
});

// ----------------------------------------------------------------------------
// Formatting helpers (guard every value — never NaN/undefined)
// ----------------------------------------------------------------------------
function money(micros: number, currency: string): string {
  const v = (Number(micros) || 0) / 1_000_000;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: v < 1 ? 4 : 2,
    }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}
function compact(n: number): string {
  const v = Number(n) || 0;
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(v);
}
function shortId(id: string | null): string {
  if (!id) return "—";
  return id.slice(0, 8);
}
function whenLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const RANGES = [7, 30, 90];

export function AdminCostsPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<CostsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback((rangeDays: number) => {
    // Cancel any in-flight request before starting a new one.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/costs?days=${rangeDays}`, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.detail || body.error || `HTTP ${r.status}`);
        }
        return r.json() as Promise<CostsResp>;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load costs");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load(days);
    // Cancel on unmount AND whenever the range changes (re-runs cleanup).
    return () => abortRef.current?.abort();
  }, [days, load]);

  const cur = data?.currency ?? "USD";
  const t = data?.totals;
  const maxDay = Math.max(1, ...(data?.byDay ?? []).map((d) => d.cost_micros));

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
            Costs &amp; usage
          </h2>
          <p style={{ opacity: 0.5, fontSize: 14, marginTop: 4 }}>
            Per-day and per-user spend across LLM tokens and external APIs.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              style={rangeChip(days === r)}
              onClick={() => setDays(r)}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div style={{ ...card, opacity: 0.6 }}>Loading cost data…</div>
      )}

      {error && (
        <div
          style={{
            ...card,
            borderColor: "rgba(248,113,113,0.4)",
            background: "rgba(248,113,113,0.08)",
          }}
        >
          <strong>Couldn&apos;t load costs.</strong>
          <div style={{ opacity: 0.7, fontSize: 13, marginTop: 6 }}>{error}</div>
          <p style={{ opacity: 0.6, fontSize: 13, marginTop: 8 }}>
            If this is the first deploy, the ledger table may not exist yet — run{" "}
            <code>POST /api/migrate</code> once, then reload.
          </p>
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* Summary cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 12,
              marginBottom: 16,
            }}
          >
            {[
              { label: "Total cost", value: money(t?.cost_micros ?? 0, cur) },
              {
                label: "Tokens (in / out)",
                value: `${compact(t?.tokens_in ?? 0)} / ${compact(
                  t?.tokens_out ?? 0
                )}`,
              },
              { label: "Events", value: compact(t?.events ?? 0) },
              { label: "Active users", value: String(t?.users ?? 0) },
              { label: "Campaign runs", value: String(t?.runs ?? 0) },
            ].map((s) => (
              <div key={s.label} style={card}>
                <div style={{ opacity: 0.5, fontSize: 12, marginBottom: 6 }}>
                  {s.label}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Per-day bars */}
          <div style={card}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>
              Daily spend (last {data.days} days, UTC)
            </div>
            {data.byDay.length === 0 && (
              <div style={{ opacity: 0.5, fontSize: 13 }}>
                No cost events recorded yet in this window.
              </div>
            )}
            {data.byDay.map((d) => (
              <div
                key={d.day}
                style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}
              >
                <div style={{ width: 84, fontSize: 12, opacity: 0.6 }}>{d.day}</div>
                <div
                  style={{
                    flex: 1,
                    height: 18,
                    borderRadius: 4,
                    background: "rgba(255,255,255,0.05)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(2, (d.cost_micros / maxDay) * 100)}%`,
                      height: "100%",
                      background: "linear-gradient(90deg,#6366F1,#8B5CF6)",
                    }}
                  />
                </div>
                <div style={{ width: 90, textAlign: "right", fontSize: 13 }}>
                  {money(d.cost_micros, cur)}
                </div>
              </div>
            ))}
          </div>

          {/* Provider + category split */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 16,
            }}
          >
            <div style={card}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>By provider</div>
              <Table
                head={["Provider", "Cost", "Events"]}
                rows={data.byProvider.map((p) => [
                  p.provider ?? "—",
                  money(p.cost_micros, cur),
                  compact(p.events),
                ])}
              />
            </div>
            <div style={card}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>By category</div>
              <Table
                head={["Category", "Cost", "Events"]}
                rows={data.byCategory.map((c) => [
                  c.category === "llm" ? "LLM tokens" : "External API",
                  money(c.cost_micros, cur),
                  compact(c.events),
                ])}
              />
            </div>
          </div>

          {/* By model */}
          <div style={card}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>By model</div>
            <Table
              head={["Model", "Provider", "Cost", "Tokens in", "Tokens out", "Calls"]}
              rows={data.byModel.map((m) => [
                m.resource ?? "—",
                m.provider ?? "—",
                money(m.cost_micros, cur),
                compact(m.tokens_in),
                compact(m.tokens_out),
                compact(m.events),
              ])}
            />
          </div>

          {/* By tool — per-feature spend (spy/keyword_spend, benchmark/report, …) */}
          <div style={card}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>By tool / feature</div>
            <Table
              head={["Module", "Tool / stage", "Cost", "Tokens in", "Tokens out", "Calls"]}
              rows={(data.byTool ?? []).map((t) => [
                t.module ?? "—",
                t.tool ?? "—",
                money(t.cost_micros, cur),
                compact(t.tokens_in),
                compact(t.tokens_out),
                compact(t.events),
              ])}
            />
          </div>

          {/* By user */}
          <div style={card}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              By user (top 25)
            </div>
            <Table
              head={["User", "Cost", "Tokens in", "Tokens out", "Runs", "Events"]}
              mono={[0]}
              rows={data.byUser.map((u) => [
                shortId(u.user_id),
                money(u.cost_micros, cur),
                compact(u.tokens_in),
                compact(u.tokens_out),
                String(u.runs),
                compact(u.events),
              ])}
            />
          </div>

          {/* Recent events */}
          <div style={card}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Recent events</div>
            <Table
              head={["When", "Category", "Provider", "Resource", "Cost", "Tokens", "User"]}
              mono={[6]}
              rows={data.recent.map((r) => [
                whenLabel(r.occurred_at),
                r.category === "llm" ? "LLM" : "API",
                r.provider ?? "—",
                r.resource ?? "—",
                money(r.cost_micros, cur),
                r.category === "llm"
                  ? `${compact(r.tokens_in)}/${compact(r.tokens_out)}`
                  : `${compact(r.units)}u`,
                shortId(r.user_id),
              ])}
            />
          </div>
        </>
      )}
    </div>
  );
}

// Tiny table renderer (keeps the markup above readable).
function Table({
  head,
  rows,
  mono,
}: {
  head: string[];
  rows: (string | number)[][];
  mono?: number[];
}) {
  const monoSet = new Set(mono ?? []);
  if (rows.length === 0) {
    return <div style={{ opacity: 0.5, fontSize: 13 }}>No data.</div>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} style={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td
                  key={ci}
                  style={{
                    ...td,
                    fontFamily: monoSet.has(ci)
                      ? "ui-monospace, monospace"
                      : undefined,
                    opacity: monoSet.has(ci) ? 0.7 : 1,
                  }}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
