# Command Center v3.0 — SaaS-lite (roles/asientos, notificaciones externas, onboarding)

**Fecha:** 2026-07-08 · **Base:** main @ 7b9bca2 (v1, v2, v2.2, v2.3, v2.4, v2.6, v2.7 shipped)
**Objetivo (GAP-AUDIT Fase 4):** que sea seguro dar acceso a un SEGUNDO humano. Hoy todo está detrás de admin-email y quien entra al Command Center también obtiene /admin y /api/migrate. Tres entregables: roles/asientos, notificaciones externas (Telegram) sobre Novedades, y onboarding de miembros.

Diseño producido por panel de 3 lentes (auth-architecture, ruthless-YAGNI, admin-UX) + síntesis adversarial verificada contra el código real. Todo lo citado abajo fue verificado con lecturas directas del repo, no confiando en los lentes.

---

## §0 Headline verdict + adjudications

**Ship 2 roles, not 3.** Lens-1 and the task's binding bias both say `admin | operator`; lens-2 and lens-3 each invented a third tier (`viewer`, and lens-3's workspace-scoped `admin` distinct from platform-admin). I side with the binding bias and lens-1: viewer requires a *new* Supabase column (proven below — reusing the live `role` column is unsafe) so it is **not** "nearly free"; and a workspace-level admin tier contradicts the bias's explicit "admin = today's admins via BUILT_IN_ADMINS/ADMIN_EMAILS floor" — there is no third rank in slice-1.

**Where roles live: nowhere new.** `admin` = `isAdminEmail()` (unchanged). `operator` = the caller has ≥1 row in `workspace_members`, filtered through a **new allow-list env var** (`COMMAND_WORKSPACE_IDS`) — justified in the risk analysis below. Zero new Supabase columns, zero new tables for the role model itself.

**Adjudication 1 — role storage (lens-1 wins, lens-2 and lens-3 both have real defects).**
`src/lib/command/access.ts:26` already runs `db.from("workspace_members").select("workspace_id").eq("user_id", user.id)` — the exact same query `src/app/brands/page.tsx:19-21` runs today for **every logged-in user of the main airankia SaaS, admin or not**. That means "membership ⇒ can act" is not a hypothetical risk two of the lenses flagged in their RISKS sections — it is the **proven, already-shipped access model of the rest of the app**. Lens-1's "role lives nowhere new" is therefore not just YAGNI-minimal, it's the only option with zero new failure surface, because it reuses a read path already exercised in production every time someone opens `/brands`.
Lens-3's plan to `ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS role text ... CHECK (role IN ('admin','operator','viewer'))` is **broken**: lens-1 and lens-2 both independently report (via live Supabase queries) that `workspace_members.role` **already exists** with `CHECK role IN ('owner','member')`. `ADD COLUMN IF NOT EXISTS` against an existing column is a silent no-op — the CHECK clause in that statement never applies, and the code that assumes `role IN ('admin','operator','viewer')` would read stale `'owner'/'member'` strings. Lens-2's own "reusing the existing role column: rejected" analysis (conflates main-app ownership semantics with Command permissions, `is_workspace_owner()` is SECURITY DEFINER and load-bearing for the main app) is the correct argument, and it is the argument that sinks lens-3's plan.
Lens-2's own alternative (`command_role` nullable column + `pending_invites` table + `accept_pending_invites()` SECURITY DEFINER RPC) is technically sound but heavier than the task's bias tolerates for slice-1, and — more importantly — it requires trusting the *exact* shape of four live RLS policies (`is_workspace_owner`, `get_user_workspace_ids`) that could not be independently verified. We will not design new RLS policies and a SECURITY DEFINER function around unverified live policies. Lens-1's model needs **no new policy** because it never writes anything through the user's own RLS-scoped client for role purposes — invite writes go through a service-role client instead (§d).

