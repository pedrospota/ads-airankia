# Command Center v3.0 — SaaS-lite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it safe to give a second human access — 2 roles (admin/operator) with a workspace allow-list, Telegram notifications on Novedades with DB-enforced dedup, and an admin-only Equipo page to invite/remove members.

**Architecture:** The entire security boundary moves inside `getCommandAccess()` (role + `COMMAND_WORKSPACE_IDS` allow-list, fail-closed); 17 of 18 existing `/api/command/*` routes need zero changes. Notifications fire fire-and-forget from the verify ROUTE after `runSweep` (verify.ts stays byte-identical) and dedup via a `cc_notifications` unique index (`INSERT … ON CONFLICT DO NOTHING` is the lock). Invites use the Supabase Admin API behind a new service-role client, gated by `requireAdmin`.

**Tech Stack:** Next.js 15 App Router, TypeScript, bun test, Drizzle (ads Postgres), Supabase (auth + workspace_members), Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-07-08-command-center-v3.0-saas-lite-design.md` (the authority for every decision below).

## Global Constraints

- `src/lib/admin.ts` and `src/lib/command/verify.ts` stay **byte-identical**. `state.ts`, `gates.ts`, `executor.ts` untouched.
- 17 of the 18 existing `/api/command/*` route files are NOT edited. Only `settings/route.ts` (POST admin gate) and `verify/route.ts` (notify hook) change; `equipo/route.ts` is new.
- Fail-closed everywhere: unset `COMMAND_WORKSPACE_IDS` = zero operator seats; unset `SUPABASE_SERVICE_ROLE_KEY` = equipo route 501; missing `TELEGRAM_*` = notifications silently off.
- `CommandRole` is exactly `"admin" | "operator"` — no third value, no default role.
- All user-facing copy in es-MX.
- Tests: `bun test` (all existing 500 must keep passing) + `bunx tsc --noEmit` clean, per task.
- Commits: explicit `git add <paths>` only — never `git add -A`.
- No `package.json` changes anywhere in this plan (so no lockfile regen needed).
- New envs introduced (documented in Task 7, set at deploy time, never committed): `COMMAND_WORKSPACE_IDS`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional `CC_NOTIFY_ENABLED`, optional `NEXT_PUBLIC_APP_URL`.

---

### Task 1: Role model in access.ts + command layout

**Files:**
- Modify: `src/lib/command/access.ts` (full rewrite, 37 lines today)
- Modify: `src/app/command/layout.tsx`
- Test: `src/lib/command/__tests__/access.test.ts` (new)

**Interfaces:**
- Consumes: `isAdminEmail` from `@/lib/admin` (unchanged), `createSupabaseServerClient`/`createSupabaseReadClient` (unchanged).
- Produces: `type CommandRole = "admin" | "operator"`; `CommandAccess` gains `role: CommandRole`; pure `resolveCommandScope(input): { role, workspaceIds } | null`; `requireAdmin(access): NextResponse | null`; `getCommandAccess` wrapped in React `cache()`. Every later task depends on `access.role` and `requireAdmin`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/command/__tests__/access.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveCommandScope } from "../access";

describe("resolveCommandScope — the v3.0 role/allow-list matrix (spec §a)", () => {
  const W1 = "11111111-1111-1111-1111-111111111111";
  const W2 = "22222222-2222-2222-2222-222222222222";

  test("admin: role=admin, keeps ALL memberships, allow-list ignored", () => {
    const scope = resolveCommandScope({ isAdmin: true, membershipWorkspaceIds: [W1, W2], allowlistRaw: W2 });
    expect(scope).toEqual({ role: "admin", workspaceIds: [W1, W2] });
  });

  test("admin with zero memberships still gets in (today's behavior preserved)", () => {
    const scope = resolveCommandScope({ isAdmin: true, membershipWorkspaceIds: [], allowlistRaw: undefined });
    expect(scope).toEqual({ role: "admin", workspaceIds: [] });
  });

  test("non-admin + unset allow-list → null (fail-closed to today's admin-only posture)", () => {
    expect(resolveCommandScope({ isAdmin: false, membershipWorkspaceIds: [W1], allowlistRaw: undefined })).toBeNull();
  });

  test("non-admin + empty-string allow-list → null (empty ≠ allow-everything)", () => {
    expect(resolveCommandScope({ isAdmin: false, membershipWorkspaceIds: [W1], allowlistRaw: "" })).toBeNull();
  });

  test("operator: memberships filtered to the allow-list intersection", () => {
    const scope = resolveCommandScope({ isAdmin: false, membershipWorkspaceIds: [W1, W2], allowlistRaw: W1 });
    expect(scope).toEqual({ role: "operator", workspaceIds: [W1] });
  });

  test("non-admin whose memberships are all OUTSIDE the allow-list → null, never an empty-scope operator", () => {
    expect(resolveCommandScope({ isAdmin: false, membershipWorkspaceIds: [W1], allowlistRaw: W2 })).toBeNull();
  });

  test("allow-list parsing: commas, whitespace, empty segments", () => {
    const scope = resolveCommandScope({
      isAdmin: false,
      membershipWorkspaceIds: [W1, W2],
      allowlistRaw: ` ${W1} , ,${W2},`,
    });
    expect(scope).toEqual({ role: "operator", workspaceIds: [W1, W2] });
  });

  test("non-admin with no memberships at all → null even with a permissive allow-list", () => {
    expect(resolveCommandScope({ isAdmin: false, membershipWorkspaceIds: [], allowlistRaw: `${W1},${W2}` })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/command/__tests__/access.test.ts`
Expected: FAIL — `resolveCommandScope` is not exported.

- [ ] **Step 3: Rewrite `src/lib/command/access.ts`**

Full replacement (keep the file's header-comment style; `commandDenied` body is unchanged):

```ts
// Access gate for every /api/command/* route and /command page:
// session → COMMAND_CENTER_BETA flag → role (admin allowlist OR allow-listed
// workspace membership) → workspace ids (RLS). v3.0: the security boundary
// for operator seats lives ENTIRELY in this file — routes keep their
// two-line `if (!access) return commandDenied()` gate and trust
// access.workspaceIds for both reads and writes.
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
  workspaceIds: string[];
}

export function betaEnabled(): boolean {
  return process.env.COMMAND_CENTER_BETA === "true";
}

/**
 * PURE role/scope resolution — the v3.0 security matrix, unit-tested in
 * isolation (access.test.ts). Fail-closed by construction:
 * - admins keep all memberships (allow-list does not apply to them);
 * - operators exist ONLY inside the COMMAND_WORKSPACE_IDS allow-list. Unset
 *   or empty allow-list = zero operator seats (today's admin-only posture).
 *   This is NOT optional hardening: Meta accounts come from global env
 *   (metaAccountRefs()), not per-workspace connections, so ANY operator sees
 *   the SAME Meta accounts as every other workspace. Without the allow-list,
 *   "invite one teammate to one workspace" and "invite one teammate to every
 *   ad account the platform has" would be the same operation.
 * - a non-admin with zero allow-listed memberships gets null, never an
 *   empty-scope operator object.
 */
