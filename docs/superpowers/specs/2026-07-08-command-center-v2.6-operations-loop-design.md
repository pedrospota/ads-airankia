# Command Center v2.6 — Operations Loop — Design Spec

Date: 2026-07-08 · Status: approved-for-planning (autonomous continuation; closes gap-audit items 2.1/2.2/2.4)
Produced by: 3-lens design workflow (data-plumbing, operator-UX, verification-safety) + opus synthesis. Repo main @ f9b1d8b.

## Command Center v2.6 — Operations Loop (MERGED, minimal)

Every load-bearing claim below was verified against the repo at f9b1d8b: executor.ts, gates.ts, state.ts, actions-repo.ts, executor-deps.ts, schema.ts (cc_actions/cc_executions/cc_settings/cc_blueprints), networks/{google,meta}.ts, campaigns + import-engine routes, sentinel.ts, and the cuentas/acciones/command clients. The three lenses agreed on (a) and (b) almost verbatim; the only real fork was the notification store (migration vs no-migration) and create-verification scope. I resolve both toward the minimal end WITH code evidence.

---
### (a) Performance in the loop — metrics surface

**New OPTIONAL adapter read, NOT an extension of `listCampaigns`.** In `types.ts`:
```ts
export type CcMetricsRange = "7d" | "30d";
export interface CampaignMetrics {
  entityRef: string;              // joins EntitySnapshot.entityRef
  spendMicros: number; clicks: number; impressions: number; conversions: number;
}
// on NetworkAdapter:
listCampaignMetrics?(auth: AdapterAuth, accountRef: string, range: CcMetricsRange): Promise<CampaignMetrics[]>;
```
Why a sibling read, not a widened `listCampaigns`/`EntitySnapshot`: (1) EntitySnapshot is a rail contract persisted in cc_executions.before/after and cc_actions.expected — range-parameterized metrics don't belong there; (2) VERIFIED trap: adding `segments.date DURING X` to the GAQL *entity* query silently drops zero-impression campaigns, which are exactly the dormant campaigns the operator pauses/enables. So the entity list stays the untouched source of truth for WHICH campaigns exist; metrics are a second bulk read merged by id with zero-defaults.

- **Google** (`google.ts` new method) — ONE aggregated GAQL per account+range via the module-private `gaql()`: `SELECT campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date DURING LAST_7_DAYS|LAST_30_DAYS`. No `segments` in SELECT ⇒ one aggregated row per campaign; map with the existing `num()`.
- **Meta** (`meta.ts` new method) — ONE insights call: `GET /{act}/insights?level=campaign&date_preset=last_7d|last_30d&fields=campaign_id,spend,clicks,impressions,actions&limit=500`. spend decimal→micros via `Math.round(Number(spend) * MICROS_PER_UNIT)`; conversions via the existing `CONVERSION_ACTIONS` set. **Extract a shared per-row helper** `conversionsFromActions(actions)` from `insightsToSignals` so campaign-metrics and snapshot-signals never diverge. Follow `paging.next` at most once (1000 ceiling).
- **Meta credential-less = fail-closed for free**: `capabilities({}).read` is false and `/api/command/campaigns` already 409s BEFORE any adapter call — no Graph request is attempted. UI keeps the existing "pendiente de credenciales" line and renders metric cells as "—". Zero new fail-closed code.

**Route** — `GET /api/command/campaigns` gains `range=7d|30d` (default 30d). Calls `listCampaigns` + `listCampaignMetrics?` in `Promise.all`, merges by `entityRef` (missing → zeros), returns `{ campaigns, metrics, range, metricsError? }`. Metrics failure **degrades open** (campaigns still render, `metricsError` string set) — reads fail OPEN; only WRITES fail closed. Adapter without the method → metrics omitted, UI "—".

**Cuentas UI** — campaign table gains **Inversión · Clics · Conv. · CPA** (CPA = spend/conv, "—" when conv=0; monetary from micros, right-aligned) + a **7d/30d segmented toggle** in the card header (refetch). Reads happen ONLY on the existing "Ver campañas" click (on-demand), never on page render — this is the primary page-latency mitigation.

**Cost / caching: NONE.** Bulk + on-demand ⇒ constant call count per view (Google 2 GAQL = entity+metrics; Meta 2 GET), toggle = one refetch. cc_metrics table and in-memory TTL both **rejected as YAGNI** at single-operator scale.

