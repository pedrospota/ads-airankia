# Centro de Mando (beta) — Multi-Network Execution Rail — Design Spec

Date: 2026-07-07 · Status: approved-for-planning · Owner: Pedro (hello@airankia.com)
Branch: `feat/command-center-beta` · Deploy: manual merge only (main auto-deploys prod)

## 1. Summary

Add a **beta, self-contained "Centro de Mando" module** to ads-airankia that lets an
internal operator manage paid-media accounts **end-to-end across Google Ads and Meta
Ads**: see unified account state, queue optimization actions, and — for the first
time in this platform — **execute approved actions against the ad networks via API**
(L2 "approve-to-execute"), guarded by deterministic pre-flight gates, recorded in an
append-only change ledger, and reversible with one-click rollback.

This unfreezes the execution layer deliberately and narrowly: writes happen only
through one new chokepoint, only for a small set of low-blast-radius action types,
only on explicitly enabled connected accounts, and never through the existing
propose-only surfaces (gads-sentinel, Copiloto) or the campaign-creation wizards.

## 2. Sacred invariants (unchanged)

1. **gads-sentinel stays read-only.** No engine code changes. The engine remains the
   Google analysis brain; we consume its recommendations/approvals read-only.
2. **Copiloto keeps its candado de escritura.** `lectura`/`dryrun` modes untouched;
   `record_proposal` still writes engine proposals only.
3. **Campaign-creation paths untouched.** `src/lib/google-ads.ts`,
   `src/lib/agents/a6-activator.ts`, `/api/campaigns/*`, `/api/search/*` are not
   modified. The `campaign_type` Display/Search isolation invariant is preserved.
4. **The platform's own account creds (`GOOGLE_ADS_REFRESH_TOKEN`) are never used by
   the command center.** Command-center Google writes use **per-workspace connected
   accounts** (`ads_google_connections` refresh tokens via `CONNECTIONS_KEY`).
5. **Tenancy = airankia Supabase RLS.** The ads Postgres is never the tenant boundary.
6. **Prod safety:** all work on `feat/command-center-beta`; no push to `main` without
   Pedro's explicit go. New tables are additive (`CREATE TABLE IF NOT EXISTS`).

## 3. Users & rollout

- v1 users: internal team only (Pedro + operators). The sidebar group renders only
  when `COMMAND_CENTER_BETA=true` **and** the session email passes `isAdminEmail()`
  (reuses `src/lib/admin.ts`; operators can be added via `ADMIN_EMAILS`).
- SaaS exposure, self-serve onboarding, billing: explicitly out of scope (fast-follow).

## 4. Approaches considered

- **A (chosen): in-app rail.** New `src/lib/command/` + `/api/command/*` routes +
  ADS-DB tables. Reuses every existing primitive (token crypto, ledger pattern,
  chokepoint pattern, ui-kit). No new infra, no engine changes, beta-flaggable.
- B: engine-side rail (extend gads-sentinel with write endpoints). Rejected: violates
  the engine's read-only constitution, requires the other repo, couples Meta into a
  Google-only brain.
- C: separate executor microservice. Rejected for v1: new deploy/auth surface and
  operational overhead without adding safety beyond what the chokepoint gives us.

## 5. Architecture overview

```
        ┌────────────── ads.airankia.com (Next.js 16) ──────────────┐
        │                                                            │
 engine recs ──► /command/acciones (UI queue) ──► approve ──► execute chokepoint
 (sentinel.ts,     ▲            ▲                              /api/command/actions/[id]/execute
  read-only)       │            │                                   │
             manual composer  Meta reads                            ▼
                               (adapter)                 ┌── gate engine (deterministic) ──┐
                                                         │ blocking? ──► abort + evidence  │
                                                         └───────────────┬────────────────┘
                                                                         ▼
                                                    NetworkAdapter.execute(action)
                                                    google: REST mutate (validateOnly → real)
                                                    meta:   Graph API POST
                                                                         │
                                              cc_executions ledger (before/after, actor,
                                              gates, rollback recipe) ◄──┘
                                                                         │
                                                    /command/bitacora (flight recorder)
                                                    one-click rollback → same chokepoint
```

Data flow for Google proposals: engine `AccountFull.ai_plan.optimizations` +
`approvals` (rec_key) → "Importar del motor" → `cc_actions(source='engine')`.
Meta v1 has no engine; actions come from the manual composer (+ deterministic
suggestions computed from insights in the UI, marked `source='regla'`).

## 6. Data model (ADS DB, Drizzle + `/api/migrate` step `007_command_center`)

All tables additive; snake_case; follow `schema.ts` conventions (uuid pk default
`gen_random_uuid()`, timestamptz defaults).

