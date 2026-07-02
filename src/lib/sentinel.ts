/**
 * gads-sentinel headless API client.
 *
 * ⚠️ SERVER-ONLY. This module reads SENTINEL_API_KEY and talks to the
 * optimizer API server-to-server. NEVER import it from a client component
 * ("use client") — the API key must never reach the browser. Only use it
 * from server components, route handlers or server actions.
 */

// ---------------------------------------------------------------------------
// Types (every field can be null/absent — code defensively downstream)
// ---------------------------------------------------------------------------

export interface PortfolioAccount {
  account_id: string;
  name?: string | null;
  spend_30d?: number | null;
  ahorro?: number | null;
  oportunidad?: number | null;
  n_props?: number | null;
  n_recs?: number | null;
  health?: number | null;
  top?: string | null;
  analyzed_at?: string | null;
}

export interface PortfolioResponse {
  accounts?: PortfolioAccount[] | null;
}

export type KpiKey = "spend" | "conv" | "cpa" | "roas" | "ctr" | "cpc" | "clicks";
export type DeltaKey = "spend" | "conv" | "cpa" | "roas" | "ctr";

export interface AccountKpis {
  current?: Partial<Record<KpiKey, number | null>> | null;
  prior?: Partial<Record<KpiKey, number | null>> | null;
  delta_pct?: Partial<Record<DeltaKey, number | null>> | null;
  period_days?: number | null;
}

export interface Optimization {
  title?: string | null;
  action_type?: string | null;
  target?: string | null;
  detail?: string | null;
  dollars_at_stake?: number | null;
  confidence?: string | number | null;
  expected_impact?: string | null;
  priority?: string | number | null;
}

export interface Recommendation {
  action_family?: string | null;
  action_type?: string | null;
  target?: string | null;
  dollars_at_stake?: number | null;
  confidence?: string | number | null;
  n_decisive?: number | null;
  effect_pct_net?: number | null;
}

export interface AuditCategory {
  label?: string | null;
  score?: number | null;
}

export interface Audit {
  grade?: string | null;
  score?: number | null;
  n_fail?: number | null;
  n_warn?: number | null;
  n_suppressed?: number | null;
  categories?: AuditCategory[] | null;
}

export interface AccountDetail {
  account_id: string;
  name?: string | null;
  analyzed_at?: string | null;
  objetivo?: string | null;
  kpis?: AccountKpis | null;
  optimizations?: Optimization[] | null;
  recommendations?: Recommendation[] | null;
  audit?: Audit | null;
  business_rules_active?: boolean | null;
}

export interface SecurityItem {
  kind?: "url_change" | "budget_change" | "finding" | string | null;
  account_id?: string | null;
  account_name?: string | null;
  who?: string | null;
  old?: string | number | null;
  new?: string | number | null;
  rule?: string | null;
  entity?: string | null;
  at?: string | null;
}

export interface SecurityResponse {
  items?: SecurityItem[] | null;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

export async function sentinelFetch<T>(path: string): Promise<T> {
  const baseUrl = process.env.SENTINEL_API_URL;
  const apiKey = process.env.SENTINEL_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "El optimizador no está configurado (faltan SENTINEL_API_URL / SENTINEL_API_KEY en el servidor)."
    );
  }

  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(
      `No se pudo conectar con el optimizador (${path}): ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!res.ok) {
    throw new Error(
      `El optimizador respondió ${res.status} ${res.statusText} en ${path}.`
    );
  }

  return (await res.json()) as T;
}

export function fetchPortfolio(): Promise<PortfolioResponse> {
  return sentinelFetch<PortfolioResponse>("/api/v1/portfolio");
}

export function fetchAccount(id: string): Promise<AccountDetail> {
  return sentinelFetch<AccountDetail>(
    `/api/v1/accounts/${encodeURIComponent(id)}`
  );
}

export function fetchSecurity(): Promise<SecurityResponse> {
  return sentinelFetch<SecurityResponse>("/api/v1/security");
}

// ---------------------------------------------------------------------------
// Pure formatting helpers (shared by the server pages that render this data)
// ---------------------------------------------------------------------------

/** "$12,345" (account currency; plain number in, "—" when absent). */
export function fmtMoney(n: number | null | undefined, decimals = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Plain number with thousands separators, "—" when absent. */
export function fmtNum(n: number | null | undefined, decimals = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

/** Relative time for recent timestamps, short date otherwise. */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `hace ${days} d`;
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}