export function resolveCommandScope(input: {
  isAdmin: boolean;
  membershipWorkspaceIds: string[];
  allowlistRaw: string | undefined;
}): { role: CommandRole; workspaceIds: string[] } | null {
  if (input.isAdmin) return { role: "admin", workspaceIds: input.membershipWorkspaceIds };
  const raw = input.allowlistRaw;
  if (!raw) return null;
  const allow = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  const workspaceIds = input.membershipWorkspaceIds.filter((id) => allow.has(id));
  if (workspaceIds.length === 0) return null;
  return { role: "operator", workspaceIds };
}

// cache(): command layout, AppShell, and the equipo page all need this per
// request — React's per-request memo keeps that at ONE auth+membership round
// trip instead of 2-3. (In route handlers cache() is a harmless pass-through.)
export const getCommandAccess = cache(async (): Promise<CommandAccess | null> => {
  if (!betaEnabled()) return null;
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user?.email) return null;
  const { data: { session } } = await authClient.auth.getSession();
  const db = createSupabaseReadClient(session?.access_token);
  const { data: memberships } = await db.from("workspace_members").select("workspace_id").eq("user_id", user.id);
  const scope = resolveCommandScope({
    isAdmin: isAdminEmail(user.email),
    membershipWorkspaceIds: (memberships ?? []).map((m) => String(m.workspace_id)).filter(Boolean),
    allowlistRaw: process.env.COMMAND_WORKSPACE_IDS,
  });
  if (!scope) return null;
  return { email: user.email, userId: user.id, accessToken: session?.access_token, ...scope };
});

export function commandDenied(): NextResponse {
  return NextResponse.json(
    { error: betaEnabled() ? "no autorizado para el Centro de Mando" : "not found" },
    { status: betaEnabled() ? 403 : 404 }
  );
}

/** Admin-only rung for the few routes above operator: settings POST, equipo. */
export function requireAdmin(access: CommandAccess): NextResponse | null {
  return access.role === "admin" ? null : commandDenied();
}
```

- [ ] **Step 4: Simplify `src/app/command/layout.tsx`**

Replace the whole file body (the inline flag+admin check duplicates what `getCommandAccess` now does, and would WRONGLY 404 operators if kept):

```tsx
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCommandAccess } from "@/lib/command/access";

// Centro de Mando (beta): stealth gate. getCommandAccess owns the whole
// decision (flag → session → role/allow-list) — v3.0 operators pass, plain
// users 404, flag-off 404s for everyone. Same posture as before, one owner.
export const dynamic = "force-dynamic";

export default async function CommandLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getCommandAccess();
  if (!access) notFound();
  return <AppShell>{children}</AppShell>;
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test src/lib/command/__tests__/access.test.ts` → PASS (8 tests).
Run: `bun test` → all suites pass (nothing consumed `CommandAccess` beyond its old fields, which all remain).
Run: `bunx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/command/access.ts src/app/command/layout.tsx src/lib/command/__tests__/access.test.ts
git commit -m "feat(v3.0): 2-role access model — operator seats behind COMMAND_WORKSPACE_IDS allow-list, fail-closed"
```

---

### Task 2: Nav config extraction + Admin-nav leak fix + AppShell role threading

**Files:**
- Create: `src/components/nav-config.ts`
- Modify: `src/components/app-sidebar.tsx` (remove inline NAV_GROUPS/COMMAND_GROUP/navGroups, import from nav-config; thread `isPlatformAdmin`)
- Modify: `src/components/command-palette.tsx` (remove inline DESTINATIONS/COMMAND_DESTINATIONS, import from nav-config; thread `isPlatformAdmin`)
- Modify: `src/components/app-shell.tsx` (compute access + isPlatformAdmin, thread both)
- Test: `src/components/__tests__/nav-config.test.ts` (new)

**Interfaces:**
- Consumes: `getCommandAccess` (Task 1), `isAdminEmail`, `createSupabaseServerClient`.
- Produces: `nav-config.ts` exports `NavGroup`, `NavItem`, `Destination`, `navGroups(commandCenter: boolean, isPlatformAdmin: boolean): NavGroup[]`, `paletteDestinations(commandCenter: boolean, isPlatformAdmin: boolean): Destination[]`. `AppSidebar` and `CommandPaletteMount`/`CommandPalette` gain an `isPlatformAdmin?: boolean` prop. Task 6 adds the Equipo nav item HERE (navGroups already takes isPlatformAdmin, so Task 6 is a one-line item add).

**Background (spec finding #1):** today `{ href: "/admin", label: "Admin" }` sits in the UNCONDITIONAL `NAV_GROUPS` "Cuenta" group (and `DESTINATIONS` in the palette) — every logged-in user sees an Admin link. The route itself 401s, but v3.0 introduces non-admin Command users, so the nav must become role-aware.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/nav-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { navGroups, paletteDestinations } from "../nav-config";

const allHrefs = (groups: ReturnType<typeof navGroups>) =>
  groups.flatMap((g) => g.items.map((i) => i.href));

describe("navGroups — role-aware nav (spec §a finding #1)", () => {
  test("plain user: no /admin, no /command", () => {
    const hrefs = allHrefs(navGroups(false, false));
    expect(hrefs).not.toContain("/admin");
    expect(hrefs.some((h) => h.startsWith("/command"))).toBe(false);
  });

  test("operator (commandCenter, NOT platform admin): /command yes, /admin NEVER", () => {
    const hrefs = allHrefs(navGroups(true, false));
    expect(hrefs).toContain("/command");
    expect(hrefs).not.toContain("/admin");
  });

  test("platform admin with command: both", () => {
    const hrefs = allHrefs(navGroups(true, true));
    expect(hrefs).toContain("/command");
    expect(hrefs).toContain("/admin");
  });

  test("platform admin with beta off: /admin still visible (nav must not regress for admins)", () => {
    const hrefs = allHrefs(navGroups(false, true));
    expect(hrefs).toContain("/admin");
    expect(hrefs.some((h) => h.startsWith("/command"))).toBe(false);
  });

  test("Conexiones stays in Cuenta for everyone (only Admin was gated)", () => {
    expect(allHrefs(navGroups(false, false))).toContain("/conexiones");
  });
});

describe("paletteDestinations — same matrix for ⌘K", () => {
  const hrefs = (cc: boolean, admin: boolean) => paletteDestinations(cc, admin).map((d) => d.href);

  test("operator: command destinations yes, /admin never", () => {
    expect(hrefs(true, false)).toContain("/command");
    expect(hrefs(true, false)).not.toContain("/admin");
  });

  test("plain user: neither", () => {
    expect(hrefs(false, false)).not.toContain("/admin");
    expect(hrefs(false, false)).not.toContain("/command");
  });

  test("admin: both", () => {
    expect(hrefs(true, true)).toContain("/admin");
    expect(hrefs(true, true)).toContain("/command");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/components/__tests__/nav-config.test.ts`