**`cc_actions`** — the multi-network action queue.
- `id` uuid pk · `workspace_id` text NOT NULL · `created_by` text NOT NULL (email)
- `network` text NOT NULL (`google_ads` | `meta_ads`)
- `connection_id` text (Supabase `ads_google_connections.id`; null for Meta env-token)
- `account_ref` text NOT NULL (Google `customer_id` | Meta `act_<id>`)
- `entity_kind` text NOT NULL (`campaign` | `ad_group` | `adset`) — `add_negatives` targets a `campaign`
- `entity_ref` text NOT NULL (network resource id) · `entity_name` text
- `action_type` text NOT NULL (`budget_update` | `pause` | `enable` | `add_negatives`)
- `payload` jsonb NOT NULL — typed per action_type, e.g.
  `{ "new_daily_budget_micros": 25000000 }` or `{ "negatives": [{"text":"gratis","match":"PHRASE"}] }`
- `expected` jsonb — the `before` values claimed at proposal time (drift baseline)
- `source` text NOT NULL (`engine` | `manual` | `regla` | `copiloto`) · `rec_key` text (dedup w/ engine)
- `rationale` text · `evidence` jsonb (source metrics/links)
- `status` text NOT NULL default `proposed`
  (`proposed → approved → executing → executed → verified | failed | rolled_back`; also `rejected`, `expired`)
- `approved_by` text · `approved_at` timestamptz · `executed_at` timestamptz
- `gate_results` jsonb (last run) · `error` text
- UNIQUE (`workspace_id`, `network`, `rec_key`) WHERE rec_key IS NOT NULL
- `created_at`/`updated_at`

**`cc_executions`** — append-only ledger (the flight recorder). Modeled on
`google_mutations`, generalized.
- `id` uuid pk · `action_id` uuid → cc_actions · `attempt` int default 1
- `network` text · `account_ref` text · `operation` text (e.g. `campaignBudgets:mutate`, `POST /{adset_id}`)
- `request_hash` text (idempotency: sha256 of canonical request) · `validate_only` boolean default false
- `before` jsonb NOT NULL (live snapshot read immediately pre-mutation)
- `request` jsonb · `response` jsonb · `after` jsonb (post-read verification)
- `rollback_recipe` jsonb NOT NULL (inverse action payload; `{ "action_type":"budget_update", "payload":{...before} }`)
- `status` text (`pending | done | failed | rolled_back`) · `actor` text (email) · `created_at`
- UNIQUE (`action_id`, `request_hash`, `attempt`)

**`cc_settings`** — per-workspace guardrails (one row per workspace, defaults seeded).
- `workspace_id` text pk
- `executions_paused` boolean default false — **kill switch**
- `max_budget_delta_pct` int default 30
- `max_actions_per_account_day` int default 20
- `require_two_step` boolean default true (approve and execute are separate clicks)
- `allowed_action_types` jsonb default all four
- `watch_hours` int default 72 · `updated_by` text · `updated_at`

Meta connections table (Supabase, per-workspace OAuth) is **deferred**; v1 Meta auth
is env-based (§8). No Supabase DDL in v1.

## 7. Network adapter contract (`src/lib/command/networks/`)

```ts
// types.ts (SERVER-ONLY, like sentinel.ts)
export type CcNetwork = "google_ads" | "meta_ads";
export type CcActionType = "budget_update" | "pause" | "enable" | "add_negatives";

export interface AdapterCapabilities {
  read: boolean; write: boolean;
  actionTypes: CcActionType[];
  reason?: string;                    // "META_SYSTEM_USER_TOKEN no configurado"
}
export interface EntitySnapshot {      // normalized cross-network state
  entityKind: string; entityRef: string; name?: string;
  status?: "ENABLED" | "PAUSED" | "REMOVED" | "ARCHIVED";
  dailyBudgetMicros?: number | null; currency?: string | null;
  learningPhase?: "LEARNING" | "LIMITED" | "STABLE" | "UNKNOWN";
  conversions30d?: number | null; spend30d?: number | null;
  raw?: Record<string, unknown>;
}
export interface ExecuteResult {
  operation: string; requestHash: string;
  request: unknown; response: unknown;
  resourceNames?: string[];           // created criteria etc. (rollback needs them)
}
export interface NetworkAdapter {
  network: CcNetwork;
  capabilities(ctx: AdapterCtx): Promise<AdapterCapabilities>;
  listAccounts(ctx: AdapterCtx): Promise<AccountInfo[]>;
  snapshot(ctx: AdapterCtx, accountRef: string, entityKind: string, entityRef: string): Promise<EntitySnapshot>;
  listCampaigns(ctx: AdapterCtx, accountRef: string): Promise<EntitySnapshot[]>;
  validate?(ctx, action): Promise<{ ok: boolean; detail?: unknown }>;  // Google validateOnly
  execute(ctx: AdapterCtx, action: CcActionInput, before: EntitySnapshot): Promise<ExecuteResult>;
  buildRollback(action: CcActionInput, before: EntitySnapshot, exec: ExecuteResult): CcActionInput;
}
```

