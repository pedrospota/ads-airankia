# Deploy — Centro de Mando (beta)

Feature branch: `feat/command-center-beta`. **Do NOT merge to main without Pedro's explicit go** (main auto-deploys to prod app `tk8s8s4k44s8co8ow8cw8koo` on airankia-suite / Coolify airankia).

## What shipped (Tasks 1–15, all committed + reviewed)

An internal-only, beta-flagged **Centro de Mando**: a multi-network (Google Ads + Meta Ads) L2 execution rail that lets an admin operator queue optimization actions, gate them through 12 deterministic pre-flight checks, execute approved actions against the ad networks via API, record every mutation in an append-only ledger, and roll back with one click. This is the first time the platform writes to ad accounts through the command center — always two-step (approve → execute), never through the existing propose-only surfaces (gads-sentinel, Copiloto) or the campaign-creation wizards, which are untouched.

Surfaces: sidebar group "Centro de Mando" → Resumen (kill switch + caps), Acciones (approve/execute queue with live gate-block panel + engine import), Cuentas (account/campaign browser → propose actions), Bitácora (flight recorder with before/after + rollback). Plus a Meta status card in Conexiones.

## Verification status (at commit e85622b)

- `bun test src/lib/command` → **61 pass / 0 fail**
- `bunx tsc --noEmit` → **exit 0** (whole project)
- `bun run build` (Next 16 / Turbopack) → **exit 0**, in-build TypeScript clean, 13/13 static pages, all `/command/*` + `/api/command/*` routes present
- Runtime smoke (dev server, `COMMAND_CENTER_BETA=true`, no session): `/command/*` → **404** (layout `notFound()` gates non-admins), `/api/command/actions` → **403** (`commandDenied`), `/login` 200, `/brands` 307 — gating fails safe, no crashes
- Every task passed an adversarial spec + quality review; the process caught and fixed 5 real runtime bugs (Google field-mask casing, partial-index ON CONFLICT, gate-results self-loop, executor stranding window, interrupted Meta-card wiring)

## Release steps (in order)

