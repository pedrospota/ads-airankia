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

// ---------------------------------------------------------------------------
// Full-platform surface (native integration of the whole optimizer).
// Types are permissive on purpose: the engine returns the raw payloads the
// Python views render, so shapes may grow — render defensively.
// ---------------------------------------------------------------------------

export interface AccountFull {
  account_id?: string;
  name?: string | null;
  analyzed_at?: string | null;
  diagnostic?: Record<string, unknown> | null;
  ai_plan?: {
    business?: Record<string, unknown> | null;
    optimizations?: Array<Record<string, unknown>> | null;
    signals?: Record<string, unknown> | null;
    measured?: Array<Record<string, unknown>> | null;
    computed_at?: string | null;
  } | null;
  recommendations?: Array<Record<string, unknown>> | null;
  audit?: {
    grade?: string;
    score?: number;
    n_fail?: number;
    n_warn?: number;
    n_suppressed?: number;
    categories?: Array<{ label?: string; score?: number; checks?: Array<Record<string, unknown>> }>;
    checks?: Array<Record<string, unknown>>;
  } | null;
  audit_ai?: Record<string, unknown> | null;
  approvals?: Array<{ rec_key?: string; title?: string | null; detail?: Record<string, unknown>; approved_by?: string | null; approved_at?: string | null }> | null;
  shadow_bets?: Array<Record<string, unknown>> | null;
  business_profile?: {
    objetivo?: string | null; cpa_objetivo?: number | null; roas_objetivo?: number | null;
    marca_intencional?: boolean; fase?: string | null; excluir_campanas?: string[]; notas?: string | null;
  } | null;
}

export interface SimBet {
  account_id?: string; account_name?: string | null; rec_id?: string;
  action_family?: string | null; target?: string | null; objective?: string | null;
  kind?: string; status?: string; dollars_at_stake?: number | null;
  effect_pct_net?: number | null; confidence?: number | null; missed_usd?: number | null;
  opened_at?: string | null; resolved_at?: string | null;
}

export function fetchAccountFull(id: string): Promise<AccountFull> {
  return sentinelFetch<AccountFull>(`/api/v1/accounts/${encodeURIComponent(id)}/full`);
}

export function fetchRecommendations(): Promise<{ accounts?: Array<{ account_id?: string; name?: string; computed_at?: string | null; recs?: Array<Record<string, unknown>> }> }> {
  return sentinelFetch("/api/v1/recommendations");
}

export function fetchSimulacion(account?: string): Promise<{ bets?: SimBet[] }> {
  return sentinelFetch(`/api/v1/simulacion${account ? `?account=${encodeURIComponent(account)}` : ""}`);
}

export function fetchBacktest(): Promise<Record<string, unknown>> {
  return sentinelFetch("/api/v1/backtest");
}

export function fetchSalud(): Promise<{
  token_connected?: boolean; minutes_since_last_run?: number | null;
  n_recommendations?: number; n_open_findings?: number;
  collectors?: Array<{ collector?: string; status?: string; started_at?: string | null; accounts_scanned?: number; items?: number; error?: string | null }>;
}> {
  return sentinelFetch("/api/v1/salud");
}

export function fetchCosts(days = 30): Promise<{ rows?: Array<{ day?: string; kind?: string; model?: string; calls?: number; prompt_tokens?: number; completion_tokens?: number; cost_usd?: number }> }> {
  return sentinelFetch(`/api/v1/costs?days=${days}`);
}

export function fetchOptimizers(days = 14): Promise<{ days?: number; rows?: Array<{ person?: string; account_id?: string; account_name?: string; n_changes?: number; types?: Record<string, number> }> }> {
  return sentinelFetch(`/api/v1/optimizers?days=${days}`);
}

