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