**Free bonus, zero extra API calls** — the approve route already snapshots (Google snapshot fetches conversions30d/spend30dMicros; Meta snapshot pulls /insights) but persists only `{status, dailyBudgetMicros}` into `cc_actions.expected`. Extend `expected` to also carry `conversions30d`/`spend30dMicros` and render "contexto al aprobar: X conv / $Y 30d" on the Acciones row. VERIFIED inert: the DRIFT gate reads only `expected.status` and `expected.dailyBudgetMicros` with `!== undefined` guards, so extra keys change no gate behavior.

---
### (b) Batch actions + pickers

**Client-side SEQUENTIAL loop over the EXISTING per-action endpoints. NO batch endpoint.** Every mutation still enters `POST /api/command/actions/[id]/execute → executeAction` with its own `prepare()` (fresh snapshot, validateOnly rehearsal, all 13 gates incl. per-action DRIFT, per-action `countExecutedToday`), its own ledger row and rollback recipe. A server batch route is rejected on three verified grounds: (1) it is a SECOND mutation-capable path (loops executeAction) — pure invariant erosion; (2) a 20-action Google batch (each ≈ snapshot GAQL + validateOnly + mutate + after-snapshot ≈ 2–4s) blows the 60s `maxDuration`, forcing partial-result/resume machinery the repo deliberately lacks (no DB transactions); (3) per-action 409 gate panels already map 1:1 to rows. **Sequential, not parallel**: `countExecutedToday` is read-then-gate, so parallel executes would race `MAX_ACTIONS_PER_DAY`/BLAST_RADIUS; sequential keeps gate 409s attributable per row.

**Stop semantics** — **continue past gate-blocks (409), stop on hard error (non-409/5xx/network).** A 409 is per-action business logic (row → "bloqueada por compuertas", collected into the existing per-row gate panel); an unrelated account's block must not strand 19 siblings. A 5xx/network fault is systemic (adapter/auth/DB) and likely to repeat, so stop, keep unprocessed rows selected, summary "N ejecutadas · M bloqueadas · 1 error — proceso detenido". (KILL_SWITCH manifests as a 409 gate-block, so flipping it mid-batch safely skips the remainder.) This is NOT the blueprint plan runner (which stops mid-plan by design); batch = independent approved rows.

**Acciones UX** (`acciones-client.tsx`) — checkbox column + "Seleccionar visibles" (operates on the current status filter, so a selection is verb-homogeneous). Toolbar: proposed/failed → "Aprobar seleccionadas (N)" + "Rechazar seleccionadas (N)"; approved → "Ejecutar seleccionadas (N)". Execute-batch shows ONE confirm (count, per-action labels, sum of budget deltas, "se ejecutan en orden, las bloqueadas se omiten"); approve/reject need no confirm (reversible). Client cap **20** (mirrors `maxActionsPerAccountDay` default; server gates remain the real enforcement). Progress "3/7…" + per-row outcome chips. Rollback stays **single-row** (deliberate friction) — no batch revert.

**Import pickers** — `acciones/page.tsx` (server) loads (1) sentinel `fetchPortfolio()` engine accounts (server-only; best-effort — on error → free-text fallback) and (2) the workspace Google connection accounts via a new `listUnifiedAccounts(access)` helper. The three free-text inputs become two selects: **"Cuenta del motor"** (fills `engine_account_id`) and **"Cuenta destino"** (one pick fills `connection_id` + `account_ref` together, so they can never mismatch). `import-engine/route.ts` UNTOUCHED — VERIFIED it re-validates connection↔workspace server-side, which stays the authority.

---
### (c) Verification + expiry + notifications

**Trigger: LAZY session-scoped sweep — `POST /api/command/verify` (getCommandAccess-gated, maxDuration 60), fired fire-and-forget from the /command (resumen) and /command/acciones clients on mount, then `router.refresh()` when it reports changes. Manual "Verificar ahora" button too. NOT an external cron.** Deciding constraint, VERIFIED in code: `buildExecutorDeps` resolves Google auth through `createSupabaseReadClient(access.accessToken)` under RLS — there is NO service-role key anywhere in the repo. A secret-gated `/api/command/cron` would need `SUPABASE_SERVICE_ROLE_KEY` (first-ever RLS bypass) AND an external scheduler (Coolify has no worker) — both banned by "in-app first / no new external service". Lazy is sufficient because the ONLY consumer of verification/expiry results is the operator viewing the page; an unvisited weekend leaves rows in 'executed'/'approved' = today's behavior, no regression, fails closed. The timing hole (a stale approval executable before any sweep) is closed at execute time (below).