async function sentinelPost<T>(path: string, body: unknown): Promise<T> {
  const baseUrl = process.env.SENTINEL_API_URL;
  const apiKey = process.env.SENTINEL_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("El optimizador no está configurado (SENTINEL_API_URL / SENTINEL_API_KEY).");
  }
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`El optimizador respondió ${res.status} en ${path}.`);
  return (await res.json()) as T;
}

export function postApprove(id: string, body: { rec_key: string; title?: string; detail?: Record<string, unknown>; approved_by?: string }): Promise<{ ok?: boolean }> {
  return sentinelPost(`/api/v1/accounts/${encodeURIComponent(id)}/approve`, body);
}

export function postRevert(id: string, rec_key: string): Promise<{ ok?: boolean }> {
  return sentinelPost(`/api/v1/accounts/${encodeURIComponent(id)}/revert`, { rec_key });
}

export function postRules(id: string, rules: Record<string, unknown>): Promise<{ ok?: boolean }> {
  return sentinelPost(`/api/v1/accounts/${encodeURIComponent(id)}/rules`, rules);
}

// ---------------------------------------------------------------------------
// Remaining native views: triage (Auditoría MCC), datalake, diagnostics,
// config (Ajustes). Permissive types — every field may be null/absent.
// ---------------------------------------------------------------------------

export interface TriageRow {
  account_id?: string;
  name?: string | null;
  grade?: string | null;
  score?: number | null;
  n_fail?: number | null;
  n_warn?: number | null;
  n_suppressed?: number | null;
  worst?: Array<{ label?: string | null; score?: number | null }> | null;
}

export function fetchTriage(): Promise<{ rows?: TriageRow[] | null }> {
  return sentinelFetch("/api/v1/triage");
}

export interface DatalakeRow {
  episode_id?: string | null;
  account_id?: string | null;
  client_name?: string | null;
  campaign_name?: string | null;
  entity_level?: string | null;
  action_type?: string | null;
}

export function fetchDatalake(limit = 100): Promise<{ total?: number | null; rows?: DatalakeRow[] | null }> {
  return sentinelFetch(`/api/v1/datalake?limit=${encodeURIComponent(limit)}`);
}

export interface DiagnosticRow {
  account_id?: string;
  name?: string | null;
  computed_at?: string | null;
  search_cost_30d?: number | null;
  n_saturation?: number | null;
}

export function fetchDiagnostics(): Promise<{ rows?: DiagnosticRow[] | null }> {
  return sentinelFetch("/api/v1/diagnostics");
}

export interface EngineConfig {
  alerts_enabled?: boolean | null;
  telegram_configured?: boolean | null;
  chat_configured?: boolean | null;
  llm_model?: string | null;
  vision_model?: string | null;
  digest_hour_utc?: number | null;
  scan_interval_minutes?: number | null;
  token_connected?: boolean | null;
  token_email?: string | null;
  mcc?: string | null;
}

export function fetchConfig(): Promise<EngineConfig> {
  return sentinelFetch("/api/v1/config");
}

// ---------------------------------------------------------------------------
// Engine-source bridge (F4): hand the engine a refresh token to scan with.
// ⚠️ SERVER-ONLY (like the rest of this module): reads SENTINEL_API_KEY and
// sends a plaintext refresh token server-to-server. Never call from a client.
// ---------------------------------------------------------------------------

/**
 * POST the (decrypted) Google Ads refresh token to the engine's
 * /admin/set-token endpoint so it becomes the connection the engine scans
 * with (read-only). Throws on any non-OK response.
 */
export async function postEngineSetToken(
  email: string | null | undefined,
  refreshToken: string
): Promise<void> {
  const baseUrl = process.env.SENTINEL_API_URL;
  const setupKey = process.env.SENTINEL_API_KEY;
  if (!baseUrl || !setupKey) {
    throw new Error(
      "El motor no está configurado (faltan SENTINEL_API_URL / SENTINEL_API_KEY en el servidor)."
    );
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/admin/set-token`, {
      method: "POST",
      headers: {
        "x-setup-key": setupKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: email ?? null, refresh_token: refreshToken }),
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(
      `No se pudo conectar con el motor (/admin/set-token): ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!res.ok) {
    throw new Error(`El motor respondió ${res.status} ${res.statusText} en /admin/set-token.`);
  }
}