Expected: FAIL — module `../nav-config` does not exist.

- [ ] **Step 3: Create `src/components/nav-config.ts`**

Move the nav data out of the two client components into one pure module (no `"use client"`, no React imports — this is what makes the security-relevant gating unit-testable). Copy the EXISTING `NAV_GROUPS` array from `app-sidebar.tsx` verbatim EXCEPT: delete `{ href: "/admin", label: "Admin", icon: "admin" }` from the "Cuenta" group. Copy the EXISTING `DESTINATIONS` array from `command-palette.tsx` verbatim EXCEPT: delete `{ label: "Admin", href: "/admin", section: "Cuenta" }`. Copy `COMMAND_GROUP` and `COMMAND_DESTINATIONS` verbatim. Move the `NavGroup`/`NavItem` type from app-sidebar and `Destination` type from command-palette here (export them; keep their exact current shapes, including `icon` keys).

Then add:

```ts
// The Admin entry was in the UNCONDITIONAL groups until v3.0 — every logged-in
// user saw a link to /admin (the route 401'd, but v3.0 introduces operators,
// so the nav itself must be role-aware). It is now appended ONLY for platform
// admins, mirroring how COMMAND_GROUP is spliced for command users.
const ADMIN_NAV_ITEM: NavItem = { href: "/admin", label: "Admin", icon: "admin" };
const ADMIN_DESTINATION: Destination = { label: "Admin", href: "/admin", section: "Cuenta" };

export function navGroups(commandCenter: boolean, isPlatformAdmin: boolean): NavGroup[] {
  const base = commandCenter
    ? [...NAV_GROUPS.slice(0, 1), COMMAND_GROUP, ...NAV_GROUPS.slice(1)]
    : NAV_GROUPS;
  if (!isPlatformAdmin) return base;
  return base.map((g) =>
    g.label === "Cuenta" ? { ...g, items: [...g.items, ADMIN_NAV_ITEM] } : g
  );
}

export function paletteDestinations(commandCenter: boolean, isPlatformAdmin: boolean): Destination[] {
  return [
    ...DESTINATIONS,
    ...(isPlatformAdmin ? [ADMIN_DESTINATION] : []),
    ...(commandCenter ? COMMAND_DESTINATIONS : []),
  ];
}
```

(`NAV_GROUPS`, `COMMAND_GROUP`, `DESTINATIONS`, `COMMAND_DESTINATIONS` stay module-private; only the types and the two functions are exported.)

- [ ] **Step 4: Rewire `app-sidebar.tsx`, `command-palette.tsx`, `app-shell.tsx`**

`app-sidebar.tsx`: delete the moved `NavGroup` type, `NAV_GROUPS`, `COMMAND_GROUP`, and `navGroups`; add `import { navGroups, type NavGroup } from "./nav-config";` (keep `findActiveHref` — it takes the groups array and is unchanged). Thread the new prop exactly the way `commandCenter` is threaded today (lines 301-308, 483, 518, 618): `SidebarContent({ onNavigate, commandCenter, isPlatformAdmin })` calls `navGroups(commandCenter ?? false, isPlatformAdmin ?? false)`; `AppSidebar({ commandCenter, isPlatformAdmin })` passes it down at both `<SidebarContent>` call sites (desktop + mobile drawer).

`command-palette.tsx`: delete the moved `Destination` type, `DESTINATIONS`, `COMMAND_DESTINATIONS`; add `import { paletteDestinations, type Destination } from "./nav-config";`. In `CommandPalette`, replace the `destinations` memo with:

```ts
const destinations = useMemo(
  () => paletteDestinations(commandCenter ?? false, isPlatformAdmin ?? false),
  [commandCenter, isPlatformAdmin]
);
```

and add `isPlatformAdmin?: boolean` to both `CommandPalette` and `CommandPaletteMount` props, threading it through the mount (line ~394).

`app-shell.tsx`: replace the flag+admin block (lines 27-37) with:

```tsx
export async function AppShell({ children }: { children: React.ReactNode }) {
  // v3.0: commandCenter now includes allow-listed operators, not only admins.
  // isPlatformAdmin gates the Admin nav item; it must be computed even when
  // getCommandAccess() is null (admin with the beta flag off, or a plain
  // logged-in user) — hence the fallback auth read.
  const access = await getCommandAccess();
  const commandCenter = Boolean(access);
  let isPlatformAdmin = access?.role === "admin";
  if (!access) {
    const authClient = await createSupabaseServerClient();
    const { data: { user } } = await authClient.auth.getUser();
    isPlatformAdmin = Boolean(user?.email && isAdminEmail(user.email));
  }
```

with imports `import { getCommandAccess } from "@/lib/command/access";` (keep the existing `createSupabaseServerClient` and `isAdminEmail` imports), and pass `isPlatformAdmin={isPlatformAdmin}` to both `<AppSidebar>` and `<CommandPaletteMount>`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test src/components/__tests__/nav-config.test.ts` → PASS (8 tests).
Run: `bun test && bunx tsc --noEmit` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/components/nav-config.ts src/components/app-sidebar.tsx src/components/command-palette.tsx src/components/app-shell.tsx src/components/__tests__/nav-config.test.ts
git commit -m "feat(v3.0): role-aware nav — Admin item admin-only (was unconditionally visible), operators get Command without /admin"
```

---

### Task 3: settings POST admin-only + migration 011 + cc_notifications schema + listNovedades workspaceId