**Adjudication 2 — notification dedup high-water-mark (lens-3 wins outright; lens-2 is factually wrong).**
`src/lib/schema.ts:687-704` — `ccSettings` has **no spare jsonb column**. `allowedActionTypes` is the only jsonb field and it is semantically taken (the action-type allow-list). Lens-2's "store the mark in existing cc_settings jsonb via saveCcSettings" is not just inelegant, it's impossible without a migration to add a column that doesn't exist. Worse: `src/lib/command/settings.ts:35-67` (`saveCcSettings`) does **read-current → merge in memory → whole-row upsert** with no optimistic lock — concurrent sweeps writing through it would race and clobber each other's mark. Lens-1's in-memory `Map` (mirroring `verify.ts:185-186`'s own `sweepInFlight`/`lastSweepAt`) is honest and correct but resets on every deploy, and this repo deploys **very** frequently. Lens-3's answer — a tiny new table `cc_notifications` with a `UNIQUE INDEX (workspace_id, kind, item_id)` and `INSERT ... ON CONFLICT DO NOTHING` — is dedup-safe **by the database itself** (the index is the lock, not app-level read-modify-write), survives restarts, and slots into a migration mechanism that already exists and is idempotent (`src/app/api/migrate/route.ts`, last migration `'010_command_center_v2_7'` — so `011` is the correct, uncontested next number). We override the "in-memory first" YAGNI lean here because both no-migration options are provably unfit, and the migration itself is two `CREATE ... IF NOT EXISTS` statements — the cheapest possible correct answer.