**Double-run guard — read-only + status-predicate writes + bounded + in-process dedupe.** Three cheap layers: (1) `transitionAction` is optimistic `WHERE id AND status=<from>` — a losing concurrent writer updates 0 rows, and verification performs ZERO network mutations + ZERO ledger writes, so a cross-instance double-run is at worst a duplicate read-only snapshot + a no-op UPDATE; (2) expiry is ONE atomic set-based UPDATE (inherently race-free); (3) a module-scope `let sweepInFlight: Promise | null` dedupes concurrent tabs in-process, plus a per-workspace `lastSweepAt` Map throttle (~10 min) to skip redundant reads on rapid navigation, plus `LIMIT 10` verifications/sweep. No advisory locks — nothing in the sweep is non-idempotent.

**Sweep (NEW `src/lib/command/verify.ts` → `runSweep(access): Promise<{expired; verified; drifted; checked}>` — READ-only snapshots + state transitions, NEVER `executeAction`/`adapter.execute`):**

1. **Expiry pass (first, DB-only, atomic).** NEW repo `expireStaleApproved(workspaceIds, olderThanHours): Promise<number>` = a single set-based UPDATE `SET status='expired', error='Aprobación caducada (>72h): vuelve a aprobar', updated_at=now() WHERE workspace_id IN (…) AND status='approved' AND approved_at < now() - interval`, with a static `assertTransition('approved','expired')` at the top (VERIFIED: that edge exists in state.ts). Window = **code constant `CC_APPROVAL_TTL_HOURS = 72`**, deliberately NOT bound to `cc_settings.watchHours` — watch-window ≠ approval-TTL semantics, and binding it would couple a per-workspace watch setting to expiry aggressiveness and surprise CC_DRY_RUN rehearsal weeks. Stale 'proposed' rows are NOT expired (deferred). Terminal — re-approve = re-propose (a "re-proponer" clone button is deferred).