**Files:**
- Modify: `src/app/api/command/settings/route.ts` (one gate line)
- Modify: `src/app/api/migrate/route.ts` (append migration 011 statements)
- Modify: `src/lib/schema.ts` (add `ccNotifications` table)
- Modify: `src/lib/command/actions-repo.ts` (`NovedadItemRef` + the five `listNovedades` selects)
- Test: extend `src/lib/command/__tests__/actions-repo.test.ts` (type-level pin via existing suite; no DB test — `listNovedades` hits `adsDb` directly and is pinned by tsc)

**Interfaces:**
- Consumes: `requireAdmin` (Task 1).
- Produces: `ccNotifications` Drizzle table (Task 4 inserts into it); `NovedadItemRef` becomes `{ id: string; workspaceId: string }` (Task 4 keys dedup rows on it).

- [ ] **Step 1: Gate settings POST**

In `src/app/api/command/settings/route.ts` POST, directly after `if (!access) return commandDenied();` add:

```ts
  // v3.0: settings (kill switch, límites, allowed verbs) are platform-admin
  // territory — a flat deny for operators has zero smuggling surface (the
  // handler applies whatever fields arrive together, so a pause-only
  // carve-out would need exact-body-shape checks; spec §b rejects it).
  const denied = requireAdmin(access);
  if (denied) return denied;
```

and extend the import to `import { getCommandAccess, commandDenied, requireAdmin } from "@/lib/command/access";`. GET stays operator-accessible (read-only, feeds the resumen badge).

- [ ] **Step 2: Append migration 011 in `src/app/api/migrate/route.ts`**

Inside the `migrations` array, immediately after the `'010_command_center_v2_7'` version-insert line, add:

```ts
    // ── 011 · v3.0 SaaS-lite: notificaciones externas (Telegram) ──
    // Dedup ledger for Novedades notifications. The UNIQUE index is the
    // concurrency lock: notify.ts does INSERT … ON CONFLICT DO NOTHING and
    // only newly-inserted rows go into the message, so concurrent sweeps can
    // never double-send the same item (design spec §c).
    sql`CREATE TABLE IF NOT EXISTS cc_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL,
      kind TEXT NOT NULL,
      item_id UUID NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_notifications_item
      ON cc_notifications(workspace_id, kind, item_id)`,
    sql`INSERT INTO schema_migrations (version) VALUES ('011_command_center_v3_0') ON CONFLICT (version) DO NOTHING`,
```

- [ ] **Step 3: Add `ccNotifications` to `src/lib/schema.ts`**

After the `ccSettings` table definition, following the file's exact idiom (see `ccExecutions`' `uniqueIndex` usage):

```ts
// v3.0 — dedup ledger for external (Telegram) Novedades notifications. The
// unique index IS the dedup mechanism (insert-if-new); rows are never updated.
export const ccNotifications = pgTable(
  "cc_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    itemId: uuid("item_id").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_cc_notifications_item").on(table.workspaceId, table.kind, table.itemId),
  ]
);
```

- [ ] **Step 4: Add `workspaceId` to the Novedades item refs**

In `src/lib/command/actions-repo.ts`:

```ts
export interface NovedadItemRef {
  id: string;
  /** v3.0: notify.ts keys cc_notifications dedup rows on (workspace, kind, id). */
  workspaceId: string;
}
```

Then in `listNovedades`, change each of the five selects to also project the workspace column — e.g. query (a) becomes `adsDb.select({ id: ccBlueprints.id, workspaceId: ccBlueprints.workspaceId })…` and queries (b), (c), (e) become `adsDb.select({ id: ccActions.id, workspaceId: ccActions.workspaceId })…`; query (d) becomes `adsDb.select({ id: ccActions.id, workspaceId: ccActions.workspaceId, gateResults: ccActions.gateResults })…` and its post-filter map becomes `.map((a) => ({ id: a.id, workspaceId: a.workspaceId }))`. Nothing else in the function changes — existing consumers only read `.id` and `counts`, so this is additive.

- [ ] **Step 5: Run tests + typecheck + commit**

Run: `bun test && bunx tsc --noEmit` → all green (the `NovedadItemRef` change is additive; if any existing test constructs `NovedadItemRef` literals, add the `workspaceId` field there).

```bash
git add src/app/api/command/settings/route.ts src/app/api/migrate/route.ts src/lib/schema.ts src/lib/command/actions-repo.ts
git commit -m "feat(v3.0): settings POST admin-only + migration 011 cc_notifications + workspace-keyed novedad refs"
```

(If `actions-repo.test.ts` needed the literal fix, include it in the `git add`.)

---

### Task 4: notify.ts (Telegram + DB dedup) + verify route hook

**Files:**
- Create: `src/lib/command/notify.ts`
- Modify: `src/app/api/command/verify/route.ts` (2 lines)
- Test: `src/lib/command/__tests__/notify.test.ts` (new)

**Interfaces:**
- Consumes: `listNovedades`/`NovedadesResult`/`NovedadItemRef` (Task 3 shape), `ccNotifications` (Task 3), `adsDb` from `@/lib/ads-db`.
- Produces: `notifyEnabled(): boolean`, `notifyNovedades(workspaceIds: string[], deps?: NotifyDeps): Promise<NotifyOutcome>`, pure `buildNovedadesMessage(newCounts, appUrl): string | null`. HARD CONSTRAINT: `src/lib/command/verify.ts` is NOT touched.

- [ ] **Step 1: Write the failing test**

