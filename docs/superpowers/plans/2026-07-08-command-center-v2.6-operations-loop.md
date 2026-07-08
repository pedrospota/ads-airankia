# Command Center v2.6 — Operations Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the Command Center into a daily operating loop: performance metrics in Cuentas (both networks), batch approve/execute + import pickers in Acciones, and a lazy verification/expiry sweep feeding an in-app Novedades inbox — with ZERO migrations and the rail untouched.

**Architecture:** A sibling `listCampaignMetrics` adapter read (never widening EntitySnapshot); client-sequential batch over the EXISTING per-action endpoints (no new chokepoint); a READ-only `runSweep` (expiry = one atomic UPDATE; verification = capped snapshots + optimistic state transitions) triggered lazily from page mounts + an execute-route TTL backstop; Novedades = a pure query over cc_actions/cc_blueprints.

**Tech Stack:** Next.js 16.2.2, TS 5, Drizzle+pg, GAQL + Meta insights (mocked in tests), bun test.

**Spec:** `docs/superpowers/specs/2026-07-08-command-center-v2.6-operations-loop-design.md` — THE CONTRACT. Sections (a)-(e) carry exact signatures, semantics, Spanish copy and risk mitigations; implement them verbatim. The Top-risks section lists traps each task MUST avoid (GAQL zero-impression trap, Meta rounding mirror, drift-error single-writer, gateResults shape pin).

## Global Constraints

- Branch `feat/command-center-v26-ops` off main (e6c276b). NEVER push. Commit per task. bun `~/.bun/bin/bun`; tests `~/.bun/bin/bun test src/lib/command`; typecheck `~/.local/bin/bunx tsc --noEmit`. Explicit `git add <paths>` only.
- **ZERO migrations/new tables/new columns.** **Rail UNTOUCHED:** `executor.ts`, `gates.ts`, `state.ts`, `plan-runner.ts`, `blueprint/*`, `edit/*`, both adapters' buildMutation/execute/validate/buildRollback.
- **Verification NEVER mutates the networks:** READ-only snapshots + `transitionAction` (optimistic) + guarded UPDATEs. `recordVerificationDrift` is the SOLE writer of `error` on `executed` rows (pin with a test).
- **Reads fail OPEN (metrics errors degrade, campaigns still render); writes stay fail-closed.** Meta credential-less = existing 409/`—` display, zero new fail-closed code.
- Constants: `CC_APPROVAL_TTL_HOURS=72`, `VERIFY_AFTER_HOURS=4`, `VERIFY_BATCH_LIMIT=10`, `VERIFIABLE_ACTION_TYPES={budget_update,pause,enable}`, batch UI cap 20. es-MX copy. Routes `runtime="nodejs"`, `dynamic="force-dynamic"`, `getCommandAccess()`.

---

### Task 1: Metrics types + both adapters' listCampaignMetrics

**Files:** Modify `src/lib/command/types.ts`, `src/lib/command/networks/google.ts`, `src/lib/command/networks/meta.ts`. Test: extend `google-adapter.test.ts` + `meta-adapter.test.ts` (or the create test file — read which has the fetch-mock harness).

**Interfaces (spec §a, verbatim):** `CcMetricsRange = "7d"|"30d"`; `CampaignMetrics {entityRef, spendMicros, clicks, impressions, conversions}`; OPTIONAL `NetworkAdapter.listCampaignMetrics?(auth, accountRef, range)`.