**Adjudication 3 — invite mechanism (lens-1/lens-3 win; lens-2's pending_invites is rejected).**
Confirmed: `src/app/login/page.tsx` has **only** `signInWithPassword` (client-side) and Google OAuth via `/auth/callback` (`src/app/auth/callback/route.ts:25,28` — `exchangeCodeForSession` then `redirect('/brands')`). No magic-link anywhere, no mailer anywhere (`grep -r resend/nodemailer/smtp` = empty), no service-role key anywhere (`grep -r SERVICE_ROLE src` = empty). Given admin = platform-admin-only in the 2-role model (not a per-workspace delegable role), the authorization question for "who may invite" collapses to a single `isAdminEmail()` check — no `pending_invites` + `is_workspace_owner()` RLS dance needed, because we are not letting a workspace owner (a main-app concept) self-serve invites. `auth.admin.inviteUserByEmail` (lens-1/lens-3) needs one new secret (`SUPABASE_SERVICE_ROLE_KEY`) but zero new tables, zero new RLS policies, and zero new SECURITY DEFINER functions running against a live shared table. Verified via `package.json:14` (`@supabase/supabase-js ^2.101.1`) that the Admin API this needs exists.

**Independent finding #1 (none of the three lenses caught this): the "Admin" nav item is not gated by `commandCenter` at all — it's gated by nothing.**
`src/components/app-sidebar.tsx:247-253` — the `"Cuenta"` nav group (containing `{ href: "/admin", label: "Admin" }`) lives in the **unconditional** `NAV_GROUPS` array. `navGroups(commandCenter)` (line 270-274) only ever *splices in* `COMMAND_GROUP` when `commandCenter` is true; it never filters the base groups. `src/components/app-shell.tsx:30-37` only computes `commandCenter`, nothing else. Net effect: **every authenticated user of the app, admin or not, Command-beta or not, already sees a link to `/admin` in the sidebar today** (same bug exists in `src/components/command-palette.tsx:59-61`, `DESTINATIONS` array). `/admin` itself still 401s via `getAdminUser()`, so this isn't a new hole — but it is directly adjacent to the file we must touch anyway (`app-shell.tsx`) to thread `role` down, so fixing it costs ~10 lines and directly serves adversarial requirement #1. Folded into the file plan.

**Independent finding #2 (also new): Meta ad accounts are not tenant-isolated by workspace at all — this is the sharpest reason the operator-workspace allow-list is not optional.**
`src/app/api/command/accounts/route.ts:33-37` — Google accounts are correctly scoped (`ads_google_connections` filtered by `.in("workspace_id", access.workspaceIds)`), but Meta accounts come from `metaAccountRefs()`, which reads **global env vars** (`META_AD_ACCOUNT_IDS`) with no workspace filter (`workspaceId: access.workspaceIds[0] ?? null` — the workspace tag is cosmetic). **Any operator, regardless of which workspace they were invited into, sees and can act on the exact same Meta accounts as every other Command user.** This means loosening `getCommandAccess` from admin-only to membership-based doesn't just risk one workspace's Google accounts leaking to unintended members of that workspace — it means a single careless invite anywhere hands the invitee write access to **every** Meta account the whole platform has ever configured. This is the concrete, evidence-backed reason for the `COMMAND_WORKSPACE_IDS` allow-list gate (§a) that none of the three lenses proposed: without it, "invite one teammate to one workspace" and "invite one teammate to the whole ad platform" are the same operation today.

**Independent finding #3: because we collapsed to 2 roles with a single `workspaceIds` scope (no separate `writableWorkspaceIds`), 17 of the 18 existing `/api/command/*` route files need ZERO code changes.** Every route already does `if (!access) return commandDenied()` and then trusts `access.workspaceIds` completely for both reads and writes (verified across all 18 files — identical two-line gate, zero per-verb checks anywhere). Since operator and admin have the *same permission shape* within their scope (only the scope's membership differs, further narrowed by the allow-list for operators), the security boundary is entirely enforced inside `getCommandAccess()` itself. Only `settings` POST needs a new line, only `verify` needs the notify hook, and one wholly new route (`equipo`) is added.

---

## §a Role model + storage + exact code changes

Two roles: `admin` (platform admin, unchanged definition) and `operator` (workspace member, newly enabled, allow-listed). No viewer in slice-1 — deferred (§e).

**`src/lib/admin.ts` — UNTOUCHED.** `BUILT_IN_ADMINS` (line 11), `ADMIN_EMAILS` (13-18), `isAdminEmail` (20-23), `getAdminUser` (26-33) stay byte-identical. This is the super-admin floor and it cannot regress.

**`src/lib/command/access.ts` — rewritten:**

```ts
import { cache } from "react";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { isAdminEmail } from "@/lib/admin";

export type CommandRole = "admin" | "operator";

export interface CommandAccess {
  email: string;
  userId: string;
  accessToken: string | undefined;
  role: CommandRole;
  workspaceIds: string[]; // full read+write scope for this role — no separate writable set needed with 2 roles
}

export function betaEnabled(): boolean {
  return process.env.COMMAND_CENTER_BETA === "true";
}

/**
 * Comma-separated workspace UUIDs where an operator seat may exist. Unset =
 * NO operator seats anywhere (fail closed to today's admin-only posture).
 * This is NOT optional hardening — src/app/api/command/accounts/route.ts
 * pulls Meta accounts from global env (metaAccountRefs()), not per-workspace
 * connections, so ANY operator sees the SAME Meta accounts as every other
 * workspace. Widening membership → operator without this allow-list means
 * "invite one teammate to one workspace" and "invite one teammate to every
 * ad account the platform has" are the same action. Admins are unaffected
 * (same idiom as ADMIN_EMAILS: additive, comma-separated, env-only).
 */
function operatorWorkspaceAllowlist(): Set<string> | null {
  const raw = process.env.COMMAND_WORKSPACE_IDS;
  if (!raw) return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// cache(): layout.tsx, app-shell.tsx, and (for the new equipo page) the page
// itself all need this per request. Today layout.tsx and app-shell.tsx each
// independently call auth.getUser() already; once both call the full
// getCommandAccess (auth + membership query), a per-request memo keeps that
// at ONE round trip instead of 2-3. React's cache() is the standard
// App-Router idiom for this.
export const getCommandAccess = cache(async (): Promise<CommandAccess | null> => {
  if (!betaEnabled()) return null;
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user?.email) return null;
  const admin = isAdminEmail(user.email);
  const { data: { session } } = await authClient.auth.getSession();
  const db = createSupabaseReadClient(session?.access_token);
  const { data: memberships } = await db.from("workspace_members").select("workspace_id").eq("user_id", user.id);
  let workspaceIds = (memberships ?? []).map((m) => String(m.workspace_id)).filter(Boolean);
  if (!admin) {
    const allow = operatorWorkspaceAllowlist();
    workspaceIds = allow ? workspaceIds.filter((id) => allow.has(id)) : [];
    if (workspaceIds.length === 0) return null; // fail-closed: not admin, no allow-listed membership
  }
  return { email: user.email, userId: user.id, accessToken: session?.access_token, role: admin ? "admin" : "operator", workspaceIds };
});

export function commandDenied(): NextResponse {
  return NextResponse.json(
    { error: betaEnabled() ? "no autorizado para el Centro de Mando" : "not found" },
    { status: betaEnabled() ? 403 : 404 }
  );
}

export function requireAdmin(access: CommandAccess): NextResponse | null {
  return access.role === "admin" ? null : commandDenied();
}
```

Cost: **zero extra Supabase queries** on the happy path (same single membership `select` as today). Fail-closed by construction: `CommandRole` is a 2-member union, so "unknown role" is not representable, and any non-admin with zero allow-listed workspaces gets `null` (the same 403/404 posture that already exists for non-admins today).

**`src/app/command/layout.tsx`** — replace the inline check with:
```tsx
const access = await getCommandAccess();
if (!access) notFound();
```
(Beta-flag check moves inside `getCommandAccess`, so behavior for the flag-off case is identical.)

**`src/components/app-shell.tsx`** — replace lines 30-37:
```tsx
const access = process.env.COMMAND_CENTER_BETA === "true" ? await getCommandAccess() : null;
const commandCenter = Boolean(access);
const isPlatformAdmin = access?.role === "admin";
```
and pass `isPlatformAdmin` alongside the existing `commandCenter` prop to `<AppSidebar>` and `<CommandPaletteMount>`.

**Note:** app-shell renders for ALL logged-in users, not just Command users — `isPlatformAdmin` must be computed even when `commandCenter` is false (an admin with the beta flag off still needs the Admin nav item). Compute it as `isAdminEmail(user.email)` from the already-available user when `getCommandAccess()` returns null.

**`src/components/app-sidebar.tsx`** — fix (finding #1): pull `{ href: "/admin", label: "Admin" }` out of the unconditional `"Cuenta"` group into a piece appended only when `isPlatformAdmin` is true, mirroring how `COMMAND_GROUP` is already conditionally spliced. `navGroups` gains an `isPlatformAdmin` parameter; `SidebarContent`/`AppSidebar` thread it the same way `commandCenter` is threaded.

**`src/components/command-palette.tsx`** — same fix: move `{ label: "Admin", href: "/admin", section: "Cuenta" }` out of the unconditional `DESTINATIONS` array into a new `ADMIN_DESTINATIONS` appended only when `isPlatformAdmin`.

---

## §b Route → minimum-role matrix

All 18 existing `/api/command/*` route files keep their current, unchanged `const access = await getCommandAccess(); if (!access) return commandDenied();` two-liner — **no further edits**, because scope enforcement now lives entirely inside `access.workspaceIds` (already the allow-listed set for operators). Only the rows marked **CHANGED** get a new line.

| Route | Verb(s) | Min role | Change needed |
|---|---|---|---|
| `/api/command/accounts` | GET | operator | none |
| `/api/command/campaigns` | GET | operator | none |
| `/api/command/actions` | GET, POST (propose) | operator | none |
| `/api/command/actions/[id]` | GET | operator | none |
| `/api/command/actions/[id]/approve` | POST | operator | none |
| `/api/command/actions/[id]/execute` | POST | operator | none |
| `/api/command/actions/[id]/reject` | POST | operator | none |
| `/api/command/actions/[id]/rollback` | POST | operator | none |
| `/api/command/blueprint` | GET, POST | operator | none |
| `/api/command/blueprint/[id]` | GET, PUT | operator | none |
| `/api/command/blueprint/[id]/approve` | POST | operator | none |
| `/api/command/blueprint/[id]/execute` | POST | operator | none |
| `/api/command/blueprint/[id]/rollback` | POST | operator | none |
| `/api/command/blueprint/suggest` | POST | operator | none |
| `/api/command/copiloto` | POST | operator | none |
| `/api/command/edit` | POST | operator | none |
| `/api/command/import-engine` | POST | operator | none |
| `/api/command/settings` | GET | operator | none |
| `/api/command/settings` | **POST** | **admin** | **CHANGED — 1 line: `if (access.role !== "admin") return commandDenied();`** |
| `/api/command/verify` | POST | operator | none (+ fire-and-forget notify hook, §c) |
| `/api/command/equipo` (**NEW**) | GET, POST, DELETE | **admin** | new file, `requireAdmin(access)` at top of every handler |
| `/admin`, `/api/admin/*`, `/api/migrate` | * | platform admin | none — `getAdminUser` untouched |

**Import-engine adjudicated `operator`** (overriding lens-1/lens-3 who put it at admin): it does the exact same thing as `POST /api/command/actions` (stage `cc_actions` rows, workspace-scoped, via `createActionDeduped`) — it never touches settings or platform config. It is a bulk-propose convenience; restricting it would defeat the point of adding an operator (the GAP-AUDIT's own framing: procesar el lote semanal del motor es exactamente el trabajo del operador). It is also not in the binding deny-list (`/admin`, `/api/migrate`, `settings`).

**Settings POST gets NO carve-out for a pause-only operator action.** A carve-out would need an exact-body-shape check to avoid smuggling a limit change alongside the pause (`settings/route.ts` applies whatever fields are present together). A flat `role !== "admin" → deny` has zero smuggling surface. A hardened, narrowly-scoped emergency-pause endpoint is a reasonable v3.1 add, not now.

**UI gating** (cosmetic only — every route above is the real wall): resumen kill-switch card — operator sees the badge, no buttons; acciones Aprobar/Ejecutar/Rechazar/Revertir stay visible to operator (operator IS allowed these verbs); Ajustes form hidden below admin; `/command/equipo` nav entry renders only for `access.role === "admin"`.

---

## §c Notifications — Telegram, per-item dedup, fired from the verify route

**Trigger point:** `verify.ts` states a READ-only-against-ad-networks contract and is pure/DI-tested (`VerifyDeps`). Polluting it with a network sender would couple it to Telegram availability. `src/app/api/command/verify/route.ts` is already a thin wrapper — the correct and only change:

```ts
const result = await runSweep(access);
void notifyNovedades(access).catch(() => {}); // never blocks or fails the sweep response
return NextResponse.json(result);
```

`verify.ts` stays byte-identical.

**Channel:** Telegram only. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (one shared ops chat for the beta — per-workspace chat IDs deferred). Optional `CC_NOTIFY_ENABLED=true` master switch and `NEXT_PUBLIC_APP_URL` (falls back to `https://ads.airankia.com`) for deep links. Missing `TELEGRAM_*` → silent no-op (one boot-time `console.warn`, matching the `META_*` "missing env ⇒ feature dormant" idiom). Email deferred — no mailer exists and Supabase's own invite email removes the onboarding need.

**Cadence: per-sweep, not a digest.** `SWEEP_THROTTLE_MS = 10 min` plus the sweep being *lazy* (only fires when a human loads `/command`) already bounds frequency — "instant" means "at most once per 10 minutes per scope, and only when someone is actually looking." Novedades are operational failures; a digest adds latency to exactly the wrong kind of event. Combined with per-item dedup, this cannot spam.

**Dedup: migration `011`, appended to `src/app/api/migrate/route.ts`** (idempotent `IF NOT EXISTS` idiom matching every prior migration):
```sql
CREATE TABLE IF NOT EXISTS cc_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  kind TEXT NOT NULL,
  item_id UUID NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_notifications_item ON cc_notifications(workspace_id, kind, item_id);
```
`notifyNovedades(access)`: calls `listNovedades(access.workspaceIds)` (reused verbatim — pure query). **Prerequisite:** `listNovedades`'s five sub-queries currently `select` only `{ id }` (and `{id, gateResults}` for the gated category) — no `workspaceId`, so there is nothing to key `cc_notifications` on per item today. Add `workspaceId` to each of the five selects (additive field on the returned item objects — non-breaking for existing consumers that only read `.id`). Then, per category with `count > 0`, attempt `INSERT ... ON CONFLICT DO NOTHING RETURNING id` for each item (bounded — `listNovedades` already caps at `NOVEDADES_ITEM_LIMIT`); only categories with at least one **newly inserted** row go into the message; if nothing new, send nothing. A still-open novedad does not re-notify every sweep. (Documented limitation: fixed-then-drifted-again on the same action id will NOT re-notify since it's the same `item_id` — acceptable for beta; cheap to special-case later by keying on `(item_id, error_hash)`.)

**Message (es-MX), deep-link convention reused from `command/page.tsx`:**
```
🛰 Centro de Mando — 3 novedades

❌ 2 acciones fallidas
   → https://ads.airankia.com/command/acciones?filter=failed
⚠️ 1 con deriva detectada
   → https://ads.airankia.com/command/acciones?filter=executed
🧩 1 plan fallido
   → https://ads.airankia.com/command/bitacora
```
Sent via `fetch` to `api.telegram.org/bot<token>/sendMessage` with `AbortSignal.timeout(5000)`; errors swallowed. The `cc_notifications` rows are inserted *before* the send, so a Telegram outage drops that batch rather than re-spamming on the next sweep — documented trade-off. `notify.ts` uses an injectable-deps shape (`insertIfNew`, `send`) mirroring `verify.ts`'s own `VerifyDeps` pattern for unit-testability.

---

## §d Invite / onboarding flow

**Authorization model:** admin = `isAdminEmail()` only. The entire "who may invite" question is one check: `requireAdmin(access)`. This sidesteps needing any new RLS policy — the write path uses a service-role client that bypasses RLS by design, gated by the application-level admin check that already exists and is proven.

**NEW `SUPABASE_SERVICE_ROLE_KEY`** env + **NEW `src/lib/supabase-admin.ts`**:
```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";

export function createSupabaseAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null; // equipo route returns 501 when unset — fail closed, discoverable
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } });
}
```
This is the **one genuinely new attack surface** of the whole slice (no service-role precedent in the repo today). Containment: this module is imported only by `equipo/route.ts`; never `NEXT_PUBLIC_*`; every handler re-checks `access.role === "admin"` before touching it.

**NEW `/api/command/equipo/route.ts`** (admin-only, all verbs):
- `GET ?workspaceId` → admin client selects `workspace_members` rows for the workspace, then resolves each `user_id → email` via `auth.admin.getUserById` (acceptable N+1 at beta membership scale — single digits; degrade gracefully if one lookup fails: partial results, never a 500).
- `POST { email, workspaceId }`:
  1. `admin.auth.admin.inviteUserByEmail(email, { redirectTo: \`${origin}/auth/callback\` })`. If it errors because the user already exists, fall back to locating them via `admin.auth.admin.listUsers()` (small user base) and use that `user_id`.
  2. `SELECT` the target `(workspace_id, user_id)` row via the admin client first (defensive — a `unique(workspace_id, user_id)` constraint on `workspace_members` was NOT confirmed, so `upsert`/`onConflict` is unsafe to assume); `INSERT` only if absent, with `role: 'member'` (satisfies the pre-existing `NOT NULL CHECK role IN ('owner','member')` constraint — **this value carries zero Command-permission meaning in this design**; Command only cares that the row exists, and the allow-list in `access.ts` decides everything else), plus `invited_by: access.userId`.
- `DELETE { workspaceId, userId }` → admin client removes the row. Guard: refuse if the target email is in `BUILT_IN_ADMINS`/`ADMIN_EMAILS` (they aren't membership-gated anyway — UX guard against a confusing no-op, not a security boundary).

**First-login path:** invite email (Supabase's built-in template — customize to es-MX in the Supabase dashboard; ops task, not code) → invitee sets a password → lands via the **existing, unmodified** `/auth/callback/route.ts` → `/brands`. Sidebar now shows "Centro de Mando" because `commandCenter` is keyed off `getCommandAccess()` (membership + allow-list), not `ADMIN_EMAILS` — zero env edits, zero restarts, for every subsequent invite once `COMMAND_WORKSPACE_IDS` is set once.

**Honest risk on this exact flow:** `auth.admin.inviteUserByEmail`'s exact landing UX (distinct "set password" step vs deep-link session) depends on Supabase project configuration not verifiable from the repo. **Recommended safer bring-up for the very first real operator:** skip the email invite — an admin pre-creates the `workspace_members` row directly (same `POST /api/command/equipo`, for a colleague whose Google-linked email is already known), and the person logs in with "Continuar con Google" (auto-links by verified email, zero new code path). Prove the `inviteUserByEmail` path with a throwaway address before promising anyone "check your inbox."

**No Supabase migration for the role/invite model itself** (only `011_cc_notifications`, an *ads*-Postgres migration — §c). `workspace_members` schema/RLS are read-only concerns for this design; the invite write path uses the service-role client precisely so it never depends on those unverified policies being exactly as claimed.

---

## §e Slice-1 vs deferred

**Slice 1 (this release):**
- `access.ts` role/allow-list rewrite (§a) — the only change that matters; everything else follows from it.
- `layout.tsx`, `app-shell.tsx`, `app-sidebar.tsx`, `command-palette.tsx` — role-aware gating, including the Admin-nav-leak fix.
- `settings/route.ts` POST → admin-only (1 line).
- `notify.ts` + migration `011_cc_notifications` + `verify/route.ts` fire-and-forget hook + `listNovedades` `workspaceId` field addition.
- `equipo/route.ts` + `supabase-admin.ts` + `/command/equipo` page (admin-only member list/invite/remove, es-MX).
- New envs: `COMMAND_WORKSPACE_IDS`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional `CC_NOTIFY_ENABLED`, optional `NEXT_PUBLIC_APP_URL`.

**Deferred:**
- Viewer role — needs a real new Supabase column (not "nearly free"); no read-only human exists in the beta yet.
- Proposer ≠ approver (two-person rule) — `cc_actions.createdBy`/`approvedBy` and `cc_settings.requireTwoStep` are already the seam; v3.1 is one check in the approve routes. Single-operator beta reality makes forcing it now counterproductive.
- Email notification channel — no mailer exists; Telegram covers it.
- Per-workspace Telegram chat IDs / true multi-tenant notification routing — one shared ops chat first.
- `/command/equipo` self-serve by operators — admins invite, operators operate.
- Meta per-workspace connections (fixing finding #2 properly) — pre-existing, larger, GAP-AUDIT-flagged item; **the `COMMAND_WORKSPACE_IDS` allow-list is the stopgap, not the fix.**
- Billing — explicitly out of scope.

---

## §f File plan

**NEW:**
`src/lib/supabase-admin.ts` · `src/lib/command/notify.ts` · `src/app/api/command/equipo/route.ts` · `src/app/command/equipo/page.tsx` (+ client component, admin-only render) · tests: `access.test.ts` (role/allow-list matrix, fail-closed cases), `notify.test.ts` (dedup insert semantics).

**MODIFIED:**
`src/lib/command/access.ts` (role + allow-list + `cache()`) · `src/app/command/layout.tsx` · `src/components/app-shell.tsx` · `src/components/app-sidebar.tsx` (Admin-item conditional) · `src/components/command-palette.tsx` (same fix) · `src/app/api/command/settings/route.ts` (1 line, admin-only POST) · `src/app/api/command/verify/route.ts` (fire-and-forget notify) · `src/lib/command/actions-repo.ts` (`listNovedades` — add `workspaceId` to 5 selects) · `src/app/api/migrate/route.ts` (append migration `011_cc_notifications`) · `src/lib/schema.ts` (add `ccNotifications` table def) · DEPLOY-NOTES (new envs + explicit "set `COMMAND_WORKSPACE_IDS` before inviting anyone" callout).

**UNTOUCHED (load-bearing, on purpose):**
`src/lib/admin.ts` (`BUILT_IN_ADMINS`/`getAdminUser` floor) · `src/lib/command/verify.ts` (pure, boot-asserted, byte-identical) · `state.ts`, `gates.ts`, `executor.ts` · 17 of 18 existing `/api/command/*` route files · all `/api/admin/*` + `/api/migrate` gating · `/security/equipo/page.tsx` (stays the activity scorecard — login-gated only, unrelated to membership, wrong place for team management) · `src/app/login/page.tsx`, `src/app/auth/callback/route.ts` (invite flow rides the existing OAuth/password paths untouched) · `workspace_members` schema/RLS (no Supabase migration).

---

## §g Risks to pin with tests

1. **Operator reaching `/admin`/`/api/migrate`/settings:** structural — `getAdminUser` untouched and independent of `getCommandAccess`; settings POST explicit role check; Admin nav no longer rendered for non-admins. **Test:** operator hitting `POST /api/command/settings` → 403; `navGroups(true, false)` (operator) never contains `href: "/admin"`.
2. **Fail-open on missing/unknown role:** structurally impossible — `CommandRole` is a 2-member union; `getCommandAccess` returns `null` (not a default role) the moment a non-admin has zero allow-listed workspaces. **Test:** a user with a `workspace_members` row for a workspace NOT in `COMMAND_WORKSPACE_IDS` gets `null`, not an empty-scope operator object.
3. **Allow-list misconfiguration (deploy-time human risk):** unset = zero operator access (safe, matches today); set to the WRONG workspace UUID = every member of that workspace instantly becomes an operator with the shared-Meta blast radius of finding #2. **Runbook step, not a test:** before setting the env, enumerate `workspace_members` for the target workspace and confirm every listed email is expected to get Command access.
4. **Notification spam/loss:** dedup is DB-unique-index-safe. **Tests:** two concurrent `notifyNovedades` calls for the same item → exactly one row, one send; a failed Telegram `fetch` still leaves the row inserted → no re-send next sweep (intended behavior — assert it).
5. **Invite self-escalation to admin:** structurally impossible — `admin` derives purely from `isAdminEmail()` (env + hardcoded list), never from any DB row. The equipo route can only ever create operator-tier access. **Test:** post-invite, `getCommandAccess()` for the invitee returns `role: "operator"`; no code path reads any DB value into `role: "admin"`.
6. **Pre-existing (flagged, not fixed here):** `saveCcSettings` read-merge-upsert race — two admins saving different fields in the same second can clobber each other. Follow-up ticket.
7. **Equipo GET N+1 `getUserById`:** fine at beta scale; **test:** one failed `user_id` lookup degrades to partial results, never a 500.