Create `src/lib/command/__tests__/notify.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildNovedadesMessage, notifyNovedades, type NotifyDeps } from "../notify";
import type { NovedadesResult } from "../actions-repo";

const W = "11111111-1111-1111-1111-111111111111";
const ref = (id: string) => ({ id, workspaceId: W });

function novedades(partial: Partial<NovedadesResult["items"]>): NovedadesResult {
  const items = {
    planesFallidos: [], accionesFallidas: [], conDeriva: [], bloqueadas: [], caducadas: [],
    ...partial,
  };
  const counts = {
    planesFallidos: items.planesFallidos.length,
    accionesFallidas: items.accionesFallidas.length,
    conDeriva: items.conDeriva.length,
    bloqueadas: items.bloqueadas.length,
    caducadas: items.caducadas.length,
  };
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), items };
}

function fakeDeps(result: NovedadesResult, opts?: { dupes?: Set<string>; sendFails?: boolean }) {
  const inserts: string[] = [];
  const sends: string[] = [];
  const deps: NotifyDeps = {
    novedades: async () => result,
    insertIfNew: async (workspaceId, kind, itemId) => {
      const key = `${workspaceId}|${kind}|${itemId}`;
      inserts.push(key);
      return !(opts?.dupes?.has(key));
    },
    send: async (text) => {
      if (opts?.sendFails) throw new Error("telegram caído");
      sends.push(text);
    },
    appUrl: "https://ads.airankia.com",
  };
  return { deps, inserts, sends };
}

describe("notifyNovedades — DB-dedup'd Telegram send (spec §c)", () => {
  test("all-new items → exactly one send naming only non-zero categories, with deep links", async () => {
    const { deps, sends } = fakeDeps(novedades({
      accionesFallidas: [ref("a1"), ref("a2")],
      conDeriva: [ref("d1")],
    }));
    const out = await notifyNovedades([W], deps);
    expect(out.sent).toBe(true);
    expect(sends.length).toBe(1);
    expect(sends[0]).toContain("2 acciones fallidas");
    expect(sends[0]).toContain("1 con deriva");
    expect(sends[0]).toContain("https://ads.airankia.com/command/acciones");
    expect(sends[0]).not.toContain("plan");
  });

  test("all items already notified → NO send (dedup)", async () => {
    const items = { accionesFallidas: [ref("a1")] };
    const { deps, sends } = fakeDeps(novedades(items), {
      dupes: new Set([`${W}|accion_fallida|a1`]),
    });
    const out = await notifyNovedades([W], deps);
    expect(out.sent).toBe(false);
    expect(sends.length).toBe(0);
  });

  test("mixed: only categories with ≥1 NEW item appear in the message", async () => {
    const { deps, sends } = fakeDeps(
      novedades({ accionesFallidas: [ref("old")], caducadas: [ref("new1")] }),
      { dupes: new Set([`${W}|accion_fallida|old`]) }
    );
    await notifyNovedades([W], deps);
    expect(sends.length).toBe(1);
    expect(sends[0]).toContain("caducada");
    expect(sends[0]).not.toContain("fallida");
  });

  test("inserts happen BEFORE the send; a failed send never throws and never rolls back", async () => {
    const { deps, inserts } = fakeDeps(novedades({ conDeriva: [ref("d1")] }), { sendFails: true });
    const out = await notifyNovedades([W], deps);
    expect(out.sent).toBe(false);
    expect(inserts).toContain(`${W}|deriva|d1`); // row stays → no re-spam next sweep
  });

  test("zero novedades → zero inserts, zero sends", async () => {
    const { deps, inserts, sends } = fakeDeps(novedades({}));
    const out = await notifyNovedades([W], deps);
    expect(out.sent).toBe(false);
    expect(inserts.length).toBe(0);
    expect(sends.length).toBe(0);
  });
});

describe("buildNovedadesMessage — pure es-MX formatter", () => {
  test("null when nothing is new", () => {
    expect(buildNovedadesMessage(
      { planesFallidos: 0, accionesFallidas: 0, conDeriva: 0, bloqueadas: 0, caducadas: 0 },
      "https://x"
    )).toBeNull();
  });

  test("singular/plural + total header", () => {
    const msg = buildNovedadesMessage(
      { planesFallidos: 1, accionesFallidas: 0, conDeriva: 0, bloqueadas: 0, caducadas: 2 },
      "https://x"
    );
    expect(msg).toContain("3 novedades");
    expect(msg).toContain("1 plan fallido");
    expect(msg).toContain("2 caducadas");
    expect(msg).toContain("https://x/command/bitacora");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/command/__tests__/notify.test.ts`
Expected: FAIL — module `../notify` does not exist.

- [ ] **Step 3: Create `src/lib/command/notify.ts`**

```ts
// v3.0 — Telegram notifications layered on the Novedades query (spec §c).
//
// PURITY COVENANT: verify.ts stays byte-identical. This module is fired
// fire-and-forget from the /api/command/verify ROUTE after runSweep returns —
// a send is a side effect, so it lives outside the READ-only sweep, and a
// notify failure can never block or fail the sweep response.
//
// DEDUP: cc_notifications' unique index (workspace_id, kind, item_id) is the
// lock — INSERT … ON CONFLICT DO NOTHING, and only newly-inserted rows enter
// the message. Rows are inserted BEFORE the send, so a Telegram outage drops
// that batch instead of re-spamming on every following sweep (deliberate
// trade-off: losing one batch beats spamming forever).
import { adsDb } from "@/lib/ads-db";
import { ccNotifications } from "@/lib/schema";
import { listNovedades, type NovedadesCounts, type NovedadesResult } from "./actions-repo";

export type NovedadKind = "plan_fallido" | "accion_fallida" | "deriva" | "bloqueada" | "caducada";

/** category → (kind, es-MX label [singular, plural], deep link path) */
const CATEGORIES: Array<{
  key: keyof NovedadesCounts;
  kind: NovedadKind;
  emoji: string;
  singular: string;
  plural: string;
  path: string;
}> = [
  { key: "planesFallidos", kind: "plan_fallido", emoji: "🧩", singular: "plan fallido", plural: "planes fallidos", path: "/command/bitacora" },
  { key: "accionesFallidas", kind: "accion_fallida", emoji: "❌", singular: "acción fallida", plural: "acciones fallidas", path: "/command/acciones?filter=failed" },
  { key: "conDeriva", kind: "deriva", emoji: "⚠️", singular: "con deriva detectada", plural: "con deriva detectada", path: "/command/acciones?filter=executed" },
  { key: "bloqueadas", kind: "bloqueada", emoji: "🚧", singular: "bloqueada por compuertas", plural: "bloqueadas por compuertas", path: "/command/acciones?filter=approved" },
  { key: "caducadas", kind: "caducada", emoji: "⏳", singular: "caducada", plural: "caducadas", path: "/command/acciones?filter=expired" },
];

export interface NotifyDeps {
  novedades: (workspaceIds: string[]) => Promise<NovedadesResult>;
  /** true = newly inserted (notify); false = already notified (skip). */
  insertIfNew: (workspaceId: string, kind: NovedadKind, itemId: string) => Promise<boolean>;
  send: (text: string) => Promise<void>;
  appUrl: string;
}

export interface NotifyOutcome {
  sent: boolean;
  newCounts: NovedadesCounts;
}

export function notifyEnabled(): boolean {
  return (
    Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) &&
    process.env.CC_NOTIFY_ENABLED !== "false"
  );
}

/** PURE es-MX formatter. null when no category has new items. */
export function buildNovedadesMessage(newCounts: NovedadesCounts, appUrl: string): string | null {
  const total = Object.values(newCounts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const lines = [`🛰 Centro de Mando — ${total} ${total === 1 ? "novedad" : "novedades"}`, ""];
  for (const c of CATEGORIES) {
    const n = newCounts[c.key];
    if (n === 0) continue;
    lines.push(`${c.emoji} ${n} ${n === 1 ? c.singular : c.plural}`);
    lines.push(`   → ${appUrl}${c.path}`);
  }
  return lines.join("\n");
}

export function buildNotifyDeps(): NotifyDeps {
  return {
    novedades: listNovedades,
    insertIfNew: async (workspaceId, kind, itemId) => {
      const inserted = await adsDb
        .insert(ccNotifications)
        .values({ workspaceId, kind, itemId })
        .onConflictDoNothing()
        .returning({ id: ccNotifications.id });
      return inserted.length > 0;
    },
    send: async (text) => {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) return;
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`telegram sendMessage ${res.status}`);
    },
    appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://ads.airankia.com",
  };
}

export async function notifyNovedades(
  workspaceIds: string[],
  deps: NotifyDeps = buildNotifyDeps()
): Promise<NotifyOutcome> {
  const result = await deps.novedades(workspaceIds);
  const newCounts: NovedadesCounts = {
    planesFallidos: 0, accionesFallidas: 0, conDeriva: 0, bloqueadas: 0, caducadas: 0,
  };
  for (const c of CATEGORIES) {
    for (const item of result.items[c.key]) {
      if (await deps.insertIfNew(item.workspaceId, c.kind, item.id)) newCounts[c.key] += 1;
    }
  }
  const message = buildNovedadesMessage(newCounts, deps.appUrl);
  if (!message) return { sent: false, newCounts };
  try {
    await deps.send(message);
    return { sent: true, newCounts };
  } catch {
    // Rows are already inserted — deliberate: drop this batch, never re-spam.
    return { sent: false, newCounts };
  }
}
```