2. **Verification pass (network reads, capped).** Select `status='executed' AND executed_at < now − VERIFY_AFTER_HOURS (=4) AND error IS NULL AND action_type ∈ VERIFIABLE`, workspace-scoped, oldest first, `LIMIT 10`. Rows whose `capabilities().read` is false (Meta sin credenciales) are SKIPPED WITHOUT stamping (auto-verify when creds land). Per row: `buildExecutorDeps(access.accessToken)` (SAME RLS path as every route) → ONE `adapter.snapshot()` → decide via a PURE, unit-testable `verifyOutcome(action, after): {verified; note?}`:
   - **budget_update** → verified iff `after.dailyBudgetMicros === expectedMicros`, where `expectedMicros = payload.newDailyBudgetMicros` for Google, and for Meta `= Math.round(newDailyBudgetMicros / MICROS_PER_MINOR_UNIT) * MICROS_PER_MINOR_UNIT` — VERIFIED the adapter writes budgets via `microsToCents`, so comparing raw micros would false-drift every non-cent-round Meta budget. Keep this rounding rule in ONE shared helper with meta.ts.
   - **pause / enable** → verified iff `after.status === 'PAUSED' / 'ENABLED'` (the field we mutated; meta `mapStatus` normalizes ACTIVE→ENABLED). Meta `effective_status` divergence is out of scope (documented).
   - **`VERIFIABLE_ACTION_TYPES = {budget_update, pause, enable}` ONLY.** Create-verification is DEFERRED (see below), so v2.6 ships no `existsAll` adapter method — the biggest single scope cut vs the verification-safety lens, justified by YAGNI: creates are rarer + beta-gated; the optimize rail's frequent mutations are these three.
   - **Verified** → `transitionAction(row,'verified',{ evidence: <merge {verification:{checkedAt, checkedField, expected, actual}}> })`. VERIFIED executed→verified is legal; the optimistic guard makes it fire exactly once. Merging into `evidence` is safe (no clobber): the engine writes `evidence` only at creation and never re-touches an executed row — this neutralizes the "jsonb owner" objection WITHOUT a new column.
   - **Drift** (field ≠ intended) → status UNCHANGED (no executed→drift edge; don't invent one). NEW repo `recordVerificationDrift(id, note): Promise<void>` = a direct guarded UPDATE `SET error=<Spanish drift note>, updated_at=now() WHERE id=$1 AND status='executed'`. VERIFIED-safe signal: `executeAction` sets `error:null` on success and `rollbackAction` sets `error:null`, so `error≠null` on an 'executed' row unambiguously = drift, and the `error IS NULL` filter makes drift ONE-SHOT. Row turns red in Acciones + enters Novedades; resolution = existing Revertir or manual fix. No structured drift evidence write (YAGNI — the human string suffices; sidesteps the evidence jsonb entirely for the drift path).
   - **Adapter/read error** → skip, leave executed, `error` stays null → retried next sweep (fail closed: never verified without a successful read).

Cost: worst-case sweep = 10 snapshots ≈ 20 GAQL (Google snapshot = 2) or 20 Graph GETs, a few times/day on page loads. Batched multi-id snapshot deferred (the cap makes it moot).

**Execute-time expiry backstop (closes the lazy-timing hole).** In `/api/command/actions/[id]/execute` route, BEFORE `executeAction`: if `status==='approved' && approved_at` older than `CC_APPROVAL_TTL_HOURS` → transition to 'expired' + return `409 "Aprobación caducada (>72h): vuelve a aprobar"`. Lives in the route (already the only `executeAction` caller); the rail (executor/gates/state) stays byte-identical. The DRIFT gate already blocks entity-changed-since-approve; the TTL adds pure time-based staleness on top.

**Notification channel: in-app "Novedades", a pure QUERY over cc_actions + cc_blueprints. NO cc_events table, NO migration, NO new columns.** Every notify-worthy event already leaves a durable, workspace-scoped, RLS-queryable trace:
- **Plan falló mid-execution** → `cc_blueprints.status='failed'` (+ its `cc_actions.status='failed'`)
- **Acción falló** → `cc_actions.status='failed'`
- **Bloqueada por compuertas en execute** → `cc_actions.status='approved'` AND `gateResults` contains a blocking fail (VERIFIED: executor re-stamps `gateResults` on the approved→approved self-loop at block, and the Acciones DTO already carries gateResults)
- **Deriva** → `cc_actions.status='executed'` AND `error IS NOT NULL`
- **Caducada** → `cc_actions.status='expired'`

NEW repo `listNovedades(workspaceIds)`: a few indexed status queries (`idx_cc_actions_status` exists) + a JS-side filter of the bounded approved rows for `{severity:'blocking',status:'fail'}` gateResults + a last-7-days window on `updated_at` (limit 50). It is a **state-based needs-attention count** that clears when the underlying row is resolved (re-approve/reject/revert) — the honest artifact for an ops loop, and precisely why it can be a query with no read/unread state.

**Rejected, with evidence:** email (VERIFIED no mailer in repo — grep clean except a copiloto false positive; SMTP/Resend = new external service); Telegram (Pedro's bot exists but a token = new config + external dep; trivially layered later as a fire-and-forget POST off `listNovedades`); a `cc_events` table (needs writer hooks at every failure site — touching the rail — plus per-user read-state + retention, all to duplicate already-queryable state); `verified_at`/`verify_result` columns proposed by two lenses (**CUT** — the no-migration path is proven feasible above, so a migration is not genuinely needed and the strong NO-migration preference wins).

**Surface:** a Novedades card atop /command (resumen): five counts (Planes fallidos · Acciones fallidas · Con deriva · Bloqueadas por compuertas · Caducadas) deep-linking to /command/acciones with the matching filter (+ blueprint links to the workbench). Acciones page gains filters for `expired`/`verified` (statuses it already types but never filters) and fires the sweep on mount (non-blocking → `router.refresh()`). Empty state: "Sin novedades. Todo verificado y al día."

---
### (e) File-level plan

**NEW**
- `src/lib/command/verify.ts` — `runSweep(access)`, pure `verifyOutcome(action, after)`, constants `CC_APPROVAL_TTL_HOURS=72`/`VERIFY_AFTER_HOURS=4`/`VERIFY_BATCH_LIMIT=10`, `VERIFIABLE_ACTION_TYPES`, shared Meta budget-rounding helper (imported from meta.ts or co-located)
- `src/app/api/command/verify/route.ts` — POST, getCommandAccess-gated, maxDuration 60, returns `{expired, verified, drifted, checked}`
- `src/lib/command/accounts-list.ts` — `listUnifiedAccounts(access)` for the import destination picker
- `src/lib/command/__tests__/verify.test.ts` — verifyOutcome matrix (budget/pause/enable), drift cases, Meta cents-rounding, excluded types

**MODIFIED**
- `src/lib/command/types.ts` — `CcMetricsRange`, `CampaignMetrics`, optional `NetworkAdapter.listCampaignMetrics`
- `src/lib/command/networks/google.ts` — `listCampaignMetrics` (bulk aggregated GAQL)
- `src/lib/command/networks/meta.ts` — `listCampaignMetrics` (level=campaign insights) + extracted `conversionsFromActions` helper + exported budget-rounding helper
- `src/app/api/command/campaigns/route.ts` — `range` param + merge metrics + degrade-open
- `src/app/command/cuentas/cuentas-client.tsx` — 4 metric columns + 7d/30d toggle
- `src/lib/command/actions-repo.ts` — `expireStaleApproved`, `listVerifiableExecuted`, `recordVerificationDrift`, `listNovedades`
- `src/app/api/command/actions/[id]/approve/route.ts` — persist `conversions30d`/`spend30dMicros` into `expected` (inert to DRIFT gate)
- `src/app/api/command/actions/[id]/execute/route.ts` — TTL pre-check → expire + 409 (before executeAction; rail untouched)
- `src/app/command/acciones/page.tsx` — load sentinel portfolio + destination accounts; pass picker props
- `src/app/command/acciones/acciones-client.tsx` — multi-select + sequential batch approve/reject/execute (cap 20, progress, continue-on-block/stop-on-error), import pickers, sweep-on-mount, expired/verified filters, approve-time metrics display
- `src/app/command/page.tsx` + `src/app/command/resumen-client.tsx` — Novedades card (listNovedades counts + deep links) + sweep-on-mount trigger

**UNTOUCHED (the rail)** — `executor.ts`, `gates.ts`, `state.ts`, `request-hash.ts`, `executor-deps.ts`, `engine-import.ts`, `blueprint/*`, `edit/*`, `src/lib/schema.ts` (NO migration), `api/command/import-engine/route.ts`, `api/command/actions/[id]/{rollback,reject}/route.ts`, and both adapters' `buildMutation`/`execute`/`validate`/`buildRollback` paths.

Adversarial-critique summary (all four points the brief demanded): (1) verification never mutates and never double-runs destructively — READ-only snapshots + optimistic-guarded transitions + atomic set-based expiry + in-flight dedupe, bounded LIMIT 10; (2) no page-load latency blowup — metrics are on-demand (click), the sweep is fire-and-forget post-mount, so neither blocks first paint; (3) batch ordering/stop is sequential with continue-on-409 / stop-on-hard-error, distinct from the plan runner's stop-on-failure, cap 20, server gates authoritative; (4) migration CUT — no-migration proven feasible with code evidence (error:null-on-success + optimistic guards give one-shot verified/drift without new columns).

## New tables / migrations
- NONE — zero new tables, zero migrations, zero new columns. cc_actions/cc_blueprints rows ARE the Novedades inbox via status+filters: status='failed' (acción fallida), cc_blueprints.status='failed' (plan fallido), status='approved' + blocking gateResults (bloqueada en execute — executor re-stamps gateResults on the approved self-loop), status='executed' AND error IS NOT NULL (deriva), status='expired' (caducada).
- Drift is stored in the EXISTING cc_actions.error text column — VERIFIED safe because executeAction sets error:null on success and rollbackAction sets error:null, so error≠null on an 'executed' row unambiguously means drift, and the error-IS-NULL sweep filter makes it one-shot. Verification evidence for verified rows merges into the existing cc_actions.evidence jsonb (single write via the optimistic executed→verified guard; the engine never re-touches evidence on an executed row, so no clobber).
- cc_actions.expected jsonb absorbs approve-time conversions30d/spend30dMicros — inert to the DRIFT gate (VERIFIED: it reads only expected.status and expected.dailyBudgetMicros with !== undefined guards).
- REJECTED — a cc_events table (would need rail-touching writer hooks + per-user read-state + retention to duplicate already-queryable state); a cc_metrics cache table (on-demand bulk reads are 2 API calls/account); and the verified_at/verify_result column migration proposed by two lenses (the no-migration path is proven feasible, so the migration is not genuinely needed).
- cc_settings.watchHours is deliberately NOT bound; approval TTL uses a code constant CC_APPROVAL_TTL_HOURS=72 to keep watch-window and approval-TTL semantics decoupled and avoid CC_DRY_RUN-week aggressive expiry.

## Explicitly deferred
- External cron endpoint (/api/command/cron + CC_CRON_SECRET) — needs SUPABASE_SERVICE_ROLE_KEY (first RLS bypass in the repo, VERIFIED none exists today) + an external scheduler; add only if the lazy sweep proves insufficient. The runSweep function is scheduler-agnostic, so this is a thin later add.
- Email / Telegram notification channels — no mailer exists in the repo (VERIFIED); Telegram bot token is new config + external dep; both trivially layered onto listNovedades later as a fire-and-forget POST.
- Verification of creates (create_campaign/ad_group/adset/ad/budget/keywords) and add_negatives — would need an existsAll adapter method (Google per-service GAQL IN(...) grouping, Meta GET /{id}) wired to resultRef/latestDoneExecution; these stay 'executed' forever (fail-closed: never claim verified without evidence). This is the largest scope cut vs the verification-safety lens.
- Metrics caching (in-memory TTL or cc_metrics table); custom date ranges beyond 7d/30d; ROAS/conversion-value columns; ad-group-level metrics; Meta account-currency formatting lookup.
- Per-action metrics in Acciones beyond the free approve-time expected snapshot (would be N snapshot calls per page).
- Batched multi-id verification snapshots (one GAQL IN(...) per account) — the 10-action sweep cap makes it moot.
- Server-side batch endpoint; batch rollback (deliberate single-row friction); batch execute resume-after-tab-close; a 're-proponer' clone button for expired rows.
- Expiring stale 'proposed' rows (only 'approved' carries execution risk); binding cc_settings.watchHours as a per-workspace approval TTL.
- Per-user read/unread state or event-feed semantics for Novedades (state-based needs-attention count is the accepted design).
- run_at scheduled actions / dayparting — separate audit item, separate release.

## Top risks (design-acknowledged)
- GAQL zero-impression trap: adding segments.date to the ENTITY query silently drops campaigns with no impressions in range. Implementer MUST keep two Google queries (entity list + aggregated metrics) merged by campaign.id with zero-defaults, never collapse into one or inner-join.
- Meta budget drift compare must mirror the adapter's Math.round micros→cents conversion (via the ONE shared rounding helper); drifting that logic between meta.ts write and verify.ts read would false-drift every non-cent-round Meta budget.
- Verification compares CONFIGURED status, not Meta effective_status — a campaign can be ENABLED-configured but not delivering (payment/parent issues). 'verificada' means 'the write we intended landed', not 'delivering'. Documented scope; could mislead an operator.
- Lazy trigger blind spot: if nobody opens /command, nothing verifies or expires. Mitigated for the only timing-critical case by the execute-route TTL backstop; drift-detection latency is otherwise unbounded. The deferred cron endpoint is the escape hatch.
- Batch execute of up to 20 actions is a multi-minute sequential browser loop (each POST can take seconds, own 60s maxDuration). Leaving the page mid-loop strands the remainder as 'approved' (SAFE — nothing half-executes) but the operator may not notice; the confirm dialog and the persisted selection must make the stop obvious.
- Storing drift in cc_actions.error overloads a column that also holds execution-failure text — disambiguated ONLY by status (failed vs executed). A future code path that writes error on an executed row for another reason would corrupt the drift signal; keep recordVerificationDrift the sole writer of error on executed rows and pin this with a test.
- Novedades gate-blocked category depends on the GateResult JSON shape ({severity:'blocking',status:'fail'}); a gates.ts shape change would silently empty that category — add a test pinning the shape. The approved-row JS filter is bounded but watch p95 as cc_actions grows.
- Expiry runs even under CC_DRY_RUN: approvals older than 72h expire during rehearsal weeks and must be re-proposed. Arguably correct (baseline is stale) but will surprise during the beta protocol — call it out in release notes.
- The /command Novedades card adds a few indexed count queries to server render; cheap today on idx_cc_actions_status but monitor as volume grows, and consider moving to a client-after-mount fetch if p95 regresses.