1. Merge `feat/command-center-beta` → main → Coolify auto-deploys.
2. Set Coolify **runtime** env vars on the app:
   - `COMMAND_CENTER_BETA=true`
   - `CC_DRY_RUN=true` **(keep on for the first week — every execute becomes a validate-only rehearsal; nothing mutates)**
   - Meta (only when activating Meta — see below): `META_SYSTEM_USER_TOKEN=<system user token>`, `META_AD_ACCOUNT_IDS=act_xxx,act_yyy`, `META_API_VERSION=v25.0` (verify latest GA on Meta's changelog first; do not go below v25.0), and `META_APP_SECRET=<app secret>` once Task 16 lands.
   - Reused (already set for the existing app): `CONNECTIONS_KEY`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_API_VERSION`, `ADS_DATABASE_URL`, the Supabase pair, `ADMIN_EMAILS`.
3. **Run the migration**: `POST /api/migrate` (logged in as an admin) → confirm `007_command_center` appears in `schema_migrations` and tables `cc_actions` / `cc_executions` / `cc_settings` exist.
4. With `CC_DRY_RUN=true`: exercise the whole flow on an internal Google account — Conexiones (connect + enable + "Usar como fuente del motor") → Cuentas (browse campaigns) → propose a pause → Acciones (Aprobar → Ejecutar = a dry-run rehearsal) → confirm a validate-only row appears in Bitácora.
5. First **real** execution: set a minimal budget_update on one internal Google account, verify in the Google Ads UI, then Revertir and verify the rollback. Confirm the Bitácora before/after and the `cc_executions` ledger row.
6. Remove `CC_DRY_RUN` only after the Bitácora has ≥1 clean week.

## Google is v1; Meta is credential-gated

Google Ads works today (OAuth client, developer token, MCC, and per-workspace connections all exist). Meta ships **read/none until credentials exist** — `capabilities().write` is false without `META_SYSTEM_USER_TOKEN`, and the UI shows "pendiente de credenciales." **Pedro action to activate Meta:** in Meta Business Manager → System Users, create a system user with `ads_read` + `ads_management` on the target ad accounts, generate a token, set the Meta env vars above.

## Outstanding before external/broader exposure (non-blocking for the internal Google beta)

These are tracked and safe to defer, but do them before Meta goes live / before any non-owner admins:

1. **Task 16 — Meta pre-live hardening**: add `appsecret_proof` (HMAC-SHA256 of the token) on every Meta call when `META_APP_SECRET` is set (required if the Meta app enforces app-secret-proof for system-user tokens — otherwise calls 401); widen `CONVERSION_ACTIONS` in `meta.ts` (add `omni_lead`, `onsite_conversion.purchase`, etc.) so `conversions30d` isn't undercounted (avoids false-positive TRACKING_SIGNAL on lead-gen accounts); remove the dead `CcActionInput` import.
2. **Connection-workspace cross-check (defense-in-depth)**: in `POST /api/command/actions` and `/import-engine`, verify the body-supplied `connection_id` belongs to the validated workspace before insert (fail 400). Dead-end today because `auth.resolve` re-checks via RLS at use time, but tighten anyway.
3. **Confirm RLS** is enabled on `ads_google_connections` (couldn't be verified during review — Supabase MCP was down): `select relrowsecurity from pg_class where relname='ads_google_connections';` + check `pg_policies`. Strongly corroborated: the existing prod Conexiones / `engine-source` feature already relies on the same policy, so if it weren't enabled that feature would already be leaking tokens.

## Sacred invariants (do not regress)

Read-only gads-sentinel + Copiloto candado de escritura untouched; campaign-creation paths untouched; command-center Google writes use per-workspace connected-account tokens (never the platform's own `GOOGLE_ADS_REFRESH_TOKEN`); tenancy = airankia Supabase RLS; the `/api/command/actions/[id]/execute` route is the single mutation chokepoint.

---

# Command Center v2 — Guided Google Search Builder (create flow)

v2 adds a full guided UI to CREATE (and later edit) a Google Search campaign, compiled onto the **untouched v1 rail** (gates → single `executeAction` chokepoint → ledger → rollback). Every created entity is born **PAUSED**.

## Migration (run once, after deploy)

`POST /api/migrate` (admin-gated) picks up **`008_command_center_v2`**: creates `cc_blueprints`; adds `blueprint_id/seq/local_ref/result_ref` to `cc_actions`; and appends the 5 `create_*` types to existing `cc_settings.allowed_action_types`. Idempotent (`IF NOT EXISTS` / `ON CONFLICT`). Verify: `select count(*) from cc_blueprints;` succeeds and `select allowed_action_types from cc_settings limit 1;` includes `create_campaign`.

## How the create flow runs

1. Operator builds a blueprint at **`/command/crear`** (manual + per-field ✨ AI via `/api/command/blueprint/suggest`). Draft persists via `POST/PUT /api/command/blueprint`.
2. **`/command/crear/[id]/revisar`** shows every compiled action grouped by tree node + a **proactive deterministic gate preview** (validateOnly is deferred — it needs real resourceNames, so it runs at publish).
3. "Publicar en pausa" → `approve` (compiles blueprint → `cc_actions` status `proposed`→`approved`) → `execute` (the plan runner loops over the single per-action `executeAction` chokepoint, resolving `tmp:` refs to real resourceNames between actions, stop-on-first-failure). Success → Bitácora. A gate block → 409 with the blocked gates.
4. Rollback: reverse-seq `remove_entity` per created entity (create_campaign rollback removes the campaign; its criteria cascade).

## Preconditions to actually publish

- `COMMAND_CENTER_BETA=true` + admin email (same gate as v1 `/command/*`).
- A **connected Google account** with an **ENABLED conversion action** — the builder's automated bidding (MAXIMIZE_CONVERSIONS / TARGET_CPA / TARGET_ROAS) needs conversion tracking; a no-conversion account will surface it at the validateOnly step on publish.
- `connection_id` must belong to the caller's workspace (the create route enforces this, mirroring v1).
- The campaign is created **PAUSED**. Nothing serves until the operator **enables it in the Google Ads UI** after reviewing the built campaign there. (There is no auto-enable; the existing Acciones/enable path can flip it later.)

## Known limitations (safe to ship internal beta; address before broad exposure)

- **No DB transaction** wrapping the repo's compile (delete-then-insert) and approve (two writes). Bounded/self-healing: the action insert is a single atomic batched statement; approve sets blueprint status LAST; partial states recover on retry. First transaction usage in the codebase would close it fully.
- **Gate preview is deterministic-only** (validateOnly runs at publish). `create_campaign` geo/language are applied as a second `campaignCriteria:mutate` after the campaign create — an unmapped country code is caught at the validate gate (pre-mutation), and a transient step-2 failure triggers a compensating delete of the just-created campaign (atomic create).
- **Settings allow-list:** `create_*` types are permitted via `CC_SETTINGS_ACTION_TYPES` (load + save). The v1 manual-action route still rejects `create_*` — creates ONLY come through the blueprint flow.

## Verification status (this build)

`bun test src/lib/command` → **130 pass / 0 fail**; `tsc --noEmit` → exit 0; `bun run build` → exit 0 (routes `/command/crear`, `/command/crear/[id]/revisar`, `/api/command/blueprint/*` all present); runtime smoke on the production build → `/command/crear` 404 (page gated), `/api/command/blueprint` + `/suggest` 403 (denied), `/login` 200. Every task adversarially reviewed; the review chain caught and fixed a feature-breaking `ACTION_ALLOWED` bug (settings stripped `create_*` on load) and two serious adapter bugs (create-rollback ref mismatch, campaign-orphan on criteria failure).

## CC_DRY_RUN and multi-action blueprints

`CC_DRY_RUN=true` makes `executeAction` return no `resourceNames`, so the plan runner can't resolve a child's `tmp:` ref from its parent and fails closed ("Ref temporal sin resolver"). Dry-run therefore rehearses single actions, not a full multi-action blueprint. This is safe (no live mutation, fails closed) — use `CC_DRY_RUN` for the v1 per-action rehearsal; rehearse the create flow with a throwaway campaign on a real test account (it's created PAUSED and one-click rollbackable).

---

# Command Center v2.3 — Edit Mode (slice 1)

Edit a LIVE Google Search campaign through the same rail. **No migration needed** — edit sessions reuse `cc_blueprints` with an in-doc `docType: "google_search_edit_v1"` discriminator. Zero new action types; `types.ts`/`gates.ts`/`executor.ts`/`plan-runner.ts` untouched.

## Flow
Cuentas → «Editar» on a Google SEARCH campaign → `POST /api/command/edit` loads the live tree (4 GAQL reads) into a server-owned edit doc → workbench at `/command/editar/[id]` (budget, statuses, add negatives/keywords/RSAs, RSA refresh) → `/revisar` shows Antes→Después per action + deterministic gate preview → «Aplicar cambios» = approve (recompiles via the differ, TTL-checked) → execute (plan runner, stop-on-first-failure) → Bitácora.

## Edit surface (slice 1)
budget (`budget_update`, locked for shared budgets) · campaign/ad-group status (`pause`/`enable`) · add campaign negatives (`add_negatives`) · add keywords/negatives to an existing group (`create_keywords`, real parent ref) · add RSA (`create_ad`) · **RSA refresh** = create new + pause old (Google RSAs are API-immutable). Deferred: removals (needs a user-facing remove verb), renames, bidding/geo/CPC edits, new ad-group subtrees, non-SEARCH.

## Staleness honesty (operator-facing truth)
DRIFT protects ONLY status+budget of the entity each action touches (field-scoped `expected` stamped at load time; `mergeEditDoc` keeps the baseline server-owned). Creates get ZERO DRIFT protection — concurrent structural changes are caught only by Google validateOnly + stop-on-first-failure. Belt: a baseline older than 60 min refuses to compile («Baseline caducado») — TTL validated BEFORE any destructive recompile step.

## Failure recovery
RSA replace has a create-succeeds/pause-fails window = transient double-serving (never zero enabled ads — a failed create means its paired pause never runs). Any partial failure leaves the blueprint `failed`: recovery = «Revertir lo aplicado» (reverse-seq rollback of executed actions) or leave-as-is. A `failed` edit blueprint cannot be re-executed (status machine) — re-edit from Cuentas.

## Verification (this build)
170 tests / 0 fail · tsc exit 0 · build exit 0 (`/command/editar/[id]`, `/revisar`, `/api/command/edit` present) · smoke: login 200, editar 404-gated, edit API 403-denied. Every task adversarially reviewed; the differ's two safety properties (enabled-ad-count never decreases from a failure; field-scoped DRIFT baselines) held under adversarial probing.


---

# Command Center v2.2 — Meta Create Flow (slice 1)

Create a full Meta campaign (campaign → ad set → link ads) on the same rail, **born PAUSED at two levels** (campaign AND ad set, both gate-enforced). Built entirely with mocked credentials — **creation is IMPOSSIBLE in production until the env vars below exist** (capabilities switchboard withholds the create verbs; VALIDATE_ONLY additionally fails closed without a rehearsal).

## Activation (in order)
1. Run `POST /api/migrate` → applies **`009_command_center_v2_2`** (adds `create_adset` to `cc_settings.allowed_action_types` + column default; idempotent).
2. Set in Coolify: `META_SYSTEM_USER_TOKEN` (system user, ads_management), `META_APP_SECRET`, `META_PAGE_ID` (the page ads publish under), `META_AD_ACCOUNT_IDS` (comma-separated `act_...` allowlist). Redeploy.
3. `/command/crear-meta` (entry card on /command) — until step 2, it shows "pendiente de credenciales".

## Slice-1 shape
OUTCOME_TRAFFIC only · ABO (budget on the ad set) · geo = country enum MX/US/AR/CO/CL/PE + age 18-65 (advantage_audience off) · single-image-less link ads (inline creative; imageUrl optional → link_data.picture) · special_ad_categories always `[]`. Money: the rail is MICROS end-to-end; cents exist only inside `meta.ts` (`microsToCents` throws on any non-whole-cent value; CURRENCY_SANITY catches a cents-as-micros 100x slip).

## Rollback
Reverse-seq `remove_entity` → `DELETE /<id>` (ad → adset → campaign). Inline-created AdCreatives are NOT deleted (inert, account-level).

## First-live-run checklist for Pedro (mocked assumptions to verify on the first credentialed run)
1. **Access tier:** the app needs Ads Management **Standard Access** (`ads_management`); Development tier throttles hard and only reaches admin-owned ad accounts.
2. **Creative image:** confirm `object_story_spec.link_data.picture` accepts a raw https URL for `OUTCOME_TRAFFIC` link ads AND that an imageless link ad (og:image scrape) is accepted — else make `imageUrl` required in the schema.
3. **validate_only:** confirm `execution_options=["validate_only"]` is honored on `POST /campaigns`, `/adsets`, `/ads` and returns actionable errors (not a silent pass).
4. **Delete:** confirm `DELETE /<id>` works for campaign/adset/ad — else switch rollback to `POST status=DELETED`.
5. **Delivery gate:** confirm a PAUSED campaign delivers nothing, and that enabling the campaign while the adset is PAUSED does NOT deliver; confirm the intended enable order (campaign → adset).
6. **special_ad_categories:** confirm `[]` is correct for the target campaigns (none are HOUSING/EMPLOYMENT/CREDIT/FINANCIAL) — else a policy violation.
7. **targeting_automation.advantage_audience:0** is accepted and disables audience expansion (reviewed geo/age is exactly what runs).
8. **app-secret-proof:** if the Meta app enforces "Require app secret proof for server API calls", `META_APP_SECRET` MUST be set or every call 401s. This design gates create capability on `META_APP_SECRET`; relax that gate if proof is not enforced.
9. **Non-EU / DSA:** confirm targeting the slice-1 countries `{MX,US,AR,CO,CL,PE}` needs no `dsa_beneficiary`/`dsa_payor` fields.
10. **Budget floor:** confirm the ≥1-unit (`MICROS_PER_UNIT` = 100 cents) schema floor clears Meta's per-currency/per-account `daily_budget` minimum for the target account.
11. **Inline creatives** created via `object_story_spec` are NOT deleted on rollback (inert, account-level) — confirm acceptable / no clutter accrual.
12. **API version:** `META_API_VERSION=v25.0` is still GA (do not go below).

## Verification (this build)
240 tests / 0 fail · tsc exit 0 · build exit 0 (`/command/crear-meta` present) · smoke 200/404/403. Every task adversarially reviewed; the review chain also closed a pre-existing cross-compiler smuggling hole (blueprint POST now rejects docs carrying a docType) and caught a review-page dispatch gap that would have blocked every Meta publish.

---

# Command Center v2.6 — Operations Loop

**No migration.** Turns the rail into a daily operating center: performance metrics in Cuentas (Inversión/Clics/Conv./CPA, 7d/30d, both networks — Meta shows «—» until credentials exist), batch approve/reject/execute in Acciones (sequential over the existing per-action endpoints, continue-on-gate-block, stop-on-error, cap 20), import pickers, and the verification loop.

## The verification loop (lazy, read-only)
Visiting /command or /command/acciones fires a fire-and-forget sweep (`POST /api/command/verify`, 10-min throttle): (1) approvals older than **72h** expire (`Aprobación caducada — vuelve a aprobar`; also enforced at execute time as a backstop); (2) up to 10 executed actions ≥4h old are re-read from the network — the write landed → `verified` (green); it didn't → the row is marked **con deriva** (red, one-shot) for Revertir/manual fix; unreadable/absent fields → skipped and retried. The sweep NEVER mutates the networks. «Verificada» means *the write we intended landed*, not *delivering* (Meta effective_status out of scope).

## Novedades
The /command resumen shows a needs-attention card (pure query, no new tables): Planes fallidos · Acciones fallidas · Con deriva · Bloqueadas por compuertas · Caducadas — deep-linking into filtered Acciones. It clears itself when rows are resolved.

## Caveats
- Lazy trigger: if nobody opens /command, nothing verifies/expires (execute-time TTL backstop covers the risky case). External cron endpoint is the deferred escape hatch.
- Expiry runs under CC_DRY_RUN too: rehearsal-week approvals >72h will expire and need re-proposing — expected, the baseline is stale.

## Verification (this build)
285 tests / 0 fail · tsc exit 0 · build exit 0 (`/api/command/verify` present) · smoke 200/403. Adversarial reviews caught and fixed: a false-drift bug on null budget snapshots (would have stickily flagged healthy CBO campaigns), a poison-pill auth failure that could livelock the sweep, a zero-defaults display contract violation, a range-toggle race, and a stale-props table after refresh.

---

# Command Center v2.7 — Weekly Loop Completo

**Migration 010 required** (`POST /api/migrate`, settings-only, idempotent): adds `update_keyword_status`, `update_cpc`, `remove_negatives` to `allowed_action_types` + column default. Zero structural DB change.

## What's new
- **Podar desde el workbench:** live keywords get Pausar/Reactivar (reversible — pause-over-remove by design); campaign negatives get Quitar (rollback re-creates them via the recorded text/match). New blocking gate **CPC_DELTA** (reuses `maxBudgetDeltaPct`); `update_cpc` per ad group with «puja automática» lock when no manual bid exists.
- **Promotion note:** `remove_negatives` is now user-proposable (faces ACTION_ALLOWED normally); `remove_entity` remains the ONLY internal verb. The rollback-of-add_negatives path is unaffected (pinned by test).
- **Reporte a cliente:** Bitácora gains «Exportar CSV» (200 rows, BOM/RFC-4180) + `/command/bitacora/reporte` — the printable weekly «qué cambiamos y por qué» grouped Cuenta→Campaña.
- **Scheduling (run_at) DEFERRED** — no invariant-clean unattended trigger exists (the verify sweep is READ-only by contract; page-load mutation rejected; external cron needs a service-role auth story). Escape hatch: a future background executor.

## Verification (this build)
372 tests / 0 fail · tsc 0 · build 0 (`/command/bitacora/reporte` present) · smoke 200/404. Reviews caught+fixed a HIGH blast-bound bypass (spoofed keyword status could over-cap a batch then brick the draft — mergeEditDoc now re-validates the merged doc against server truth).

---

# Command Center v2.4 — Copiloto Anclado

**No migration.** A docked AI copilot («✦ Copiloto», bottom-right pill) in the Google builder AND the edit workbench. The covenant: **AI proposes → human accepts → gates enforce.** The model's ONLY effect channel is a proposal card; Accept runs the pure `applyBlueprintPatch` chokepoint (writable-fields registry + full-doc re-parse) against the live draft, then the normal autosave/server re-validation/rail applies. No AI code path imports the executor/gates.

## Provenance (dato/ia/auto)
Fields set by an accepted proposal (or an accepted ✨ suggestion) carry an **IA** badge; editing one manually downgrades it (the badge disappears — «Sin etiqueta = escrito por ti»). Edit baselines show **Dato**. AI-touched nodes compile with `source: 'copiloto'` in the ledger (visible as Origen in Acciones).

## Operational notes
- Requires `OPENROUTER_API_KEY` (already in prod). Bounds: 6 tool rounds / 30s / 2048 tokens / ≤3 proposals per reply / ≤20 ops per proposal. Never-Anthropic model guard mirrors /api/copiloto.
- The dock appears once a draft is saved (it grounds against the stored blueprint).
- The legacy /copiloto page now runs on the same extracted tool-loop (behavior-preserved).
- Deferred: Meta dock, live-metrics tool, v2.5 chat-entry, per-item array provenance, create-side ad-group CPC patches (removed fail-closed until the builder carries the field).

## Verification (this build)
500 tests / 0 fail · tsc 0 · build 0 (`/api/command/copiloto` present) · smoke 200/403. Reviews caught+fixed: prototype-chain field names crashing the chokepoint, a provenance-identity mismatch that would have mislabeled every AI edit as manual, and the silent-drop cpcMicros gap.