- [ ] **Step 4: Hook the verify route**

In `src/app/api/command/verify/route.ts`, extend the import and the try block:

```ts
import { notifyEnabled, notifyNovedades } from "@/lib/command/notify";
```

```ts
  try {
    const result = await runSweep(access);
    // v3.0: external notification is a SIDE EFFECT and lives here in the
    // route, not in verify.ts (READ-only covenant) — fire-and-forget so a
    // Telegram outage can never block or fail the sweep response.
    if (notifyEnabled()) void notifyNovedades(access.workspaceIds).catch(() => {});
    return NextResponse.json(result);
  } catch (e) {
```

- [ ] **Step 5: Run tests + typecheck + commit**

Run: `bun test src/lib/command/__tests__/notify.test.ts` → PASS (7 tests). Then `bun test && bunx tsc --noEmit` → all green. Confirm `git diff --stat src/lib/command/verify.ts` is empty.

```bash
git add src/lib/command/notify.ts src/app/api/command/verify/route.ts src/lib/command/__tests__/notify.test.ts
git commit -m "feat(v3.0): Telegram novedades — DB-dedup'd, fired from verify route, sweep stays pure"
```

---

### Task 5: supabase-admin client + /api/command/equipo route

**Files:**
- Create: `src/lib/supabase-admin.ts`
- Create: `src/app/api/command/equipo/route.ts`

**Interfaces:**
- Consumes: `getCommandAccess`/`commandDenied`/`requireAdmin` (Task 1).
- Produces: `createSupabaseAdminClient(): SupabaseClient | null`; equipo API — `GET ?workspaceId` → `{ workspaceId, members: [{ userId, email, role, invitedBy }] }`; `POST { email, workspaceId }` → `{ member, invited }`; `DELETE { workspaceId, userId }` → `{ removed: true }`. Task 6's UI consumes exactly these shapes.

**Security invariants (spec §d — reviewer: check each):** every handler runs `requireAdmin` before touching the admin client; the admin client bypasses RLS by design, so `workspaceId` inputs are validated against `access.workspaceIds`; the module is imported ONLY by this route; missing service key → 501, never a crash; the invite can only ever create operator-tier access (role comes from `isAdminEmail`, never from any DB row this route writes).

- [ ] **Step 1: Create `src/lib/supabase-admin.ts`**

```ts
// v3.0 — service-role Supabase client for the equipo (team management) route
// ONLY. This is the one place in the app that bypasses RLS, so containment
// is the design: server-only, imported solely by /api/command/equipo, and
// every caller re-checks requireAdmin() before touching it. Missing key →
// null → the route answers 501 (fail closed, discoverable).
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createSupabaseAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
```

(Check how other files import the Supabase URL — if the repo reads a different env name in `src/lib/supabase-server.ts`, use that same name.)

- [ ] **Step 2: Create `src/app/api/command/equipo/route.ts`**