- [ ] TDD: failing tests — google: ONE aggregated GAQL (`FROM campaign`, `segments.date DURING LAST_7_DAYS|LAST_30_DAYS` in WHERE only, NO segments in SELECT, `status != 'REMOVED'`), maps cost_micros/clicks/impressions/conversions by campaign.id; meta: ONE insights GET (`level=campaign`, `date_preset=last_7d|last_30d`, fields incl. actions), spend decimal→micros via `Math.round(Number(spend)*MICROS_PER_UNIT)`, conversions via the SHARED `conversionsFromActions` helper extracted from `insightsToSignals` (both call sites use it — regression-test snapshot signals too), follows `paging.next` at most once. Implement. Also EXPORT from meta.ts the budget-rounding helper `metaBudgetRoundMicros(micros) = Math.round(micros / MICROS_PER_MINOR_UNIT) * MICROS_PER_MINOR_UNIT` (Task 3 verification must mirror the adapter's write rounding — spec risk #2).
- [ ] Suite green (240) + new; tsc 0. Commit `feat(v2.6): listCampaignMetrics on both adapters + shared conversions/rounding helpers`

### Task 2: Campaigns route range+merge + Cuentas metrics UI

**Files:** Modify `src/app/api/command/campaigns/route.ts`, `src/app/command/cuentas/cuentas-client.tsx` (+ its `page.tsx` if props change).

- [ ] Route: `range` param (default 30d, validate enum), `Promise.all([listCampaigns, listCampaignMetrics?])`, merge by entityRef with ZERO-defaults for missing (spec risk #1: NEVER let the metrics read filter the entity list), metrics failure → `metricsError` string + campaigns still returned (degrade OPEN). UI: columns Inversión·Clics·Conv.·CPA (CPA "—" cuando conv=0; micros→unidades right-aligned, tabular-nums), 7d/30d segmented toggle in the card header (refetch on change), metrics cells "—" when absent, fetch stays on the existing "Ver campañas" click only.
- [ ] tsc 0; suite green; eslint clean on cuentas. Commit `feat(v2.6): campaign metrics in the loop — range merge + Cuentas columns`

### Task 3: verify.ts core + repo functions (the sweep)

**Files:** Create `src/lib/command/verify.ts`, `src/lib/command/__tests__/verify.test.ts`. Modify `src/lib/command/actions-repo.ts` (`expireStaleApproved`, `listVerifiableExecuted`, `recordVerificationDrift`).

**Implement spec §c verbatim:** constants; PURE `verifyOutcome(action, after): {verified, note?}` (budget_update compares payload micros for Google / `metaBudgetRoundMicros(payload)` for Meta — import the Task-1 helper; pause/enable compare `after.status`); `runSweep(access)` = expiry pass first (ONE atomic set-based UPDATE `approved→expired` older than 72h, with static `assertTransition("approved","expired")` sanity at module load) then verification pass (workspace-scoped, `executed_at < now-4h`, `error IS NULL`, type ∈ VERIFIABLE, oldest-first LIMIT 10; skip-without-stamping when `capabilities().read` false; per row ONE `adapter.snapshot()` → verified → `transitionAction(row,'verified',{evidence: merged verification stamp})`; drift → `recordVerificationDrift` (guarded UPDATE `WHERE id AND status='executed'`, Spanish note); read-error → skip untouched). Module-scope `sweepInFlight` promise dedupe + per-workspace `lastSweepAt` ~10-min throttle. NEVER calls executeAction/adapter.execute (grep-assert in a test if cheap).

- [ ] TDD: verifyOutcome matrix (google budget exact / meta budget rounded / false-drift case proving the rounding mirror / pause / enable / wrong status → drift note); expiry SQL via fake deps (only approved+old rows, atomic count); drift one-shot (`error IS NULL` filter) + sole-writer pin; skip-on-read-error leaves row retryable; sweep dedupe. Implement. Suite green; tsc 0.
- [ ] Commit `feat(v2.6): lazy verification sweep — expiry, verifyOutcome, drift (read-only, zero migrations)`

### Task 4: verify route + execute TTL backstop + approve expected enrichment

**Files:** Create `src/app/api/command/verify/route.ts`. Modify `src/app/api/command/actions/[id]/execute/route.ts`, `src/app/api/command/actions/[id]/approve/route.ts`.

- [ ] verify route: POST, gate, `maxDuration=60`, `runSweep(access)` → `{expired,verified,drifted,checked}`; errors → 500 (sweep is best-effort, never blocks UI). execute route: BEFORE `executeAction`, if row `approved` && `approved_at` older than `CC_APPROVAL_TTL_HOURS` → `transitionAction(...,'expired')` + 409 `"Aprobación caducada (>72h): vuelve a aprobar"` (route-level backstop; executor untouched). approve route: persist `conversions30d`/`spend30dMicros` from the approve-time snapshot into `expected` alongside status/budget (spec-verified inert to the DRIFT gate — extend the gates test asserting DRIFT ignores the extra keys).
- [ ] tsc 0; suite green (+ the DRIFT-inert test). Commit `feat(v2.6): verify endpoint + execute TTL backstop + approve-time metrics context`

### Task 5: listNovedades + Novedades card + sweep triggers

**Files:** Modify `src/lib/command/actions-repo.ts` (`listNovedades(workspaceIds)`), `src/app/command/page.tsx` + `resumen-client.tsx` (card + mount trigger), `src/app/command/acciones/acciones-client.tsx` (mount trigger only — batch is Task 6).

- [ ] `listNovedades`: the five state-based counts per spec §c (failed blueprints; failed actions; drifted = executed+error≠null; gate-blocked = approved rows whose `gateResults` contains `{severity:'blocking',status:'fail'}` — JS-filter the bounded set; expired), 7-day `updated_at` window, limit 50, workspace-scoped. TEST pinning the gateResults shape (spec risk: a gates.ts shape change must fail a test, not silently empty the category). Card on resumen: five counts, es-MX labels, deep links to `/command/acciones?filter=...` (implement the filter query-param read in acciones if absent), empty state «Sin novedades. Todo verificado y al día.» Sweep trigger: fire-and-forget `fetch('/api/command/verify',{method:'POST'})` on mount of resumen + acciones clients → `router.refresh()` if any counts changed.
- [ ] tsc 0; suite green; eslint clean. Commit `feat(v2.6): Novedades inbox (pure query) + lazy sweep triggers`

### Task 6: Acciones batch + import pickers + new filters

**Files:** Create `src/lib/command/accounts-list.ts` (`listUnifiedAccounts(access)`). Modify `src/app/command/acciones/page.tsx` + `acciones-client.tsx`.

- [ ] Spec §b verbatim: checkbox column + «Seleccionar visibles» (current status filter ⇒ verb-homogeneous selection); toolbar Aprobar/Rechazar seleccionadas (no confirm) + Ejecutar seleccionadas (ONE confirm: count, labels, budget-delta sum, «se ejecutan en orden, las bloqueadas se omiten»); SEQUENTIAL loop over the EXISTING per-id endpoints, cap 20, continue on 409 (row chip «bloqueada por compuertas», gate panel per row), STOP on non-409 error (summary «N ejecutadas · M bloqueadas · 1 error — proceso detenido», keep unprocessed selected), progress «3/7…». Import pickers: page.tsx loads sentinel `fetchPortfolio()` (best-effort → free-text fallback) + `listUnifiedAccounts`; the three inputs → two selects («Cuenta del motor», «Cuenta destino» filling connection_id+account_ref together); `import-engine` route untouched. Add `expired`/`verified` status filters + render drift rows red (executed + error≠null) with the note.
- [ ] tsc 0; suite green; eslint clean. Commit `feat(v2.6): batch approve/execute + import pickers + expired/verified filters`

### Task 7: Verification + deploy notes

- [ ] Full suite green (report count; expect ≥250) · tsc 0 · `bun run build` exit 0 (verify route present) · smoke on :4403 with beta env (login 200, `/api/command/verify` 403 anon).
- [ ] DEPLOY-NOTES section "v2.6 Operations Loop": no migration; lazy-sweep semantics (nothing verifies if nobody visits — deferred cron is the escape hatch); expiry runs under CC_DRY_RUN (approvals >72h re-propose during rehearsal weeks — expected); 'verificada' = the write landed, NOT delivering (Meta effective_status out of scope). Commit + report `git log --oneline main..HEAD`.

## Plan self-review
Spec §a→Tasks 1-2 (incl. zero-impression trap + degrade-open); §b→Task 6 (sequential/continue-on-409/stop-on-error, pickers, no batch endpoint); §c→Tasks 3-5 (sweep, backstop, Novedades incl. shape-pin test) + approve enrichment→Task 4; §e file plan fully covered; risks each mapped to a named test or constraint. Types consistent: `CampaignMetrics`/`CcMetricsRange` (T1) → T2; `metaBudgetRoundMicros` (T1) → T3; `runSweep` (T3) → T4/T5; `listNovedades` (T5) → resumen. No placeholders — steps carry the spec section + exact deltas.