**Google adapter** (`google.ts`): REST `googleads.googleapis.com/v21` (env-pinned
`GOOGLE_ADS_API_VERSION`). Auth: `mintAccessToken(decryptSecret(refresh_token_enc))`
from the workspace's `ads_google_connections` row + `GOOGLE_ADS_DEVELOPER_TOKEN`;
`login-customer-id` only when the connection's account list marks the target as
managed (`is_manager` chain; stored per action at proposal time). Operations:
- `budget_update` → resolve campaign's `campaignBudget` resource → `campaignBudgets:mutate` update `amountMicros`
- `pause`/`enable` → `campaigns:mutate` status (also `adGroups:mutate` when entity_kind=ad_group)
- `add_negatives` → `campaignCriteria:mutate` create negative keyword criteria
  (campaign-scoped, `tolerate partialFailure` like A6)
- Reads via GAQL `googleAds:search` (snapshot: status, budget, biddingStrategyType +
  30d `metrics.conversions`/`cost_micros`).
- **Every real mutate is preceded by the same body with `validateOnly:true`** (free
  server-side rehearsal); validation failure = blocking gate result.

**Meta adapter** (`meta.ts`): Graph API `graph.facebook.com/<META_API_VERSION>`
(default resolved from official docs at implementation time via context7). Auth:
`META_SYSTEM_USER_TOKEN` env; accounts allowlisted by `META_AD_ACCOUNT_IDS`
(comma-sep `act_…`). Operations:
- `pause`/`enable` → `POST /{campaign_id|adset_id}` `{ status: "PAUSED"|"ACTIVE" }`
- `budget_update` → `POST /{adset_id|campaign_id}` `{ daily_budget }` (minor units)
- `add_negatives` → not supported on Meta → capability excludes it.
- Reads: `/act_x/campaigns`, `/act_x/adsets` (`fields=status,daily_budget,learning_stage_info`),
  `/act_x/insights` (30d spend/actions).
- **No token ⇒ `capabilities().write=false`**: UI shows "pendiente de credenciales",
  actions can be proposed/approved but the execute button is disabled with the reason.

## 8. Gate engine (`src/lib/command/gates.ts`)

Deterministic, synchronous-ish checks run at execute time (and previewable from the
UI). Registry returns `GateResult { id, severity: "blocking"|"warning", status:
"pass"|"fail", evidence: string }`. v1 gates:

| id | severity | rule |
|---|---|---|
| `KILL_SWITCH` | blocking | `cc_settings.executions_paused` must be false |
| `CAPABILITY` | blocking | adapter reports write + action_type supported |
| `ACTION_ALLOWED` | blocking | action_type ∈ `cc_settings.allowed_action_types` |
| `DRIFT` | blocking | live `before` snapshot matches `expected` on the mutated fields (status/budget); mismatch ⇒ someone changed it since proposal |
| `BUDGET_DELTA` | blocking | budget change ≤ `max_budget_delta_pct` (both directions) and > 0 |
| `BLAST_RADIUS` | blocking | executed actions for this account today < `max_actions_per_account_day` |
| `CURRENCY_SANITY` | blocking | micros/minor-units integer, ≥ network minimum, currency known |
| `LEARNING_PHASE` | blocking for `budget_update`/`enable` on Meta adsets in `LEARNING`; warning on Google | never scale during learning (industry rule) |
| `TRACKING_SIGNAL` | warning | 30d conversions == 0 while spend > 0 ⇒ warn (don't scale blind) |
| `VALIDATE_ONLY` | blocking (Google only) | Google `validateOnly` rehearsal passed |

Blocking gates cannot be overridden in v1. Results are persisted to
`cc_actions.gate_results` and into the ledger row.

## 9. Execution chokepoint & lifecycle

Single write path: `POST /api/command/actions/[id]/execute`
(`runtime=nodejs`, `dynamic=force-dynamic`, Supabase session + admin/beta gate +
workspace ownership via RLS-checked membership):
1. Load action; require `status='approved'` (and `approved_by != null`;
   `require_two_step` keeps approve/execute as distinct clicks).
2. Run gate engine (fresh live snapshot). Any blocking fail ⇒ persist results,
   `status` stays `approved`, 409 with evidence.
3. Insert `cc_executions` row `status='pending'` (with request_hash) **before** the
   network call (crash-safe: a pending row with no response is reconcilable).
4. Adapter `validate` (Google) then `execute`. Timeout 30s.
5. Update ledger row (`response`, `after` re-read, `status='done'`), action →
   `executed`, `executed_at=now`. On network error: ledger `failed`, action `failed`
   with `error`.
6. Rollback recipe = `buildRollback(...)` stored on the ledger row at step 3.

Other routes: `/api/command/actions` (GET list / POST create),
`/api/command/actions/[id]` (GET), `/approve` (POST; sets approved_by=session email),
`/reject`, `/rollback` (POST; creates + executes the inverse action through the same
chokepoint, linking `rolled_back`), `/api/command/import-engine` (POST; pulls
engine optimizations/approvals for a mapped account into cc_actions),
`/api/command/accounts` (GET; unified accounts via adapters),
`/api/command/settings` (GET/POST caps + kill switch).
Global `CC_DRY_RUN=true` env forces every execute into validate/preview-only
(staging safety).

## 10. UI (ui-kit patterns, Spanish, dark-first)

New `NavGroup` **"Centro de Mando"** (+ `DESTINATIONS` entries in the command
palette), rendered only when beta-flag + admin:
- `/command` — resumen: adapters/capabilities status, cuentas conectadas, acciones
  pendientes/ejecutadas (StatCards), kill switch visible.
- `/command/acciones` — the queue: DataTable filterable by network/estado; cards with
  evidence, gate preview, Aprobar → Ejecutar (two-step), Rechazar; "Importar del
  motor" button per Google account; manual composer (drawer/form) for both networks.
- `/command/cuentas` — unified account/campaign browser (snapshots from adapters,
  budget/status/learning columns); per-row quick actions create proposals.
- `/command/bitacora` — the flight recorder: every execution with before/after diff,
  actor, gates, and "Revertir" button; empty states via `EmptyState`.
- `/conexiones` gains a Meta card (env-token status only in v1).
Pages follow the house pattern: server page (auth block → fetch → nullable error) +
`*-client.tsx` island; `force-dynamic`; `PageHeader/Card/StatCard/DataTable/Badge`.

## 11. Config & env additions

`COMMAND_CENTER_BETA` (flag) · `CC_DRY_RUN` (staging) · `META_SYSTEM_USER_TOKEN`
[secret] · `META_AD_ACCOUNT_IDS` · `META_API_VERSION`. Reused: `CONNECTIONS_KEY`,
`GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_API_VERSION`, Supabase pair,
`ADS_DATABASE_URL`, `ADMIN_EMAILS`. All set manually in Coolify at deploy time
(documented in the PR description; never committed).

## 12. Error handling & observability

House style: try/catch into nullable `error`, Spanish user-facing messages,
`ErrorCard`. Network calls: single retry on 5xx/timeout for reads, **no automatic
retry for mutations** (idempotency via request_hash + manual re-execute).
Every execute/rollback also writes `cost_events` (category `external_api`, provider
`google_ads`/`meta_ads`, units=1) so `/admin/costs` sees command-center activity.

## 13. Testing

`bun test` (zero-dep, matches workspace tooling; dev-only, not wired into Docker):
- Unit: gate engine (every gate, pass/fail matrices), rollback recipe builders,
  request-hash canonicalization, payload validators.
- Adapter tests with mocked `fetch` (Google mutate bodies incl. validateOnly; Meta
  Graph calls; error mapping).
- State machine: illegal transitions rejected (`proposed→executed` impossible, etc.).
- Manual E2E checklist (pre-merge): CC_DRY_RUN on staging vault account → validate
  budget_update/pause/enable/add_negatives on a real connected test account, then one
  real minimal budget change + rollback, verifying ledger + Google/Meta UIs.

## 14. Rollout & risks

1. Implement on branch; `bun run build` + tests green; Playwright smoke on :4200.
2. Pedro reviews PR diff; merge → Coolify auto-deploy; run admin `/api/migrate`;
   set env vars; flag on for admins only.
3. First week: CC_DRY_RUN=true in prod, exercise the whole flow without writes.
4. Then real L2 on one internal Google account; Meta activates when token exists.

Risks: token scope (connected-account OAuth uses the broad `adwords` scope — writes
are permission-limited by the Google user's own account access, which is the correct
boundary); Meta token absent (module degrades to propose-only — acceptable);
migration must be run manually post-deploy (documented); learning-phase detection on
Google via GAQL is best-effort (warning-level only there).

## 15. Out of scope (fast-follows)

L3 auto-policies · per-workspace Meta OAuth (needs Supabase DDL/RLS) · post-change
KPI watchers on cron · Copiloto proposing directly into cc_actions · more action
types (bid/tCPA changes, ad-level ops) · more networks (Microsoft next) ·
SaaS exposure/billing.