```ts
// v3.0 — team management (spec §d): list / invite / remove workspace members.
// ADMIN-ONLY: this is the single route allowed to touch the service-role
// client. The invite writes a plain workspace_members row with the LEGACY
// role 'member' (satisfies the table's CHECK role IN ('owner','member'));
// that value carries ZERO Command-permission meaning — Command access is
// decided entirely by access.ts (membership ∩ COMMAND_WORKSPACE_IDS), and
// platform-admin is decided entirely by isAdminEmail. Nothing this route can
// write escalates anyone to admin.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied, requireAdmin } from "@/lib/command/access";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";
import { isAdminEmail } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_SERVICE_KEY = NextResponse.json(
  { error: "Falta configurar SUPABASE_SERVICE_ROLE_KEY en el servidor." },
  { status: 501 }
);

async function requireAdminAndClient() {
  const access = await getCommandAccess();
  if (!access) return { error: commandDenied() } as const;
  const denied = requireAdmin(access);
  if (denied) return { error: denied } as const;
  const admin = createSupabaseAdminClient();
  if (!admin) return { error: NO_SERVICE_KEY } as const;
  return { access, admin } as const;
}

export async function GET(request: NextRequest) {
  const ctx = await requireAdminAndClient();
  if ("error" in ctx) return ctx.error;
  const workspaceId = request.nextUrl.searchParams.get("workspaceId") ?? ctx.access.workspaceIds[0];
  if (!workspaceId || !ctx.access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }
  const { data: rows, error } = await ctx.admin
    .from("workspace_members")
    .select("user_id, role, invited_by")
    .eq("workspace_id", workspaceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // N+1 email resolution — fine at beta scale (single digits). A failed
  // lookup degrades to a partial row, never a 500 (spec §g risk 7).
  const members = await Promise.all(
    (rows ?? []).map(async (r) => {
      let email: string | null = null;
      try {
        const { data } = await ctx.admin.auth.admin.getUserById(String(r.user_id));
        email = data.user?.email ?? null;
      } catch { /* stale auth user — keep the row, drop the email */ }
      return { userId: String(r.user_id), email, role: String(r.role), invitedBy: r.invited_by ?? null };
    })
  );
  return NextResponse.json({ workspaceId, members });
}

export async function POST(request: NextRequest) {
  const ctx = await requireAdminAndClient();
  if ("error" in ctx) return ctx.error;
  let body: { email?: unknown; workspaceId?: unknown };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (!email || !email.includes("@") || !workspaceId) {
    return NextResponse.json({ error: "Faltan campos: email, workspaceId" }, { status: 400 });
  }
  if (!ctx.access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }

  // 1) Invite (sends Supabase's built-in email) — or find the existing user.
  let userId: string | null = null;
  let invited = false;
  const origin = request.nextUrl.origin;
  const { data: inviteData, error: inviteError } = await ctx.admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/auth/callback`,
  });
  if (!inviteError && inviteData.user) {
    userId = inviteData.user.id;
    invited = true;
  } else {
    // Already registered (or invite disabled) → locate by email. listUsers is
    // acceptable at beta scale; page through defensively anyway.
    for (let page = 1; page <= 10 && !userId; page++) {
      const { data, error } = await ctx.admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      userId = data.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
      if (data.users.length < 200) break;
    }
    if (!userId) {
      return NextResponse.json(
        { error: `No se pudo invitar a ${email}: ${inviteError?.message ?? "usuario no encontrado"}` },
        { status: 500 }
      );
    }
  }

  // 2) Membership row — SELECT-then-INSERT (a unique(workspace_id,user_id)
  // constraint is NOT confirmed on this table, so upsert/onConflict is
  // unsafe to assume; spec §d).
  const { data: existing } = await ctx.admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!existing) {
    const { error: insertError } = await ctx.admin.from("workspace_members").insert({
      workspace_id: workspaceId,
      user_id: userId,
      role: "member", // legacy main-app value; carries no Command meaning (see header)
      invited_by: ctx.access.userId,
    });
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
  }
  return NextResponse.json({ member: { userId, email, role: "member" }, invited });
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireAdminAndClient();
  if ("error" in ctx) return ctx.error;
  let body: { workspaceId?: unknown; userId?: unknown };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!workspaceId || !userId) {
    return NextResponse.json({ error: "Faltan campos: workspaceId, userId" }, { status: 400 });
  }
  if (!ctx.access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }
  // UX guard (not a security boundary — admins aren't membership-gated):
  // removing an admin's row would be a confusing no-op, so refuse it.
  try {
    const { data } = await ctx.admin.auth.admin.getUserById(userId);
    if (data.user?.email && isAdminEmail(data.user.email)) {
      return NextResponse.json(
        { error: "Los administradores de plataforma no se gestionan aquí (ADMIN_EMAILS)." },
        { status: 400 }
      );
    }
  } catch { /* stale user — allow the row removal */ }
  const { error } = await ctx.admin
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ removed: true });
}
```

(If `invited_by` doesn't exist as a column — the insert will error at runtime, not compile time; check the column exists by looking at how `/security/equipo` or any other code reads `workspace_members`. If it's not confirmed anywhere in the repo, DROP the `invited_by` field from both the insert and the GET select rather than guessing.)

- [ ] **Step 3: Typecheck + full suite + commit**

Run: `bunx tsc --noEmit && bun test` → green (no unit tests for this route — it's thin I/O over the Supabase Admin API behind the Task-1-tested gate; the security invariants above are the review checklist).

```bash
git add src/lib/supabase-admin.ts src/app/api/command/equipo/route.ts
git commit -m "feat(v3.0): equipo API — admin-only invite/list/remove via service-role client (501 without key)"
```

---

### Task 6: /command/equipo page + nav entry + resumen kill-switch role gating

**Files:**
- Create: `src/app/command/equipo/page.tsx`
- Create: `src/app/command/equipo/equipo-client.tsx`
- Modify: `src/components/nav-config.ts` (Equipo item for admins)
- Modify: `src/components/__tests__/nav-config.test.ts` (pin it)
- Modify: `src/app/command/page.tsx` (pass `isAdmin` to resumen client)
- Modify: `src/app/command/resumen-client.tsx` (hide kill-switch buttons for operators)

**Interfaces:**
- Consumes: equipo API shapes (Task 5), `getCommandAccess` (Task 1), `navGroups(commandCenter, isPlatformAdmin)` (Task 2).
- Produces: nothing later tasks need.

- [ ] **Step 1: Extend the nav test (failing first)**

Add to `src/components/__tests__/nav-config.test.ts`:

```ts
  test("Equipo del Centro de Mando: admin-only — operators never see it", () => {
    expect(allHrefs(navGroups(true, true))).toContain("/command/equipo");
    expect(allHrefs(navGroups(true, false))).not.toContain("/command/equipo");
    expect(allHrefs(navGroups(false, true))).not.toContain("/command/equipo");
  });
```

Run: `bun test src/components/__tests__/nav-config.test.ts` → the new test FAILS.

- [ ] **Step 2: Add the nav item in `nav-config.ts`**

In `navGroups`, build the command group role-aware (replace the `COMMAND_GROUP` splice):

```ts
const EQUIPO_NAV_ITEM: NavItem = { href: "/command/equipo", label: "Equipo", icon: "comando" };