// ---------------------------------------------------------------------------
// Legacy GET bridge — the engine's on-demand triggers (/account/{id}/reason-now,
// team-brief, …) and CSV exports live on legacy GET routes gated by ?key=.
// ⚠️ SERVER-ONLY (like everything here): the key must never reach the browser.
// ---------------------------------------------------------------------------

/** Build the legacy GET URL: base + path + (?|&)key=SENTINEL_API_KEY. */
function engineLegacyUrl(path: string): string {
  const baseUrl = process.env.SENTINEL_API_URL;
  const apiKey = process.env.SENTINEL_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "El optimizador no está configurado (faltan SENTINEL_API_URL / SENTINEL_API_KEY en el servidor)."
    );
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${baseUrl.replace(/\/+$/, "")}${path}${sep}key=${encodeURIComponent(apiKey)}`;
}

/**
 * Fire an on-demand trigger on the engine (reason-now, audit-ai, briefs…).
 * The engine kicks a background job and answers with a redirect — so 200/302/303
 * all count as "accepted". redirect:"manual" keeps us from following it.
 */
export async function engineTrigger(path: string): Promise<{ ok: boolean; status: number }> {
  let res: Response;
  try {
    res = await fetch(engineLegacyUrl(path), {
      redirect: "manual",
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(
      `No se pudo conectar con el optimizador (${path}): ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return { ok: res.status === 200 || res.status === 302 || res.status === 303, status: res.status };
}

/**
 * Fetch one of the engine's CSV/JSONL exports. Returns the raw Response so the
 * caller can stream the body straight through (content-type + disposition
 * included). redirect:"manual" → an unexpected 302 means the key was rejected.
 */