export function navGroups(commandCenter: boolean, isPlatformAdmin: boolean): NavGroup[] {
  const commandGroup: NavGroup = isPlatformAdmin
    ? { ...COMMAND_GROUP, items: [...COMMAND_GROUP.items, EQUIPO_NAV_ITEM] }
    : COMMAND_GROUP;
  const base = commandCenter
    ? [...NAV_GROUPS.slice(0, 1), commandGroup, ...NAV_GROUPS.slice(1)]
    : NAV_GROUPS;
  if (!isPlatformAdmin) return base;
  return base.map((g) =>
    g.label === "Cuenta" ? { ...g, items: [...g.items, ADMIN_NAV_ITEM] } : g
  );
}
```

Run the nav test → PASS.

- [ ] **Step 3: Create `src/app/command/equipo/page.tsx`**

Follow the exact server-page idiom of `src/app/command/crear/[id]/revisar/page.tsx` (Header + breadcrumbs + PageHeader + client component):

```tsx
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import EquipoClient from "./equipo-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function EquipoPage() {
  const access = await getCommandAccess();
  // Admin-only page: operators 404 (stealth, same posture as the layout gate).
  if (!access || access.role !== "admin") notFound();

  return (
    <div>
      <Header
        breadcrumbs={[
          { label: "Centro de Mando", href: "/command" },
          { label: "Equipo" },
        ]}
      />
      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Equipo del Centro de Mando"
          subtitle="Invita operadores por workspace. Un operador propone, aprueba y ejecuta dentro de sus workspaces — nunca ve /admin ni los ajustes. Los administradores de plataforma se gestionan por variables de entorno (ADMIN_EMAILS), no aquí."
        />
        <EquipoClient workspaceIds={access.workspaceIds} />
      </main>
    </div>
  );
}
```

(Adjust `PageHeader`/`UI` usage to the components' real props if they differ — copy from the revisar page.)

- [ ] **Step 4: Create `src/app/command/equipo/equipo-client.tsx`**

Client component in the style of the other command clients (`"use client"`, `useTheme`/ui-kit buttons — copy idioms from `resumen-client.tsx`). Behavior:

- Props: `{ workspaceIds: string[] }`. State: selected workspace (default first), members list, loading/error, invite email input, busy flag, confirm-removal target.
- Workspace selector: a plain `<select>` over `workspaceIds` (label "Workspace"; show the UUID — beta-honest, no fake names).
- On mount + workspace change: `GET /api/command/equipo?workspaceId=…` → render rows: email (or `userId` when email is null) + role chip + "Quitar" ghost-danger button. Empty state: "Sin miembros en este workspace."
- Invite form: email input (placeholder "correo@equipo.com") + primary button "Invitar". On submit `POST /api/command/equipo` with `{ email, workspaceId }`; success message: `invited ? \`Invitación enviada a ${email}.\` : \`${email} ya tenía cuenta — agregado al workspace.\``; then refetch. Disable while busy.
- Remove: first click arms confirmation inline ("¿Quitar a {email}? Perderá acceso al Centro de Mando." + button "Confirmar"), second click `DELETE` with `{ workspaceId, userId }`, then refetch.
- Error handling: render the API's `error` string in an error card (the 501 service-key message and the admin-removal refusal both surface as-is).
- Below the list, a static hint card: "Recuerda: el workspace también debe estar en COMMAND_WORKSPACE_IDS para que sus miembros tengan asiento de operador."

- [ ] **Step 5: Gate the resumen kill-switch buttons**

`src/app/command/page.tsx`: find where `<ResumenClient …>` is rendered (the page already loads `access` — it calls `getCommandAccess()`); add prop `isAdmin={access.role === "admin"}`.

`src/app/command/resumen-client.tsx`: add `isAdmin?: boolean` to the props type; wrap ONLY the two buttons (the `PrimaryButton` "reanudar" / `GhostDangerButton` "pausar" pair around lines 61-65) in `{isAdmin && (…)}`, and when `!isAdmin` render instead a muted one-liner: `"Solo un administrador de plataforma puede pausar o reanudar las ejecuciones."`. The status badge/copy above the buttons stays visible to everyone (operators must SEE the kill-switch state).

- [ ] **Step 6: Run everything + commit**

Run: `bun test && bunx tsc --noEmit` → green.

```bash
git add src/app/command/equipo/page.tsx src/app/command/equipo/equipo-client.tsx src/components/nav-config.ts src/components/__tests__/nav-config.test.ts src/app/command/page.tsx src/app/command/resumen-client.tsx
git commit -m "feat(v3.0): equipo page (invitar/quitar operadores) + resumen kill-switch admin-gated"
```

---

### Task 7: Deploy notes + runbook

**Files:**
- Modify: `docs/superpowers/DEPLOY-NOTES-command-center.md` (append a `## v3.0` section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Append the v3.0 section**

Follow the existing per-release format in the file. Must cover, concretely:

1. **New envs** (set in Coolify, then restart): `COMMAND_WORKSPACE_IDS` (comma-separated workspace UUIDs with operator seats — **unset = no operator seats, today's posture**), `SUPABASE_SERVICE_ROLE_KEY` (Supabase dashboard → Settings → API; without it the Equipo page answers 501), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (without them notifications stay silently off), optional `CC_NOTIFY_ENABLED=false` master off-switch, optional `NEXT_PUBLIC_APP_URL`.
2. **Migration 011** (`cc_notifications`): Pedro clicks POST `/api/migrate` (admin-session-gated) after deploy. Notifications no-op harmlessly if the table is missing (insert error → caught → no send), but run the migration before setting `TELEGRAM_*`.
3. **RUNBOOK — before setting `COMMAND_WORKSPACE_IDS`** (spec §g risk 3, verbatim): enumerate `workspace_members` for the target workspace UUID and confirm every listed email is expected to receive Command access — membership in an allow-listed workspace IS an operator seat, and Meta accounts are shared across all operators (spec finding #2).
4. **First-operator bring-up (recommended path):** don't trust the email invite yet — POST the colleague's Google-linked email through Equipo (creates the membership row), have them log in with "Continuar con Google". Prove `inviteUserByEmail` with a throwaway address first; customize the Supabase invite email template to es-MX in the dashboard.
5. **What operators can/can't do** (the §b matrix in two lines): everything operational within their allow-listed workspaces (proponer/aprobar/ejecutar/revertir/copiloto/importar); never `/admin`, `/api/migrate`, settings POST, or the Equipo page.
6. **Rollback:** unset `COMMAND_WORKSPACE_IDS` → instantly back to admin-only (no code path depends on it being set); unset `TELEGRAM_*` → notifications off; `cc_notifications` rows are inert history.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/DEPLOY-NOTES-command-center.md
git commit -m "docs(v3.0): deploy notes — envs, allow-list runbook, first-operator bring-up"
```

---

## Self-Review Notes

- **Spec coverage:** §a → Tasks 1-2; §b matrix → Tasks 1 (structural), 3 (settings POST), 5 (equipo), 6 (UI gating); §c → Tasks 3-4; §d → Tasks 5-6; §e/§f → the task set matches the spec's file plan exactly; §g risks 1/2/4/5/7 have named tests, risk 3 is the Task 7 runbook step, risk 6 is flagged-not-fixed by design.
- **Type consistency:** `CommandRole`/`requireAdmin` (Task 1) consumed in Tasks 3/5/6; `NovedadItemRef.workspaceId` (Task 3) consumed by Task 4's `insertIfNew(item.workspaceId, …)`; `navGroups(commandCenter, isPlatformAdmin)` (Task 2) extended in Task 6 with the same signature.
- **Known verification points for implementers** (marked inline): the Supabase URL env name in Task 5 Step 1; the `invited_by` column's existence in Task 5 Step 2; `PageHeader` props in Task 6 Step 3. Each has an explicit fallback instruction — none is a TBD.