export async function engineCsv(path: string): Promise<Response> {
  try {
    return await fetch(engineLegacyUrl(path), {
      redirect: "manual",
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(
      `No se pudo conectar con el optimizador (${path}): ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Engine HTML bridge (client report). ⚠️ SERVER-ONLY like the whole module.
// ---------------------------------------------------------------------------

/**
 * GET an HTML page from the engine, authenticated. Uses the legacy ?key= gate
 * (session-secret) AND sends x-api-key so /api/v1/* paths work too. Returns
 * the raw HTML text; throws on any non-OK response.
 */
export async function fetchEngineHtml(path: string): Promise<string> {
  const apiKey = process.env.SENTINEL_API_KEY ?? "";
  let res: Response;
  try {
    res = await fetch(engineLegacyUrl(path), {
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
  return res.text();
}

/**
 * GET a PUBLIC HTML page from the engine WITHOUT any credential — for the
 * public token pages (e.g. /r/{account}/{token}) the engine validates its own
 * signed token, so no key must ever be attached to the request. Returns the
 * raw HTML text; throws on any non-OK response (e.g. 404 = invalid token).
 */
export async function fetchEnginePublicHtml(path: string): Promise<string> {
  const baseUrl = process.env.SENTINEL_API_URL;
  if (!baseUrl) {
    throw new Error(
      "El optimizador no está configurado (falta SENTINEL_API_URL en el servidor)."
    );
  }
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
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
  return res.text();
}

// ---------------------------------------------------------------------------
// Measured intelligence (playbook / scorecard) + anti-hijack allowlist.
// Permissive types — every field may be null/absent; render defensively.
// ---------------------------------------------------------------------------

/** One (action_family × objective) cell of the measured playbook. */
export interface PlaybookCell {
  action_family?: string | null;
  /** Defensive alias — some payloads may say `family`. */
  family?: string | null;
  objective?: string | null;
  n?: number | null;
  n_effect?: number | null;
  n_decisive?: number | null;
  n_improved?: number | null;
  n_worsened?: number | null;
  n_surfed?: number | null;
  /** Global cells only: how many accounts contribute evidence. */
  n_accounts?: number | null;
  /** 0–1 over decisive episodes (improved / worsened). */
  win_rate?: number | null;
  /** Median NET effect in % (de-confounded: net of the account trend). */
  median_net?: number | null;
}

export interface PlaybookAccount {
  account_id?: string | null;
  name?: string | null;
  cells?: PlaybookCell[] | null;
}

export interface PlaybookResponse {
  global?: PlaybookCell[] | null;
  by_account?: PlaybookAccount[] | null;
}

export function fetchPlaybook(): Promise<PlaybookResponse> {
  return sentinelFetch<PlaybookResponse>("/api/v1/playbook");
}

/** Per-person measured scorecard row (debiased by account difficulty). */
export interface ScorecardRow {
  optimizer?: string | null;
  /** Defensive aliases for the person field. */
  person?: string | null;
  name?: string | null;
  email?: string | null;
  n?: number | null;
  n_effect?: number | null;
  n_decisive?: number | null;
  n_improved?: number | null;
  n_worsened?: number | null;
  n_surfed?: number | null;
  n_accounts?: number | null;
  /** 0–1 over decisive episodes. */
  win_rate?: number | null;
  /** Median NET effect in % (de-confounded). */
  median_net?: number | null;
  /** Partial-pooled net effect in %. */
  median_shrunk?: number | null;
  /** Counter.most_common(3) → [["campaign", 12], …]. */
  top_families?: Array<[string, number]> | null;
}

export function fetchScorecard(): Promise<{ rows?: ScorecardRow[] | null }> {
  return sentinelFetch<{ rows?: ScorecardRow[] | null }>("/api/v1/scorecard");
}

/** One entry of the anti-hijack brand-domain allowlist. */
export interface BrandDomainRow {
  id?: number | string | null;
  domain?: string | null;
  scope?: string | null;
  added_by?: string | null;
}

export function fetchBrandDomains(): Promise<{ rows?: BrandDomainRow[] | null }> {
  return sentinelFetch<{ rows?: BrandDomainRow[] | null }>("/api/v1/brand-domains");
}

/** Add or remove an allowlist domain. `scope` defaults to "global" engine-side. */
export function postBrandDomain(body: {
  action: "add" | "remove";
  domain: string;
  scope?: string;
  by?: string;
}): Promise<{ ok?: boolean }> {
  return sentinelPost("/api/v1/brand-domains", body);
}

// ---------------------------------------------------------------------------
// Legacy POST bridge — some engine endpoints (e.g. POST /ga4-event) take an
// urlencoded HTML form and gate on a "key" field INSIDE the form body.
// ⚠️ SERVER-ONLY (like everything here): the key must never reach the browser.
// ---------------------------------------------------------------------------

/**
 * POST an urlencoded form to a legacy engine endpoint. The SENTINEL_API_KEY is
 * injected into the body as the "key" field (that is how these routes gate).
 * The engine answers a form post with a redirect: 303 = accepted, while a 302
 * to "/" means the key was rejected — so only 200/303 count as ok.
 * redirect:"manual" keeps us from following either.
 */
export async function enginePostForm(
  path: string,
  form: Record<string, string>
): Promise<{ ok: boolean; status: number }> {
  const baseUrl = process.env.SENTINEL_API_URL;
  const apiKey = process.env.SENTINEL_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "El optimizador no está configurado (faltan SENTINEL_API_URL / SENTINEL_API_KEY en el servidor)."
    );
  }
  const body = new URLSearchParams({ ...form, key: apiKey });

  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(
      `No se pudo conectar con el optimizador (${path}): ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return { ok: res.status === 200 || res.status === 303, status: res.status };
}
