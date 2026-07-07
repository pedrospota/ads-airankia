# Centro de Mando (beta) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the "Centro de Mando" beta — a multi-network (Google Ads + Meta Ads) L2 execution rail: action queue → deterministic gates → API execution → append-only ledger → one-click rollback, behind `COMMAND_CENTER_BETA` + admin gating.

**Architecture:** New self-contained module `src/lib/command/` (pure domain core + network adapters + executor), three additive ADS-DB tables (`cc_actions`, `cc_executions`, `cc_settings`) applied via the existing `/api/migrate` mechanism, thin `/api/command/*` route handlers following house auth patterns, and four ui-kit pages under `/command`. Spec: `docs/superpowers/specs/2026-07-07-command-center-beta-design.md` (READ IT FIRST).

**Tech Stack:** Next.js 16.2.2 App Router (async `params`/`cookies`, `force-dynamic`, nodejs runtime), TypeScript 5, Drizzle ORM + pg (ADS DB), Supabase SSR (auth/RLS), `bun test` for unit tests, Google Ads REST API v21, Meta Marketing (Graph) API.

---

## Repo conventions primer (read before ANY task)

- **Branch:** work on `feat/command-center-beta`. NEVER push to `main`/origin (prod auto-deploys). Commit locally after every task.
- **Next.js 16 rules:** `params`/`searchParams` are `Promise`s — `await` them. `await cookies()`/`await headers()`. Route handlers export `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`. No middleware exists — auth is per-page/per-route.
- **Auth in routes (house pattern):**
  ```ts
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: { session } } = await authClient.auth.getSession();
  const db = createSupabaseReadClient(session?.access_token); // RLS-scoped reads
  ```
- **UI:** Spanish copy (es-MX). Server page (auth → fetch → nullable `error`) + `*-client.tsx` island. Compose `PageHeader/Card/StatCard/DataTable/THead/Row/Cell/Badge/EmptyState/ErrorCard/PrimaryButton/SecondaryButton/GhostDangerButton` + `UI` tokens from `@/components/ui-kit`. `export const dynamic = "force-dynamic"`.
- **Imports:** path alias `@/*` → `./src/*`.
- **Tests:** `bun test src/lib/command` (bun:test built-in; test files at `src/lib/command/__tests__/*.test.ts`). Mock `globalThis.fetch`; restore in `afterEach`.
- **Never touch:** `src/lib/google-ads.ts`, `src/lib/agents/*`, `/api/campaigns/*`, `/api/search/*`, `src/lib/copiloto-tools.ts` (except NO files here need changes), engine code. The platform env `GOOGLE_ADS_REFRESH_TOKEN` must never be read by command-center code.
- **Money units:** ALL budgets normalized to **micros** (1 unit = 1,000,000 micros) inside the module. Google speaks micros natively; Meta speaks minor units (cents) — adapter converts (`micros / 10_000 = cents`).
- Typecheck when asked: `bunx tsc --noEmit` (slow; only where a step says so).

---

### Task 1: Test harness, core types, request hash

**Files:**
- Modify: `package.json` (add test script)
- Create: `src/lib/command/types.ts`
- Create: `src/lib/command/request-hash.ts`
- Test: `src/lib/command/__tests__/request-hash.test.ts`

- [ ] **Step 1: Add test script to package.json**

In `package.json` `"scripts"`, add after `"lint"`:
```json
"test": "bun test src/lib/command"
```

- [ ] **Step 2: Write the failing test**

`src/lib/command/__tests__/request-hash.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { canonicalJson, requestHash } from "../request-hash";

describe("canonicalJson", () => {
  it("sorts object keys recursively and is stable", () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } });
    const b = canonicalJson({ a: { c: 2, d: [3, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it("preserves array order", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });
});

describe("requestHash", () => {
  it("returns a 64-char sha256 hex, stable across key order", () => {
    const h1 = requestHash({ op: "campaigns:mutate", body: { x: 1, y: 2 } });
    const h2 = requestHash({ body: { y: 2, x: 1 }, op: "campaigns:mutate" });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/coder/projects/ads-airankia && bun test src/lib/command`
Expected: FAIL (cannot resolve `../request-hash`).

- [ ] **Step 4: Create `src/lib/command/types.ts`** (pure contract — no env, no runtime deps; mirrors `src/lib/engine/types.ts` frozen-contract style)

```ts
// Centro de Mando — frozen domain contract. Pure types + constants only.
// No env access, no side effects. See docs/superpowers/specs/2026-07-07-command-center-beta-design.md

export type CcNetwork = "google_ads" | "meta_ads";
export type CcEntityKind = "campaign" | "ad_group" | "adset";

// User-selectable action types. "remove_negatives" is INTERNAL-ONLY: it exists
// so rollbacks of add_negatives can be expressed as an action; it is never
// user-proposable and never allowed by cc_settings.allowed_action_types.
export type CcActionType = "budget_update" | "pause" | "enable" | "add_negatives";
export type CcInternalActionType = CcActionType | "remove_negatives";

export const CC_ACTION_TYPES: CcActionType[] = ["budget_update", "pause", "enable", "add_negatives"];

export type CcActionStatus =
  | "proposed" | "approved" | "executing" | "executed"
  | "verified" | "failed" | "rolled_back" | "rejected" | "expired";

export type CcSource = "engine" | "manual" | "regla" | "copiloto";

export interface BudgetUpdatePayload { newDailyBudgetMicros: number }
export interface NegativesPayload {
  negatives: Array<{ text: string; match: "EXACT" | "PHRASE" | "BROAD" }>;
}
/** pause/enable carry an empty payload. remove_negatives carries resourceNames. */
export interface RemoveNegativesPayload { resourceNames: string[] }
export type CcPayload =
  | BudgetUpdatePayload | NegativesPayload | RemoveNegativesPayload | Record<string, never>;

/** What the executor hands to an adapter. */
export interface CcActionInput {
  actionType: CcInternalActionType;
  entityKind: CcEntityKind;
  entityRef: string;          // Google campaign/adGroup id · Meta campaign/adset id
  payload: CcPayload;
}

export interface AdapterAuth {
  /** Google: decrypted per-connection refresh token (memory only). */
  googleRefreshToken?: string;
  /** Google: manager id when the target account is reached through an MCC. */
  googleLoginCustomerId?: string;
}

export interface AdapterCapabilities {
  read: boolean;
  write: boolean;
  actionTypes: CcInternalActionType[];
  reason?: string;            // e.g. "META_SYSTEM_USER_TOKEN no configurado"
}

export interface EntitySnapshot {
  entityKind: CcEntityKind;
  entityRef: string;
  name?: string | null;
  status?: "ENABLED" | "PAUSED" | "REMOVED" | "ARCHIVED" | "UNKNOWN";
  dailyBudgetMicros?: number | null;   // ALWAYS micros, both networks
  budgetResourceName?: string | null;  // Google: customers/x/campaignBudgets/y
  currency?: string | null;
  learningPhase?: "LEARNING" | "LIMITED" | "STABLE" | "UNKNOWN";
  conversions30d?: number | null;
  spend30dMicros?: number | null;
  raw?: Record<string, unknown>;
}

export interface ExecuteResult {
  operation: string;                    // "campaignBudgets:mutate" | "POST /{id}" ...
  request: unknown;
  response: unknown;
  resourceNames?: string[];             // created resources (negatives) for rollback
}

export interface RollbackRecipe {
  action: CcActionInput;
  note: string;                         // human-readable Spanish description
}

export interface AccountInfo {
  network: CcNetwork;
  accountRef: string;                   // Google customer_id · Meta "act_123"
  name?: string | null;
  currency?: string | null;
  connectionId?: string | null;         // Supabase ads_google_connections.id
}

export interface NetworkAdapter {
  network: CcNetwork;
  capabilities(auth: AdapterAuth): AdapterCapabilities;
  listCampaigns(auth: AdapterAuth, accountRef: string): Promise<EntitySnapshot[]>;
  snapshot(auth: AdapterAuth, accountRef: string, entityKind: CcEntityKind, entityRef: string): Promise<EntitySnapshot>;
  /** Google only: server-side rehearsal via validateOnly. Meta: undefined. */
  validate?(auth: AdapterAuth, accountRef: string, action: CcActionInput, before: EntitySnapshot): Promise<{ ok: boolean; detail?: string }>;
  execute(auth: AdapterAuth, accountRef: string, action: CcActionInput, before: EntitySnapshot): Promise<ExecuteResult>;
  buildRollback(action: CcActionInput, before: EntitySnapshot, exec: ExecuteResult): RollbackRecipe | null;
}

export interface GateResult {
  id: string;
  severity: "blocking" | "warning";
  status: "pass" | "fail";
  evidence: string;
}

export interface CcSettingsValues {
  executionsPaused: boolean;
  maxBudgetDeltaPct: number;
  maxActionsPerAccountDay: number;
  requireTwoStep: boolean;
  allowedActionTypes: CcActionType[];
  watchHours: number;
}

export const CC_SETTINGS_DEFAULTS: CcSettingsValues = {
  executionsPaused: false,
  maxBudgetDeltaPct: 30,
  maxActionsPerAccountDay: 20,
  requireTwoStep: true,
  allowedActionTypes: [...CC_ACTION_TYPES],
  watchHours: 72,
};

export const MICROS_PER_UNIT = 1_000_000;
/** Meta daily_budget is in minor units (cents). cents * 10_000 = micros. */
export const MICROS_PER_MINOR_UNIT = 10_000;
```

- [ ] **Step 5: Create `src/lib/command/request-hash.ts`**

```ts
import { createHash } from "crypto";

/** Deterministic JSON: objects get sorted keys (recursive); arrays keep order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/lib/command`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json src/lib/command
git commit -m "feat(command): domain contract, canonical request hash, bun test harness"
```

---

### Task 2: Action status state machine

**Files:**
- Create: `src/lib/command/state.ts`
- Test: `src/lib/command/__tests__/state.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/command/__tests__/state.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { canTransition, assertTransition } from "../state";

describe("canTransition", () => {
  it("allows the happy path", () => {
    expect(canTransition("proposed", "approved")).toBe(true);
    expect(canTransition("approved", "executing")).toBe(true);
    expect(canTransition("executing", "executed")).toBe(true);
    expect(canTransition("executed", "rolled_back")).toBe(true);
    expect(canTransition("executed", "verified")).toBe(true);
  });
  it("allows rejection/expiry and retry-after-failure", () => {
    expect(canTransition("proposed", "rejected")).toBe(true);
    expect(canTransition("proposed", "expired")).toBe(true);
    expect(canTransition("approved", "rejected")).toBe(true);
    expect(canTransition("executing", "failed")).toBe(true);
    expect(canTransition("failed", "approved")).toBe(true); // re-arm after fix
  });
  it("blocks illegal jumps", () => {
    expect(canTransition("proposed", "executed")).toBe(false);
    expect(canTransition("proposed", "executing")).toBe(false);
    expect(canTransition("rejected", "executing")).toBe(false);
    expect(canTransition("rolled_back", "executed")).toBe(false);
    expect(canTransition("executed", "approved")).toBe(false);
  });
  it("assertTransition throws in Spanish", () => {
    expect(() => assertTransition("proposed", "executed")).toThrow(/Transición inválida/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/command`
Expected: FAIL (cannot resolve `../state`).

- [ ] **Step 3: Create `src/lib/command/state.ts`**

```ts
import type { CcActionStatus } from "./types";

const TRANSITIONS: Record<CcActionStatus, CcActionStatus[]> = {
  proposed: ["approved", "rejected", "expired"],
  approved: ["executing", "rejected", "expired"],
  executing: ["executed", "failed"],
  executed: ["verified", "rolled_back"],
  verified: ["rolled_back"],
  failed: ["approved", "rejected"],
  rolled_back: [],
  rejected: [],
  expired: [],
};

export function canTransition(from: CcActionStatus, to: CcActionStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: CcActionStatus, to: CcActionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transición inválida: ${from} → ${to}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/command`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/command
git commit -m "feat(command): action lifecycle state machine"
```

---

### Task 3: Drizzle schema + /api/migrate 007_command_center

**Files:**
- Modify: `src/lib/schema.ts` (append at end of file)
- Modify: `src/app/api/migrate/route.ts` (append to the `migrations` array, before the closing `];`)

- [ ] **Step 1: Append cc tables to `src/lib/schema.ts`** (end of file; follow the `googleMutations` idiom exactly)

```ts
// ============================================================
// Centro de Mando (beta) — multi-network execution rail.
// Spec: docs/superpowers/specs/2026-07-07-command-center-beta-design.md
// ============================================================

export const ccActions = pgTable(
  "cc_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    createdBy: text("created_by").notNull(), // session email
    network: text("network").notNull(), // google_ads|meta_ads
    connectionId: uuid("connection_id"), // Supabase ads_google_connections.id (null for Meta env-token)
    accountRef: text("account_ref").notNull(), // Google customer_id | Meta act_<id>
    entityKind: text("entity_kind").notNull(), // campaign|ad_group|adset
    entityRef: text("entity_ref").notNull(),
    entityName: text("entity_name"),
    actionType: text("action_type").notNull(), // budget_update|pause|enable|add_negatives
    payload: jsonb("payload").notNull(),
    expected: jsonb("expected"), // before-values captured at approve time (drift baseline)
    source: text("source").default("manual").notNull(), // engine|manual|regla|copiloto
    recKey: text("rec_key"), // dedup with engine proposals
    rationale: text("rationale"),
    evidence: jsonb("evidence"),
    status: text("status").default("proposed").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    gateResults: jsonb("gate_results"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_cc_actions_workspace").on(table.workspaceId),
    index("idx_cc_actions_status").on(table.status),
    index("idx_cc_actions_account").on(table.accountRef),
  ]
);

export const ccExecutions = pgTable(
  "cc_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionId: uuid("action_id")
      .references(() => ccActions.id)
      .notNull(),
    attempt: integer("attempt").default(1).notNull(),
    network: text("network").notNull(),
    accountRef: text("account_ref").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    validateOnly: boolean("validate_only").default(false).notNull(),
    before: jsonb("before").notNull(),
    request: jsonb("request"),
    response: jsonb("response"),
    after: jsonb("after"),
    rollbackRecipe: jsonb("rollback_recipe"),
    status: text("status").default("pending").notNull(), // pending|done|failed|rolled_back
    actor: text("actor").notNull(), // session email
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_cc_executions_action").on(table.actionId),
    uniqueIndex("uq_cc_executions_attempt").on(table.actionId, table.requestHash, table.attempt),
  ]
);

export const ccSettings = pgTable("cc_settings", {
  workspaceId: uuid("workspace_id").primaryKey(),
  executionsPaused: boolean("executions_paused").default(false).notNull(), // kill switch
  maxBudgetDeltaPct: integer("max_budget_delta_pct").default(30).notNull(),
  maxActionsPerAccountDay: integer("max_actions_per_account_day").default(20).notNull(),
  requireTwoStep: boolean("require_two_step").default(true).notNull(),
  allowedActionTypes: jsonb("allowed_action_types")
    .default(["budget_update", "pause", "enable", "add_negatives"])
    .notNull(),
  watchHours: integer("watch_hours").default(72).notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
```

- [ ] **Step 2: Append the 007 block to `/api/migrate`**

In `src/app/api/migrate/route.ts`, inside the `migrations = [` array, immediately before the final `];`, add:

```ts
    // 007_command_center — Centro de Mando (beta): action queue, execution
    // ledger, per-workspace guardrails. All additive.
    sql`CREATE TABLE IF NOT EXISTS cc_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL,
      created_by TEXT NOT NULL,
      network TEXT NOT NULL,
      connection_id UUID,
      account_ref TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_ref TEXT NOT NULL,
      entity_name TEXT,
      action_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      expected JSONB,
      source TEXT NOT NULL DEFAULT 'manual',
      rec_key TEXT,
      rationale TEXT,
      evidence JSONB,
      status TEXT NOT NULL DEFAULT 'proposed',
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      gate_results JSONB,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE INDEX IF NOT EXISTS idx_cc_actions_workspace ON cc_actions(workspace_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_cc_actions_status ON cc_actions(status)`,
    sql`CREATE INDEX IF NOT EXISTS idx_cc_actions_account ON cc_actions(account_ref)`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_actions_reckey ON cc_actions(workspace_id, network, rec_key) WHERE rec_key IS NOT NULL`,
    sql`CREATE TABLE IF NOT EXISTS cc_executions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      action_id UUID NOT NULL,
      attempt INT NOT NULL DEFAULT 1,
      network TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      validate_only BOOLEAN NOT NULL DEFAULT false,
      before JSONB NOT NULL,
      request JSONB,
      response JSONB,
      after JSONB,
      rollback_recipe JSONB,
      status TEXT NOT NULL DEFAULT 'pending',
      actor TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE INDEX IF NOT EXISTS idx_cc_executions_action ON cc_executions(action_id)`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_executions_attempt ON cc_executions(action_id, request_hash, attempt)`,
    sql`CREATE TABLE IF NOT EXISTS cc_settings (
      workspace_id UUID PRIMARY KEY,
      executions_paused BOOLEAN NOT NULL DEFAULT false,
      max_budget_delta_pct INT NOT NULL DEFAULT 30,
      max_actions_per_account_day INT NOT NULL DEFAULT 20,
      require_two_step BOOLEAN NOT NULL DEFAULT true,
      allowed_action_types JSONB NOT NULL DEFAULT '["budget_update","pause","enable","add_negatives"]',
      watch_hours INT NOT NULL DEFAULT 72,
      updated_by TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`INSERT INTO schema_migrations (version) VALUES ('007_command_center') ON CONFLICT (version) DO NOTHING`,
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no NEW errors (if pre-existing errors exist, note them and ensure none mention `cc_` or `command`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/schema.ts src/app/api/migrate/route.ts
git commit -m "feat(command): cc_actions/cc_executions/cc_settings schema + 007 migration"
```

---

### Task 4: Gate engine (pure, fully tested)

**Files:**
- Create: `src/lib/command/gates.ts`
- Test: `src/lib/command/__tests__/gates.test.ts`
- Modify: `src/lib/command/types.ts` (add one settings field — see Step 0)

> **AMENDMENT (2026-07-07 post-harvest).** Two gates are added on top of the base 10:
> **`ABS_BUDGET_CAP`** (blocking — absolute per-entity daily-budget ceiling, adopted
> from attainmentlabs `MAX_DAILY_BUDGET` + FGRibreau `GOOGLE_ADS_MAX_DAILY_BUDGET`)
> and **`META_LEARNING_RESET`** (warning — Meta budget delta >20% resets the learning
> phase; source: marketingskills/NotFair "significant edit" threshold). This adds one
> settings field, one migration column (apply in Task 3), and two gate functions +
> tests below. The base-10 code in Steps 1/3 stays verbatim; apply these deltas too.

- [ ] **Step 0: Add the `maxDailyBudgetMicros` settings field (amends committed Task 1 files)**

In `src/lib/command/types.ts`, in `CcSettingsValues` add after `allowedActionTypes`:
```ts
  /** Absolute per-entity daily-budget ceiling in micros; null = disabled. */
  maxDailyBudgetMicros: number | null;
```
and in `CC_SETTINGS_DEFAULTS` add:
```ts
  maxDailyBudgetMicros: null,
```
In `src/lib/command/settings.ts` (created in Task 7) `rowToSettings`, add to the returned object:
```ts
    maxDailyBudgetMicros: row.maxDailyBudgetMicros == null ? null : Number(row.maxDailyBudgetMicros),
```
and thread it through `saveCcSettings` insert/update like the other fields.
In `src/lib/schema.ts` `ccSettings` (Task 3) add:
```ts
  maxDailyBudgetMicros: bigint("max_daily_budget_micros", { mode: "number" }),
```
and in the `/api/migrate` 007 block add inside `cc_settings`:
```sql
      max_daily_budget_micros BIGINT,
```
Run `bun test src/lib/command` to confirm the existing settings test still passes
(null default is covered by `CC_SETTINGS_DEFAULTS`).

- [ ] **Step 0b: Add the two gate tests** (append inside the `describe("gates", ...)` block)

```ts
  it("ABS_BUDGET_CAP blocks budgets over the absolute ceiling", () => {
    const settings = { ...CC_SETTINGS_DEFAULTS, maxDailyBudgetMicros: 50_000_000 };
    const over = runGates(baseInput({ settings,
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 60_000_000 } } }));
    expect(blockingFailures(over).map(r => r.id)).toContain("ABS_BUDGET_CAP");
    const under = runGates(baseInput({ settings,
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 12_000_000 } } }));
    expect(under.filter(r => r.status === "fail").map(r => r.id)).not.toContain("ABS_BUDGET_CAP");
  });
  it("ABS_BUDGET_CAP passes when no ceiling configured", () => {
    const rs = runGates(baseInput({
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 999_000_000 } } }));
    expect(rs.find(r => r.id === "ABS_BUDGET_CAP")?.status).toBe("pass");
  });
  it("META_LEARNING_RESET warns on Meta budget delta over 20%", () => {
    const rs = runGates(baseInput({ network: "meta_ads", validateResult: null,
      before: baseBefore({ entityKind: "adset", dailyBudgetMicros: 10_000_000 }),
      action: { actionType: "budget_update", entityKind: "adset", entityRef: "123", payload: { newDailyBudgetMicros: 12_500_000 } } }));
    const g = rs.find(r => r.id === "META_LEARNING_RESET");
    expect(g?.status).toBe("fail");
    expect(g?.severity).toBe("warning");
    expect(blockingFailures(rs).map(r => r.id)).not.toContain("META_LEARNING_RESET");
  });
  it("META_LEARNING_RESET passes on Google or small Meta deltas", () => {
    expect(runGates(baseInput()).find(r => r.id === "META_LEARNING_RESET")?.status).toBe("pass");
  });
```

- [ ] **Step 0c: Add the two gate functions + registration to `src/lib/command/gates.ts`** (defined in Step 3; add these alongside the others and append both to the `GATES` array before `runGates`)

```ts
const absBudgetCap: Gate = (i) => {
  if (i.action.actionType !== "budget_update" || i.settings.maxDailyBudgetMicros == null) {
    return gate("ABS_BUDGET_CAP", "blocking", true, "No aplica (sin tope absoluto o no es presupuesto).");
  }
  const next = budgetMicros(i);
  const ok = next !== null && next <= i.settings.maxDailyBudgetMicros;
  return gate("ABS_BUDGET_CAP", "blocking", ok,
    ok ? `Presupuesto ${next} ≤ tope ${i.settings.maxDailyBudgetMicros} micros.`
       : `Presupuesto ${next} supera el tope absoluto ${i.settings.maxDailyBudgetMicros} micros.`);
};

const metaLearningReset: Gate = (i) => {
  if (i.network !== "meta_ads" || i.action.actionType !== "budget_update") {
    return gate("META_LEARNING_RESET", "warning", true, "No aplica.");
  }
  const next = budgetMicros(i);
  const prev = i.before.dailyBudgetMicros ?? null;
  if (next === null || prev === null || prev <= 0) return gate("META_LEARNING_RESET", "warning", true, "Sin base para evaluar reinicio de aprendizaje.");
  const deltaPct = Math.abs(next - prev) / prev * 100;
  return gate("META_LEARNING_RESET", "warning", deltaPct <= 20,
    deltaPct <= 20 ? `Delta ${deltaPct.toFixed(1)}% ≤ 20% (no reinicia aprendizaje).`
                   : `Delta ${deltaPct.toFixed(1)}% > 20%: reiniciará la fase de aprendizaje de Meta.`);
};
```
Register by changing the `GATES` array to include both: append `absBudgetCap, metaLearningReset` after `validateOnly`.

- [ ] **Step 1: Write the failing test**

`src/lib/command/__tests__/gates.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { runGates, blockingFailures, type GateInput } from "../gates";
import { CC_SETTINGS_DEFAULTS, type EntitySnapshot } from "../types";

function baseBefore(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return {
    entityKind: "campaign", entityRef: "123", name: "Test", status: "ENABLED",
    dailyBudgetMicros: 10_000_000, currency: "USD", learningPhase: "STABLE",
    conversions30d: 12, spend30dMicros: 500_000_000, ...over,
  };
}
function baseInput(over: Partial<GateInput> = {}): GateInput {
  return {
    settings: { ...CC_SETTINGS_DEFAULTS },
    network: "google_ads",
    action: { actionType: "pause", entityKind: "campaign", entityRef: "123", payload: {} },
    capabilities: { read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives"] },
    before: baseBefore(),
    expected: null,
    executedTodayForAccount: 0,
    validateResult: { ok: true },
    ...over,
  };
}
const failed = (rs: ReturnType<typeof runGates>) => rs.filter(r => r.status === "fail").map(r => r.id);

describe("gates", () => {
  it("all pass on a clean pause", () => {
    expect(failed(runGates(baseInput()))).toEqual([]);
  });
  it("KILL_SWITCH blocks when paused", () => {
    const rs = runGates(baseInput({ settings: { ...CC_SETTINGS_DEFAULTS, executionsPaused: true } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("KILL_SWITCH");
  });
  it("CAPABILITY blocks when adapter cannot write", () => {
    const rs = runGates(baseInput({ capabilities: { read: true, write: false, actionTypes: [], reason: "sin token" } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("CAPABILITY");
  });
  it("ACTION_ALLOWED blocks types outside settings", () => {
    const rs = runGates(baseInput({ settings: { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: ["pause"] },
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 11_000_000 } } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("ACTION_ALLOWED");
  });
  it("DRIFT blocks when live state departed from expected", () => {
    const rs = runGates(baseInput({ expected: { status: "PAUSED" } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("DRIFT");
    const ok = runGates(baseInput({ expected: { status: "ENABLED", dailyBudgetMicros: 10_000_000 } }));
    expect(failed(ok)).toEqual([]);
  });
  it("BUDGET_DELTA blocks >30% and nonpositive; passes 20%", () => {
    const mk = (n: number) => baseInput({ action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: n } } });
    expect(blockingFailures(runGates(mk(14_000_000))).map(r => r.id)).toContain("BUDGET_DELTA"); // +40%
    expect(blockingFailures(runGates(mk(0))).map(r => r.id)).toContain("BUDGET_DELTA");
    expect(failed(runGates(mk(12_000_000)))).toEqual([]); // +20%
  });
  it("BUDGET_DELTA blocks when no baseline budget", () => {
    const rs = runGates(baseInput({
      before: baseBefore({ dailyBudgetMicros: null }),
      action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: 12_000_000 } },
    }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("BUDGET_DELTA");
  });
  it("BLAST_RADIUS blocks at the daily cap", () => {
    const rs = runGates(baseInput({ executedTodayForAccount: 20 }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("BLAST_RADIUS");
  });
  it("CURRENCY_SANITY blocks non-integer or sub-minimum budgets", () => {
    const mk = (n: number) => baseInput({ action: { actionType: "budget_update", entityKind: "campaign", entityRef: "123", payload: { newDailyBudgetMicros: n } } });
    expect(blockingFailures(runGates(mk(10_000_000.5))).map(r => r.id)).toContain("CURRENCY_SANITY");
    expect(blockingFailures(runGates(mk(900_000))).map(r => r.id)).toContain("CURRENCY_SANITY"); // < 1 unit
  });
  it("LEARNING_PHASE: blocking on meta adset learning + budget/enable; warning on google", () => {
    const meta = runGates(baseInput({
      network: "meta_ads",
      before: baseBefore({ entityKind: "adset", learningPhase: "LEARNING", dailyBudgetMicros: 10_000_000 }),
      action: { actionType: "budget_update", entityKind: "adset", entityRef: "123", payload: { newDailyBudgetMicros: 11_000_000 } },
      validateResult: null,
    }));
    expect(blockingFailures(meta).map(r => r.id)).toContain("LEARNING_PHASE");
    const goog = runGates(baseInput({ before: baseBefore({ learningPhase: "LEARNING" }) }));
    const lp = goog.find(r => r.id === "LEARNING_PHASE");
    expect(lp?.status).toBe("fail");
    expect(lp?.severity).toBe("warning");
  });
  it("TRACKING_SIGNAL warns on spend with zero conversions", () => {
    const rs = runGates(baseInput({ before: baseBefore({ conversions30d: 0, spend30dMicros: 100_000_000 }) }));
    const t = rs.find(r => r.id === "TRACKING_SIGNAL");
    expect(t?.status).toBe("fail");
    expect(t?.severity).toBe("warning");
    expect(blockingFailures(rs)).toHaveLength(0);
  });
  it("VALIDATE_ONLY blocks on failed google rehearsal; ignored for meta", () => {
    const rs = runGates(baseInput({ validateResult: { ok: false, detail: "INVALID_ARGUMENT" } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("VALIDATE_ONLY");
    const meta = runGates(baseInput({ network: "meta_ads", validateResult: null }));
    expect(failed(meta)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/command`
Expected: FAIL (cannot resolve `../gates`).

- [ ] **Step 3: Create `src/lib/command/gates.ts`**

```ts
import type {
  AdapterCapabilities, CcEntityKind, CcInternalActionType, CcNetwork,
  CcPayload, CcSettingsValues, EntitySnapshot, GateResult,
} from "./types";
import { MICROS_PER_UNIT } from "./types";

export interface GateInput {
  settings: CcSettingsValues;
  network: CcNetwork;
  action: { actionType: CcInternalActionType; entityKind: CcEntityKind; entityRef: string; payload: CcPayload };
  capabilities: AdapterCapabilities;
  before: EntitySnapshot;
  /** Baseline captured at approve time. Only present fields are compared. */
  expected?: Partial<EntitySnapshot> | null;
  executedTodayForAccount: number;
  /** Google validateOnly rehearsal result; null when not applicable. */
  validateResult?: { ok: boolean; detail?: string } | null;
}

type Gate = (input: GateInput) => GateResult;

const gate = (
  id: string, severity: GateResult["severity"], pass: boolean, evidence: string
): GateResult => ({ id, severity, status: pass ? "pass" : "fail", evidence });

function budgetMicros(input: GateInput): number | null {
  const p = input.action.payload as { newDailyBudgetMicros?: unknown };
  return typeof p?.newDailyBudgetMicros === "number" ? p.newDailyBudgetMicros : null;
}

const killSwitch: Gate = (i) =>
  gate("KILL_SWITCH", "blocking", !i.settings.executionsPaused,
    i.settings.executionsPaused ? "Ejecuciones pausadas (kill switch activo en ajustes)." : "Kill switch inactivo.");

const capability: Gate = (i) => {
  const ok = i.capabilities.write && i.capabilities.actionTypes.includes(i.action.actionType);
  return gate("CAPABILITY", "blocking", ok,
    ok ? "El adaptador soporta escritura y este tipo de acción."
       : `Adaptador sin capacidad: ${i.capabilities.reason ?? `no soporta ${i.action.actionType}`}.`);
};

const actionAllowed: Gate = (i) => {
  // Internal rollback type is always allowed (a rollback restores prior state).
  if (i.action.actionType === "remove_negatives") {
    return gate("ACTION_ALLOWED", "blocking", true, "remove_negatives (rollback interno).");
  }
  const ok = (i.settings.allowedActionTypes as string[]).includes(i.action.actionType);
  return gate("ACTION_ALLOWED", "blocking", ok,
    ok ? `${i.action.actionType} permitido por ajustes.` : `${i.action.actionType} no está en allowed_action_types.`);
};

const drift: Gate = (i) => {
  if (!i.expected) return gate("DRIFT", "blocking", true, "Sin baseline registrado (acción sin expected).");
  const problems: string[] = [];
  if (i.expected.status !== undefined && i.expected.status !== i.before.status) {
    problems.push(`status esperado ${i.expected.status}, real ${i.before.status}`);
  }
  if (
    i.expected.dailyBudgetMicros !== undefined && i.expected.dailyBudgetMicros !== null &&
    i.before.dailyBudgetMicros !== undefined && i.before.dailyBudgetMicros !== null &&
    i.expected.dailyBudgetMicros !== i.before.dailyBudgetMicros
  ) {
    problems.push(`presupuesto esperado ${i.expected.dailyBudgetMicros}, real ${i.before.dailyBudgetMicros}`);
  }
  return gate("DRIFT", "blocking", problems.length === 0,
    problems.length ? `La entidad cambió desde la aprobación: ${problems.join("; ")}.` : "Estado real coincide con el baseline.");
};

const budgetDelta: Gate = (i) => {
  if (i.action.actionType !== "budget_update") return gate("BUDGET_DELTA", "blocking", true, "No aplica (no es cambio de presupuesto).");
  const next = budgetMicros(i);
  const prev = i.before.dailyBudgetMicros ?? null;
  if (next === null || next <= 0) return gate("BUDGET_DELTA", "blocking", false, "Presupuesto nuevo ausente o ≤ 0.");
  if (prev === null || prev <= 0) return gate("BUDGET_DELTA", "blocking", false, "Sin presupuesto base medible para calcular el delta.");
  const deltaPct = Math.abs(next - prev) / prev * 100;
  return gate("BUDGET_DELTA", "blocking", deltaPct <= i.settings.maxBudgetDeltaPct,
    `Delta ${deltaPct.toFixed(1)}% (límite ${i.settings.maxBudgetDeltaPct}%).`);
};

const blastRadius: Gate = (i) =>
  gate("BLAST_RADIUS", "blocking", i.executedTodayForAccount < i.settings.maxActionsPerAccountDay,
    `${i.executedTodayForAccount}/${i.settings.maxActionsPerAccountDay} acciones ejecutadas hoy en esta cuenta.`);

const currencySanity: Gate = (i) => {
  if (i.action.actionType !== "budget_update") return gate("CURRENCY_SANITY", "blocking", true, "No aplica.");
  const next = budgetMicros(i);
  const ok = next !== null && Number.isInteger(next) && next >= MICROS_PER_UNIT;
  return gate("CURRENCY_SANITY", "blocking", ok,
    ok ? `Presupuesto ${next} micros (≥ 1 unidad, entero).` : `Presupuesto inválido: ${next} micros (mínimo ${MICROS_PER_UNIT}, entero).`);
};

const learningPhase: Gate = (i) => {
  const learning = i.before.learningPhase === "LEARNING" || i.before.learningPhase === "LIMITED";
  const scaling = i.action.actionType === "budget_update" || i.action.actionType === "enable";
  if (!learning) return gate("LEARNING_PHASE", "blocking", true, `Fase: ${i.before.learningPhase ?? "desconocida"}.`);
  if (i.network === "meta_ads" && i.action.entityKind === "adset" && scaling) {
    return gate("LEARNING_PHASE", "blocking", false, "Ad set en fase de aprendizaje: no escalar/activar hasta salir de learning.");
  }
  return gate("LEARNING_PHASE", "warning", false, "Entidad en aprendizaje: cambio desaconsejado (advertencia).");
};

const trackingSignal: Gate = (i) => {
  const spend = i.before.spend30dMicros ?? 0;
  const conv = i.before.conversions30d;
  const blind = conv === 0 && spend > 0;
  return gate("TRACKING_SIGNAL", "warning", !blind,
    blind ? "Gasto en 30d sin conversiones registradas: revisar medición antes de operar." : "Señal de conversión presente o sin gasto.");
};

const validateOnly: Gate = (i) => {
  if (i.network !== "google_ads") return gate("VALIDATE_ONLY", "blocking", true, "No aplica (solo Google).");
  if (!i.validateResult) return gate("VALIDATE_ONLY", "blocking", false, "Falta el ensayo validateOnly de Google.");
  return gate("VALIDATE_ONLY", "blocking", i.validateResult.ok,
    i.validateResult.ok ? "Ensayo validateOnly aprobado por Google." : `Google rechazó el ensayo: ${i.validateResult.detail ?? "error"}.`);
};

const GATES: Gate[] = [
  killSwitch, capability, actionAllowed, drift, budgetDelta,
  blastRadius, currencySanity, learningPhase, trackingSignal, validateOnly,
];

export function runGates(input: GateInput): GateResult[] {
  return GATES.map((g) => g(input));
}

export function blockingFailures(results: GateResult[]): GateResult[] {
  return results.filter((r) => r.severity === "blocking" && r.status === "fail");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/command`
Expected: PASS (all gate tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/command
git commit -m "feat(command): deterministic gate engine (10 gates, full test matrix)"
```

---

### Task 5: Google Ads adapter (per-connection tokens, validateOnly rehearsal)

**Files:**
- Create: `src/lib/command/networks/google.ts`
- Test: `src/lib/command/__tests__/google-adapter.test.ts`

Context you need: auth uses the **workspace's connected account** refresh token (decrypted upstream and passed in `AdapterAuth.googleRefreshToken`) — never `process.env.GOOGLE_ADS_REFRESH_TOKEN`. `mintAccessToken(refreshToken)` already exists in `@/lib/ads-connections` (it POSTs `https://oauth2.googleapis.com/token` with `GOOGLE_ADS_CLIENT_ID/SECRET` env). Mirror the mutate body idiom of `src/lib/google-ads.ts` `updateBudget()` (`updateMask: "amount_micros"`, `amountMicros: String(n)`).

- [ ] **Step 1: Write the failing test**

`src/lib/command/__tests__/google-adapter.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { googleAdapter } from "../networks/google";
import type { EntitySnapshot } from "../types";

const AUTH = { googleRefreshToken: "rt-1", googleLoginCustomerId: "9999999999" };
let calls: Array<{ url: string; init?: RequestInit }> = [];
let responder: (url: string, init?: RequestInit) => unknown = () => ({});
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  process.env.GOOGLE_ADS_CLIENT_ID = "cid";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "devtok";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(responder(url, init)), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

function before(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return { entityKind: "campaign", entityRef: "111", status: "ENABLED",
    dailyBudgetMicros: 10_000_000, budgetResourceName: "customers/123/campaignBudgets/77", ...over };
}

describe("googleAdapter", () => {
  it("capabilities: write on when refresh token present", () => {
    expect(googleAdapter.capabilities(AUTH).write).toBe(true);
    expect(googleAdapter.capabilities({}).write).toBe(false);
  });

  it("snapshot parses structure + sums 30d metrics", async () => {
    responder = (url, init) => {
      const q = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
      if (q.includes("segments.date DURING LAST_30_DAYS")) {
        return { results: [
          { metrics: { conversions: 2.5, costMicros: "3000000" } },
          { metrics: { conversions: 1.5, costMicros: "2000000" } },
        ] };
      }
      return { results: [{
        campaign: { id: "111", name: "Marca", status: "ENABLED", campaignBudget: "customers/123/campaignBudgets/77" },
        campaignBudget: { amountMicros: "10000000" },
        customer: { currencyCode: "USD" },
      }] };
    };
    const snap = await googleAdapter.snapshot(AUTH, "123", "campaign", "111");
    expect(snap.status).toBe("ENABLED");
    expect(snap.dailyBudgetMicros).toBe(10_000_000);
    expect(snap.budgetResourceName).toBe("customers/123/campaignBudgets/77");
    expect(snap.conversions30d).toBe(4);
    expect(snap.spend30dMicros).toBe(5_000_000);
    // headers carry developer token + login-customer-id
    const gaqlCall = calls.find(c => c.url.includes("googleAds:search"));
    const h = gaqlCall?.init?.headers as Record<string, string>;
    expect(h["developer-token"]).toBe("devtok");
    expect(h["login-customer-id"]).toBe("9999999999");
  });

  it("validate sends the same mutate body with validateOnly:true", async () => {
    responder = () => ({});
    const res = await googleAdapter.validate!(AUTH, "123",
      { actionType: "budget_update", entityKind: "campaign", entityRef: "111", payload: { newDailyBudgetMicros: 12_000_000 } }, before());
    expect(res.ok).toBe(true);
    const call = calls.find(c => c.url.endsWith("campaignBudgets:mutate"));
    const body = JSON.parse(String(call?.init?.body));
    expect(body.validateOnly).toBe(true);
    expect(body.operations[0].update.amountMicros).toBe("12000000");
    expect(body.operations[0].updateMask).toBe("amount_micros");
  });

  it("execute budget_update mutates without validateOnly and hashes request", async () => {
    responder = () => ({ results: [{ resourceName: "customers/123/campaignBudgets/77" }] });
    const exec = await googleAdapter.execute(AUTH, "123",
      { actionType: "budget_update", entityKind: "campaign", entityRef: "111", payload: { newDailyBudgetMicros: 12_000_000 } }, before());
    expect(exec.operation).toBe("campaignBudgets:mutate");
    const body = JSON.parse(String(calls.find(c => c.url.endsWith("campaignBudgets:mutate"))?.init?.body));
    expect(body.validateOnly).toBeUndefined();
  });

  it("execute pause targets campaigns:mutate with status update", async () => {
    responder = () => ({ results: [{ resourceName: "customers/123/campaigns/111" }] });
    await googleAdapter.execute(AUTH, "123",
      { actionType: "pause", entityKind: "campaign", entityRef: "111", payload: {} }, before());
    const body = JSON.parse(String(calls.find(c => c.url.endsWith("campaigns:mutate"))?.init?.body));
    expect(body.operations[0].update.status).toBe("PAUSED");
    expect(body.operations[0].updateMask).toBe("status");
  });

  it("add_negatives creates negative criteria and captures resourceNames", async () => {
    responder = () => ({ results: [
      { resourceName: "customers/123/campaignCriteria/111~1" },
      { resourceName: "customers/123/campaignCriteria/111~2" },
    ] });
    const exec = await googleAdapter.execute(AUTH, "123",
      { actionType: "add_negatives", entityKind: "campaign", entityRef: "111",
        payload: { negatives: [{ text: "gratis", match: "PHRASE" }, { text: "empleo", match: "BROAD" }] } }, before());
    expect(exec.resourceNames).toHaveLength(2);
    const body = JSON.parse(String(calls.find(c => c.url.endsWith("campaignCriteria:mutate"))?.init?.body));
    expect(body.partialFailure).toBe(true);
    expect(body.operations[0].create.negative).toBe(true);
    expect(body.operations[0].create.keyword).toEqual({ text: "gratis", matchType: "PHRASE" });
  });

  it("buildRollback inverts budget/pause/enable/add_negatives", () => {
    const b = before();
    expect(googleAdapter.buildRollback(
      { actionType: "budget_update", entityKind: "campaign", entityRef: "111", payload: { newDailyBudgetMicros: 12_000_000 } },
      b, { operation: "campaignBudgets:mutate", request: {}, response: {} }
    )?.action.payload).toEqual({ newDailyBudgetMicros: 10_000_000 });
    expect(googleAdapter.buildRollback(
      { actionType: "pause", entityKind: "campaign", entityRef: "111", payload: {} },
      b, { operation: "campaigns:mutate", request: {}, response: {} }
    )?.action.actionType).toBe("enable");
    expect(googleAdapter.buildRollback(
      { actionType: "add_negatives", entityKind: "campaign", entityRef: "111", payload: { negatives: [] } },
      b, { operation: "campaignCriteria:mutate", request: {}, response: {}, resourceNames: ["rn1"] }
    )?.action).toEqual({ actionType: "remove_negatives", entityKind: "campaign", entityRef: "111", payload: { resourceNames: ["rn1"] } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/command`
Expected: FAIL (cannot resolve `../networks/google`).

- [ ] **Step 3: Create `src/lib/command/networks/google.ts`**

```ts
// Centro de Mando — Google Ads adapter. SERVER-ONLY.
// Writes ONLY on connected client accounts via per-connection OAuth tokens
// (AdapterAuth.googleRefreshToken). NEVER reads GOOGLE_ADS_REFRESH_TOKEN.
import { mintAccessToken } from "@/lib/ads-connections";
import type {
  AdapterAuth, AdapterCapabilities, CcActionInput, CcEntityKind,
  EntitySnapshot, ExecuteResult, NetworkAdapter, RollbackRecipe,
} from "../types";

const apiVersion = () => process.env.GOOGLE_ADS_API_VERSION || "v21";
const devToken = () => process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "";
const base = (accountRef: string) =>
  `https://googleads.googleapis.com/${apiVersion()}/customers/${accountRef}`;

async function authHeaders(auth: AdapterAuth): Promise<Record<string, string>> {
  if (!auth.googleRefreshToken) throw new Error("Conexión de Google sin refresh token.");
  const token = await mintAccessToken(auth.googleRefreshToken);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": devToken(),
    "Content-Type": "application/json",
  };
  if (auth.googleLoginCustomerId) headers["login-customer-id"] = auth.googleLoginCustomerId;
  return headers;
}

type GaqlRow = Record<string, Record<string, unknown>>;

async function gaql(auth: AdapterAuth, accountRef: string, query: string): Promise<GaqlRow[]> {
  const res = await fetch(`${base(accountRef)}/googleAds:search`, {
    method: "POST",
    headers: await authHeaders(auth),
    body: JSON.stringify({ query }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Google Ads search ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as { results?: GaqlRow[] };
  return data.results ?? [];
}

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

interface Mutation { endpoint: string; body: Record<string, unknown> }

/** Single source of truth for mutate bodies — used by validate() and execute(). */
function buildMutation(accountRef: string, action: CcActionInput, before: EntitySnapshot): Mutation {
  const campaignRes = `customers/${accountRef}/campaigns/${action.entityRef}`;
  const adGroupRes = `customers/${accountRef}/adGroups/${action.entityRef}`;
  switch (action.actionType) {
    case "budget_update": {
      const payload = action.payload as { newDailyBudgetMicros: number };
      if (!before.budgetResourceName) throw new Error("No se pudo resolver el presupuesto de la campaña.");
      return {
        endpoint: "campaignBudgets:mutate",
        body: {
          operations: [{
            updateMask: "amount_micros",
            update: { resourceName: before.budgetResourceName, amountMicros: String(payload.newDailyBudgetMicros) },
          }],
        },
      };
    }
    case "pause":
    case "enable": {
      const status = action.actionType === "pause" ? "PAUSED" : "ENABLED";
      if (action.entityKind === "ad_group") {
        return { endpoint: "adGroups:mutate", body: { operations: [{ updateMask: "status", update: { resourceName: adGroupRes, status } }] } };
      }
      return { endpoint: "campaigns:mutate", body: { operations: [{ updateMask: "status", update: { resourceName: campaignRes, status } }] } };
    }
    case "add_negatives": {
      const payload = action.payload as { negatives: Array<{ text: string; match: string }> };
      return {
        endpoint: "campaignCriteria:mutate",
        body: {
          partialFailure: true,
          operations: payload.negatives.map((n) => ({
            create: { campaign: campaignRes, negative: true, keyword: { text: n.text, matchType: n.match } },
          })),
        },
      };
    }
    case "remove_negatives": {
      const payload = action.payload as { resourceNames: string[] };
      return { endpoint: "campaignCriteria:mutate", body: { operations: payload.resourceNames.map((rn) => ({ remove: rn })) } };
    }
    default:
      throw new Error(`Acción no soportada en Google: ${action.actionType}`);
  }
}

async function postMutate(auth: AdapterAuth, accountRef: string, mutation: Mutation, extra?: Record<string, unknown>) {
  const res = await fetch(`${base(accountRef)}/${mutation.endpoint}`, {
    method: "POST",
    headers: await authHeaders(auth),
    body: JSON.stringify({ ...mutation.body, ...(extra ?? {}) }),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Ads ${mutation.endpoint} ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

export const googleAdapter: NetworkAdapter = {
  network: "google_ads",

  capabilities(auth: AdapterAuth): AdapterCapabilities {
    if (!auth.googleRefreshToken) {
      return { read: false, write: false, actionTypes: [], reason: "Sin conexión de Google Ads activa (Conexiones)." };
    }
    return { read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives"] };
  },

  async listCampaigns(auth, accountRef) {
    const rows = await gaql(auth, accountRef, `
      SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget,
             campaign_budget.amount_micros, customer.currency_code
      FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`);
    return rows.map((row) => rowToSnapshot("campaign", row));
  },

  async snapshot(auth, accountRef, entityKind, entityRef) {
    if (entityKind === "ad_group") {
      const rows = await gaql(auth, accountRef, `
        SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.id = ${Number(entityRef)}`);
      if (!rows.length) throw new Error(`Grupo de anuncios ${entityRef} no encontrado.`);
      const g = rows[0].adGroup as Record<string, unknown>;
      return { entityKind, entityRef, name: String(g.name ?? ""), status: (g.status as EntitySnapshot["status"]) ?? "UNKNOWN", learningPhase: "UNKNOWN", raw: rows[0] };
    }
    const rows = await gaql(auth, accountRef, `
      SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget,
             campaign_budget.amount_micros, customer.currency_code
      FROM campaign WHERE campaign.id = ${Number(entityRef)}`);
    if (!rows.length) throw new Error(`Campaña ${entityRef} no encontrada.`);
    const snap = rowToSnapshot("campaign", rows[0]);
    const metrics = await gaql(auth, accountRef, `
      SELECT metrics.conversions, metrics.cost_micros
      FROM campaign WHERE campaign.id = ${Number(entityRef)} AND segments.date DURING LAST_30_DAYS`);
    snap.conversions30d = metrics.reduce((acc, r) => acc + num((r.metrics as Record<string, unknown>)?.conversions), 0);
    snap.spend30dMicros = metrics.reduce((acc, r) => acc + num((r.metrics as Record<string, unknown>)?.costMicros), 0);
    return snap;
  },

  async validate(auth, accountRef, action, beforeSnap) {
    try {
      const mutation = buildMutation(accountRef, action, beforeSnap);
      await postMutate(auth, accountRef, { endpoint: mutation.endpoint, body: mutation.body }, { validateOnly: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "error de validación" };
    }
  },

  async execute(auth, accountRef, action, beforeSnap): Promise<ExecuteResult> {
    const mutation = buildMutation(accountRef, action, beforeSnap);
    const response = await postMutate(auth, accountRef, mutation);
    const results = (response.results as Array<{ resourceName?: string }> | undefined) ?? [];
    return {
      operation: mutation.endpoint,
      request: mutation.body,
      response,
      resourceNames: results.map((r) => r.resourceName).filter((r): r is string => Boolean(r)),
    };
  },

  buildRollback(action, beforeSnap, exec): RollbackRecipe | null {
    const common = { entityKind: action.entityKind, entityRef: action.entityRef } as const;
    switch (action.actionType) {
      case "budget_update":
        if (beforeSnap.dailyBudgetMicros == null) return null;
        return { action: { ...common, actionType: "budget_update", payload: { newDailyBudgetMicros: beforeSnap.dailyBudgetMicros } },
                 note: `Restaurar presupuesto a ${beforeSnap.dailyBudgetMicros} micros.` };
      case "pause":
        return { action: { ...common, actionType: "enable", payload: {} }, note: "Reactivar la entidad pausada." };
      case "enable":
        return { action: { ...common, actionType: "pause", payload: {} }, note: "Volver a pausar la entidad." };
      case "add_negatives":
        if (!exec.resourceNames?.length) return null;
        return { action: { ...common, actionType: "remove_negatives", payload: { resourceNames: exec.resourceNames } },
                 note: `Eliminar ${exec.resourceNames.length} negativas creadas.` };
      default:
        return null;
    }
  },
};

function rowToSnapshot(entityKind: CcEntityKind, row: GaqlRow): EntitySnapshot {
  const c = (row.campaign ?? {}) as Record<string, unknown>;
  const b = (row.campaignBudget ?? {}) as Record<string, unknown>;
  const cu = (row.customer ?? {}) as Record<string, unknown>;
  return {
    entityKind,
    entityRef: String(c.id ?? ""),
    name: typeof c.name === "string" ? c.name : null,
    status: (c.status as EntitySnapshot["status"]) ?? "UNKNOWN",
    dailyBudgetMicros: b.amountMicros != null ? num(b.amountMicros) : null,
    budgetResourceName: typeof c.campaignBudget === "string" ? c.campaignBudget : null,
    currency: typeof cu.currencyCode === "string" ? cu.currencyCode : null,
    learningPhase: "UNKNOWN",
    raw: row,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/command`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/command
git commit -m "feat(command): Google Ads adapter — GAQL snapshots, validateOnly rehearsal, mutations, rollback recipes"
```

---

### Task 6: Meta Ads adapter (env system-user token; degrades to read/none without it)

**Files:**
- Create: `src/lib/command/networks/meta.ts`
- Test: `src/lib/command/__tests__/meta-adapter.test.ts`

**IMPORTANT sub-step 0:** the code below pins `v25.0` (validated floor from the mikusnuz/pipeboard reference servers, 2026-07). Verify the current Meta Marketing API version with the context7 MCP (`resolve-library-id` → "Meta Marketing API" → `query-docs` for "current Graph API version") or https://developers.facebook.com/docs/graph-api/changelog — if the docs say newer, bump the single default string and note it in the commit message. Do NOT downgrade below v25.0.

**Meta budget/format facts (baked into the adapter):** budgets go to Meta as **integer minor units (cents) as strings** — `metaMinorUnits` already rounds micros→cents; when serializing, send `String(cents)`. When `META_APP_SECRET` is set, add `appsecret_proof = HMAC-SHA256(app_secret, token)` as a query param on every call (required practice for system-user tokens). These are additive to the code below; if the implementer adds the appsecret_proof helper, cover it with a test.

- [ ] **Step 1: Write the failing test**

`src/lib/command/__tests__/meta-adapter.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { metaAdapter, metaAccountRefs } from "../networks/meta";
import type { EntitySnapshot } from "../types";

let calls: Array<{ url: string; init?: RequestInit }> = [];
let responder: (url: string) => unknown = () => ({});
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  process.env.META_SYSTEM_USER_TOKEN = "meta-token";
  process.env.META_AD_ACCOUNT_IDS = "act_1, act_2";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return new Response(JSON.stringify(responder(url)), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.META_SYSTEM_USER_TOKEN;
  delete process.env.META_AD_ACCOUNT_IDS;
});

function before(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return { entityKind: "adset", entityRef: "555", status: "ENABLED", dailyBudgetMicros: 20_000_000, ...over };
}

describe("metaAdapter", () => {
  it("capabilities off without token, on with token (no negatives)", () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    const off = metaAdapter.capabilities({});
    expect(off.write).toBe(false);
    expect(off.reason).toContain("META_SYSTEM_USER_TOKEN");
    process.env.META_SYSTEM_USER_TOKEN = "meta-token";
    const on = metaAdapter.capabilities({});
    expect(on.write).toBe(true);
    expect(on.actionTypes).not.toContain("add_negatives");
  });

  it("metaAccountRefs parses the allowlist", () => {
    expect(metaAccountRefs()).toEqual(["act_1", "act_2"]);
  });

  it("snapshot converts daily_budget cents → micros and maps learning stage", async () => {
    responder = (url) => {
      if (url.includes("/insights")) return { data: [{ spend: "150.25", actions: [{ action_type: "purchase", value: "3" }, { action_type: "lead", value: "2" }] }] };
      return { id: "555", name: "Adset X", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000", learning_stage_info: { status: "LEARNING" } };
    };
    const snap = await metaAdapter.snapshot({}, "act_1", "adset", "555");
    expect(snap.dailyBudgetMicros).toBe(20_000_000); // 2000 cents
    expect(snap.status).toBe("ENABLED");             // ACTIVE → ENABLED
    expect(snap.learningPhase).toBe("LEARNING");
    expect(snap.conversions30d).toBe(5);
    expect(snap.spend30dMicros).toBe(150_250_000);   // 150.25 → micros
  });

  it("execute budget_update posts daily_budget in minor units", async () => {
    responder = () => ({ success: true });
    await metaAdapter.execute({}, "act_1",
      { actionType: "budget_update", entityKind: "adset", entityRef: "555", payload: { newDailyBudgetMicros: 30_000_000 } }, before());
    const call = calls.find(c => c.url.endsWith("/555"));
    const body = String(call?.init?.body);
    expect(body).toContain("daily_budget=3000");
  });

  it("execute pause posts status=PAUSED; enable posts ACTIVE", async () => {
    responder = () => ({ success: true });
    await metaAdapter.execute({}, "act_1", { actionType: "pause", entityKind: "campaign", entityRef: "777", payload: {} }, before());
    expect(String(calls.at(-1)?.init?.body)).toContain("status=PAUSED");
    await metaAdapter.execute({}, "act_1", { actionType: "enable", entityKind: "campaign", entityRef: "777", payload: {} }, before());
    expect(String(calls.at(-1)?.init?.body)).toContain("status=ACTIVE");
  });

  it("buildRollback inverts pause/enable/budget", () => {
    expect(metaAdapter.buildRollback(
      { actionType: "pause", entityKind: "campaign", entityRef: "777", payload: {} }, before(),
      { operation: "POST /777", request: {}, response: {} }
    )?.action.actionType).toBe("enable");
    expect(metaAdapter.buildRollback(
      { actionType: "budget_update", entityKind: "adset", entityRef: "555", payload: { newDailyBudgetMicros: 30_000_000 } }, before(),
      { operation: "POST /555", request: {}, response: {} }
    )?.action.payload).toEqual({ newDailyBudgetMicros: 20_000_000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/command`
Expected: FAIL (cannot resolve `../networks/meta`).

- [ ] **Step 3: Create `src/lib/command/networks/meta.ts`**

```ts
// Centro de Mando — Meta (Facebook) Marketing API adapter. SERVER-ONLY.
// v1 auth: system-user token via META_SYSTEM_USER_TOKEN env; accounts
// allowlisted via META_AD_ACCOUNT_IDS. Without a token the adapter degrades
// to capabilities {write:false} and the UI shows "pendiente de credenciales".
import type {
  AdapterAuth, AdapterCapabilities, CcActionInput,
  EntitySnapshot, ExecuteResult, NetworkAdapter, RollbackRecipe,
} from "../types";
import { MICROS_PER_MINOR_UNIT, MICROS_PER_UNIT } from "../types";

const apiVersion = () => process.env.META_API_VERSION || "v25.0";
const token = () => (process.env.META_SYSTEM_USER_TOKEN ?? "").trim();
const graph = () => `https://graph.facebook.com/${apiVersion()}`;

export function metaAccountRefs(): string[] {
  return (process.env.META_AD_ACCOUNT_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

async function metaGet(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const search = new URLSearchParams({ ...params, access_token: token() });
  const res = await fetch(`${graph()}${path}?${search}`, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`Meta API GET ${path} ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

async function metaPost(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ...form, access_token: token() });
  const res = await fetch(`${graph()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Meta API POST ${path} ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

function mapStatus(value: unknown): EntitySnapshot["status"] {
  const s = String(value ?? "").toUpperCase();
  if (s === "ACTIVE") return "ENABLED";
  if (s === "PAUSED") return "PAUSED";
  if (s === "ARCHIVED" || s === "DELETED") return "ARCHIVED";
  return "UNKNOWN";
}

function mapLearning(info: unknown): EntitySnapshot["learningPhase"] {
  const s = String((info as Record<string, unknown>)?.status ?? "").toUpperCase();
  if (s === "LEARNING") return "LEARNING";
  if (s === "SUCCESS") return "STABLE";
  if (s === "FAIL") return "LIMITED";
  return "UNKNOWN";
}

const CONVERSION_ACTIONS = new Set(["purchase", "omni_purchase", "lead", "offsite_conversion.fb_pixel_purchase", "offsite_conversion.fb_pixel_lead"]);

function insightsToSignals(data: unknown): { conversions30d: number | null; spend30dMicros: number | null } {
  const rows = (data as { data?: Array<Record<string, unknown>> })?.data ?? [];
  if (!rows.length) return { conversions30d: null, spend30dMicros: null };
  let conversions = 0;
  let spendMicros = 0;
  for (const row of rows) {
    spendMicros += Math.round(Number(row.spend ?? 0) * MICROS_PER_UNIT);
    for (const action of (row.actions as Array<{ action_type?: string; value?: string }> | undefined) ?? []) {
      if (action.action_type && CONVERSION_ACTIONS.has(action.action_type)) conversions += Number(action.value ?? 0);
    }
  }
  return { conversions30d: conversions, spend30dMicros: spendMicros };
}

export const metaAdapter: NetworkAdapter = {
  network: "meta_ads",

  capabilities(_auth: AdapterAuth): AdapterCapabilities {
    if (!token()) {
      return { read: false, write: false, actionTypes: [], reason: "META_SYSTEM_USER_TOKEN no configurado (pendiente de credenciales)." };
    }
    return { read: true, write: true, actionTypes: ["budget_update", "pause", "enable"] };
  },

  async listCampaigns(_auth, accountRef) {
    const data = await metaGet(`/${accountRef}/campaigns`, {
      fields: "id,name,status,effective_status,daily_budget", limit: "100",
    });
    const rows = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
    return rows.map((c) => ({
      entityKind: "campaign" as const,
      entityRef: String(c.id ?? ""),
      name: typeof c.name === "string" ? c.name : null,
      status: mapStatus(c.status),
      dailyBudgetMicros: c.daily_budget != null ? Number(c.daily_budget) * MICROS_PER_MINOR_UNIT : null,
      learningPhase: "UNKNOWN" as const,
      raw: c,
    }));
  },

  async snapshot(_auth, _accountRef, entityKind, entityRef) {
    const fields = entityKind === "adset"
      ? "id,name,status,effective_status,daily_budget,learning_stage_info"
      : "id,name,status,effective_status,daily_budget";
    const entity = await metaGet(`/${entityRef}`, { fields });
    let signals: { conversions30d: number | null; spend30dMicros: number | null } = { conversions30d: null, spend30dMicros: null };
    try {
      const insights = await metaGet(`/${entityRef}/insights`, { date_preset: "last_30d", fields: "spend,actions" });
      signals = insightsToSignals(insights);
    } catch { /* insights opcionales: sin permiso o sin datos */ }
    return {
      entityKind,
      entityRef,
      name: typeof entity.name === "string" ? entity.name : null,
      status: mapStatus(entity.status),
      dailyBudgetMicros: entity.daily_budget != null ? Number(entity.daily_budget) * MICROS_PER_MINOR_UNIT : null,
      learningPhase: entityKind === "adset" ? mapLearning(entity.learning_stage_info) : "UNKNOWN",
      conversions30d: signals.conversions30d,
      spend30dMicros: signals.spend30dMicros,
      raw: entity,
    };
  },

  async execute(_auth, _accountRef, action, _before): Promise<ExecuteResult> {
    switch (action.actionType) {
      case "budget_update": {
        const payload = action.payload as { newDailyBudgetMicros: number };
        const minorUnits = Math.round(payload.newDailyBudgetMicros / MICROS_PER_MINOR_UNIT);
        const form = { daily_budget: String(minorUnits) };
        const response = await metaPost(`/${action.entityRef}`, form);
        return { operation: `POST /${action.entityRef}`, request: form, response };
      }
      case "pause":
      case "enable": {
        const form = { status: action.actionType === "pause" ? "PAUSED" : "ACTIVE" };
        const response = await metaPost(`/${action.entityRef}`, form);
        return { operation: `POST /${action.entityRef}`, request: form, response };
      }
      default:
        throw new Error(`Acción no soportada en Meta: ${action.actionType}`);
    }
  },

  buildRollback(action, beforeSnap, _exec): RollbackRecipe | null {
    const common = { entityKind: action.entityKind, entityRef: action.entityRef } as const;
    switch (action.actionType) {
      case "budget_update":
        if (beforeSnap.dailyBudgetMicros == null) return null;
        return { action: { ...common, actionType: "budget_update", payload: { newDailyBudgetMicros: beforeSnap.dailyBudgetMicros } },
                 note: `Restaurar presupuesto a ${beforeSnap.dailyBudgetMicros} micros.` };
      case "pause":
        return { action: { ...common, actionType: "enable", payload: {} }, note: "Reactivar la entidad pausada." };
      case "enable":
        return { action: { ...common, actionType: "pause", payload: {} }, note: "Volver a pausar la entidad." };
      default:
        return null;
    }
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/command`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/command
git commit -m "feat(command): Meta Marketing API adapter — env token auth, unit normalization, learning-stage mapping"
```

---

### Task 7: Adapter registry, actions repo, settings loader

**Files:**
- Create: `src/lib/command/networks/index.ts`
- Create: `src/lib/command/actions-repo.ts`
- Create: `src/lib/command/settings.ts`
- Test: `src/lib/command/__tests__/settings.test.ts`

- [ ] **Step 1: Create `src/lib/command/networks/index.ts`**

```ts
import type { CcNetwork, NetworkAdapter } from "../types";
import { googleAdapter } from "./google";
import { metaAdapter } from "./meta";

const ADAPTERS: Record<CcNetwork, NetworkAdapter> = {
  google_ads: googleAdapter,
  meta_ads: metaAdapter,
};

export function adapterFor(network: CcNetwork): NetworkAdapter {
  const adapter = ADAPTERS[network];
  if (!adapter) throw new Error(`Red no soportada: ${network}`);
  return adapter;
}
```

- [ ] **Step 2: Write the failing settings test**

`src/lib/command/__tests__/settings.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { rowToSettings } from "../settings";
import { CC_SETTINGS_DEFAULTS } from "../types";

describe("rowToSettings", () => {
  it("returns defaults for null row", () => {
    expect(rowToSettings(null)).toEqual(CC_SETTINGS_DEFAULTS);
  });
  it("maps a row and sanitizes allowed types", () => {
    const v = rowToSettings({
      executionsPaused: true, maxBudgetDeltaPct: 15, maxActionsPerAccountDay: 5,
      requireTwoStep: false, allowedActionTypes: ["pause", "nope"], watchHours: 24,
    });
    expect(v.executionsPaused).toBe(true);
    expect(v.maxBudgetDeltaPct).toBe(15);
    expect(v.allowedActionTypes).toEqual(["pause"]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test src/lib/command`
Expected: FAIL (cannot resolve `../settings`).

- [ ] **Step 4: Create `src/lib/command/settings.ts`**

```ts
import { eq } from "drizzle-orm";
import { adsDb } from "@/lib/ads-db";
import { ccSettings } from "@/lib/schema";
import { CC_ACTION_TYPES, CC_SETTINGS_DEFAULTS, type CcActionType, type CcSettingsValues } from "./types";

interface SettingsRowShape {
  executionsPaused?: unknown; maxBudgetDeltaPct?: unknown; maxActionsPerAccountDay?: unknown;
  requireTwoStep?: unknown; allowedActionTypes?: unknown; watchHours?: unknown;
}

export function rowToSettings(row: SettingsRowShape | null | undefined): CcSettingsValues {
  if (!row) return { ...CC_SETTINGS_DEFAULTS, allowedActionTypes: [...CC_SETTINGS_DEFAULTS.allowedActionTypes] };
  const allowed = Array.isArray(row.allowedActionTypes)
    ? (row.allowedActionTypes as unknown[]).filter((t): t is CcActionType => CC_ACTION_TYPES.includes(t as CcActionType))
    : [...CC_SETTINGS_DEFAULTS.allowedActionTypes];
  return {
    executionsPaused: Boolean(row.executionsPaused),
    maxBudgetDeltaPct: Number(row.maxBudgetDeltaPct ?? CC_SETTINGS_DEFAULTS.maxBudgetDeltaPct),
    maxActionsPerAccountDay: Number(row.maxActionsPerAccountDay ?? CC_SETTINGS_DEFAULTS.maxActionsPerAccountDay),
    requireTwoStep: row.requireTwoStep === undefined ? true : Boolean(row.requireTwoStep),
    allowedActionTypes: allowed,
    watchHours: Number(row.watchHours ?? CC_SETTINGS_DEFAULTS.watchHours),
  };
}

export async function getCcSettings(workspaceId: string): Promise<CcSettingsValues> {
  const rows = await adsDb.select().from(ccSettings).where(eq(ccSettings.workspaceId, workspaceId)).limit(1);
  return rowToSettings(rows[0] ?? null);
}

export async function saveCcSettings(workspaceId: string, values: Partial<CcSettingsValues>, updatedBy: string): Promise<CcSettingsValues> {
  const current = await getCcSettings(workspaceId);
  const next: CcSettingsValues = { ...current, ...values };
  await adsDb
    .insert(ccSettings)
    .values({
      workspaceId,
      executionsPaused: next.executionsPaused,
      maxBudgetDeltaPct: next.maxBudgetDeltaPct,
      maxActionsPerAccountDay: next.maxActionsPerAccountDay,
      requireTwoStep: next.requireTwoStep,
      allowedActionTypes: next.allowedActionTypes,
      watchHours: next.watchHours,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: ccSettings.workspaceId,
      set: {
        executionsPaused: next.executionsPaused,
        maxBudgetDeltaPct: next.maxBudgetDeltaPct,
        maxActionsPerAccountDay: next.maxActionsPerAccountDay,
        requireTwoStep: next.requireTwoStep,
        allowedActionTypes: next.allowedActionTypes,
        watchHours: next.watchHours,
        updatedBy,
        updatedAt: new Date(),
      },
    });
  return next;
}
```

- [ ] **Step 5: Create `src/lib/command/actions-repo.ts`** (thin Drizzle CRUD; no unit tests — exercised via manual smoke + executor tests use fakes)

```ts
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { adsDb } from "@/lib/ads-db";
import { ccActions, ccExecutions } from "@/lib/schema";
import { assertTransition } from "./state";
import type { CcActionStatus, CcNetwork } from "./types";

export type CcActionRow = typeof ccActions.$inferSelect;
export type CcExecutionRow = typeof ccExecutions.$inferSelect;

export async function createAction(values: typeof ccActions.$inferInsert): Promise<CcActionRow> {
  const rows = await adsDb.insert(ccActions).values(values).returning();
  return rows[0];
}

/** Insert skipping duplicates on (workspace, network, rec_key). Returns row or null if duped. */
export async function createActionDeduped(values: typeof ccActions.$inferInsert): Promise<CcActionRow | null> {
  const rows = await adsDb.insert(ccActions).values(values)
    .onConflictDoNothing({ target: [ccActions.workspaceId, ccActions.network, ccActions.recKey] })
    .returning();
  return rows[0] ?? null;
}

export async function getAction(id: string, workspaceIds: string[]): Promise<CcActionRow | null> {
  const rows = await adsDb.select().from(ccActions)
    .where(and(eq(ccActions.id, id), inArray(ccActions.workspaceId, workspaceIds))).limit(1);
  return rows[0] ?? null;
}

export async function listActions(workspaceIds: string[], opts: { status?: CcActionStatus; network?: CcNetwork; limit?: number } = {}): Promise<CcActionRow[]> {
  const conditions = [inArray(ccActions.workspaceId, workspaceIds)];
  if (opts.status) conditions.push(eq(ccActions.status, opts.status));
  if (opts.network) conditions.push(eq(ccActions.network, opts.network));
  return adsDb.select().from(ccActions).where(and(...conditions))
    .orderBy(desc(ccActions.createdAt)).limit(opts.limit ?? 100);
}

export async function transitionAction(
  row: CcActionRow, to: CcActionStatus,
  patch: Partial<typeof ccActions.$inferInsert> = {}
): Promise<void> {
  assertTransition(row.status as CcActionStatus, to);
  await adsDb.update(ccActions)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(ccActions.id, row.id), eq(ccActions.status, row.status))); // optimistic guard
}

export async function countExecutedToday(accountRef: string): Promise<number> {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const rows = await adsDb.select({ n: sql<number>`count(*)::int` }).from(ccExecutions)
    .where(and(
      eq(ccExecutions.accountRef, accountRef),
      eq(ccExecutions.status, "done"),
      eq(ccExecutions.validateOnly, false),
      gte(ccExecutions.createdAt, start),
    ));
  return rows[0]?.n ?? 0;
}

export async function insertExecution(values: typeof ccExecutions.$inferInsert): Promise<CcExecutionRow> {
  const rows = await adsDb.insert(ccExecutions).values(values).returning();
  return rows[0];
}

export async function updateExecution(id: string, patch: Partial<typeof ccExecutions.$inferInsert>): Promise<void> {
  await adsDb.update(ccExecutions).set({ ...patch, updatedAt: new Date() }).where(eq(ccExecutions.id, id));
}

export async function latestDoneExecution(actionId: string): Promise<CcExecutionRow | null> {
  const rows = await adsDb.select().from(ccExecutions)
    .where(and(eq(ccExecutions.actionId, actionId), eq(ccExecutions.status, "done"), eq(ccExecutions.validateOnly, false)))
    .orderBy(desc(ccExecutions.createdAt)).limit(1);
  return rows[0] ?? null;
}

export async function listExecutions(workspaceIds: string[], limit = 100): Promise<Array<{ execution: CcExecutionRow; action: CcActionRow }>> {
  const rows = await adsDb.select({ execution: ccExecutions, action: ccActions })
    .from(ccExecutions)
    .innerJoin(ccActions, eq(ccExecutions.actionId, ccActions.id))
    .where(inArray(ccActions.workspaceId, workspaceIds))
    .orderBy(desc(ccExecutions.createdAt)).limit(limit);
  return rows;
}

export async function countByStatus(workspaceIds: string[]): Promise<Record<string, number>> {
  const rows = await adsDb.select({ status: ccActions.status, n: sql<number>`count(*)::int` })
    .from(ccActions).where(inArray(ccActions.workspaceId, workspaceIds)).groupBy(ccActions.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test src/lib/command && bunx tsc --noEmit`
Expected: tests PASS; no new type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/command
git commit -m "feat(command): adapter registry, actions/executions repo, workspace settings"
```

---

### Task 8: Executor (chokepoint orchestration) with injectable deps

**Files:**
- Create: `src/lib/command/executor.ts`
- Test: `src/lib/command/__tests__/executor.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/command/__tests__/executor.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { executeAction, rollbackAction, type ExecutorDeps } from "../executor";
import { CC_SETTINGS_DEFAULTS, type EntitySnapshot, type NetworkAdapter } from "../types";

function snapshot(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return { entityKind: "campaign", entityRef: "111", status: "ENABLED",
    dailyBudgetMicros: 10_000_000, budgetResourceName: "customers/1/campaignBudgets/7",
    learningPhase: "STABLE", conversions30d: 5, spend30dMicros: 1_000_000, ...over };
}

function fakeAdapter(over: Partial<NetworkAdapter> = {}): NetworkAdapter {
  return {
    network: "google_ads",
    capabilities: () => ({ read: true, write: true, actionTypes: ["budget_update", "pause", "enable", "add_negatives", "remove_negatives"] }),
    listCampaigns: async () => [],
    snapshot: async () => snapshot(),
    validate: async () => ({ ok: true }),
    execute: async () => ({ operation: "campaigns:mutate", request: { a: 1 }, response: { ok: true }, resourceNames: [] }),
    buildRollback: () => ({ action: { actionType: "enable", entityKind: "campaign", entityRef: "111", payload: {} }, note: "reactivar" }),
    ...over,
  };
}

function baseAction(over: Record<string, unknown> = {}) {
  return {
    id: "a1", workspaceId: "w1", createdBy: "op@x.com", network: "google_ads",
    connectionId: "c1", accountRef: "123", entityKind: "campaign", entityRef: "111",
    entityName: "Marca", actionType: "pause", payload: {}, expected: null,
    source: "manual", recKey: null, rationale: null, evidence: null,
    status: "approved", approvedBy: "op@x.com", approvedAt: new Date(), executedAt: null,
    gateResults: null, error: null, createdAt: new Date(), updatedAt: new Date(), ...over,
  };
}

function fakeDeps(over: Partial<ExecutorDeps> = {}): ExecutorDeps & { log: string[]; transitions: Array<[string, unknown]> } {
  const log: string[] = [];
  const transitions: Array<[string, unknown]> = [];
  const action = baseAction();
  const deps: ExecutorDeps & { log: string[]; transitions: Array<[string, unknown]> } = {
    log, transitions,
    repo: {
      getAction: async () => action as never,
      transitionAction: async (_row, to, patch) => { log.push(`transition:${to}`); transitions.push([to, patch]); },
      insertExecution: async (v) => { log.push(`insertExec:${v.status}:${v.validateOnly ? "dry" : "real"}`); return { id: "e1", ...v } as never; },
      updateExecution: async (_id, patch) => { log.push(`updateExec:${patch.status}`); },
      countExecutedToday: async () => 0,
      latestDoneExecution: async () => ({
        id: "e1", actionId: "a1", attempt: 1, network: "google_ads", accountRef: "123",
        operation: "campaigns:mutate", requestHash: "h", validateOnly: false,
        before: snapshot(), request: {}, response: {}, after: null,
        rollbackRecipe: { action: { actionType: "enable", entityKind: "campaign", entityRef: "111", payload: {} }, note: "reactivar" },
        status: "done", actor: "op@x.com", createdAt: new Date(), updatedAt: new Date(),
      }) as never,
      createAction: async (v) => ({ ...baseAction(), ...v, id: "a2" }) as never,
    },
    adapters: { for: () => fakeAdapter() },
    settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS }) },
    auth: { resolve: async () => ({ googleRefreshToken: "rt" }) },
    dryRun: false,
    now: () => new Date("2026-07-07T12:00:00Z"),
    ...over,
  };
  return deps;
}

describe("executeAction", () => {
  it("happy path: gates pass → executing → ledger pending → done → executed", async () => {
    const deps = fakeDeps();
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(true);
    expect(deps.log).toEqual([
      "transition:executing",
      "insertExec:pending:real",
      "updateExec:done",
      "transition:executed",
    ]);
  });

  it("blocked by gate: keeps approved, persists gate results, no ledger write", async () => {
    const deps = fakeDeps({ settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS, executionsPaused: true }) } });
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(false);
    expect(out.blocked?.some(g => g.id === "KILL_SWITCH")).toBe(true);
    expect(deps.log.some(l => l.startsWith("insertExec"))).toBe(false);
    expect(deps.log).not.toContain("transition:executing");
  });

  it("CC_DRY_RUN: records validate-only ledger row, action stays approved", async () => {
    const deps = fakeDeps({ dryRun: true });
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(deps.log).toEqual(["insertExec:done:dry"]);
  });

  it("network failure → ledger failed + action failed with error", async () => {
    const deps = fakeDeps({
      adapters: { for: () => fakeAdapter({ execute: async () => { throw new Error("boom 500"); } }) },
    });
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(false);
    expect(deps.log).toEqual([
      "transition:executing",
      "insertExec:pending:real",
      "updateExec:failed",
      "transition:failed",
    ]);
  });

  it("refuses non-approved status", async () => {
    const deps = fakeDeps();
    deps.repo.getAction = async () => baseAction({ status: "proposed" }) as never;
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("aprobada");
  });
});

describe("rollbackAction", () => {
  it("executes inverse recipe and marks rolled_back", async () => {
    const deps = fakeDeps();
    deps.repo.getAction = async () => baseAction({ status: "executed" }) as never;
    const out = await rollbackAction("a1", "op@x.com", ["w1"], deps);
    expect(out.ok).toBe(true);
    expect(deps.log).toContain("transition:rolled_back");
    expect(deps.log.filter(l => l.startsWith("insertExec"))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/lib/command`
Expected: FAIL (cannot resolve `../executor`).

- [ ] **Step 3: Create `src/lib/command/executor.ts`**

```ts
// Centro de Mando — THE SINGLE EXECUTION CHOKEPOINT.
// No other module may call adapter.execute(). All writes flow through
// executeAction/rollbackAction: gates → ledger(pending) → network call →
// ledger(done|failed) → action status. Deps are injectable for tests.
import { blockingFailures, runGates } from "./gates";
import { requestHash } from "./request-hash";
import type {
  AdapterAuth, CcActionInput, CcEntityKind, CcInternalActionType, CcNetwork,
  CcPayload, CcSettingsValues, EntitySnapshot, GateResult, NetworkAdapter, RollbackRecipe,
} from "./types";
import type { CcActionRow, CcExecutionRow } from "./actions-repo";

export interface ExecutorRepo {
  getAction(id: string, workspaceIds: string[]): Promise<CcActionRow | null>;
  transitionAction(row: CcActionRow, to: string, patch?: Record<string, unknown>): Promise<void>;
  insertExecution(values: Record<string, unknown>): Promise<CcExecutionRow>;
  updateExecution(id: string, patch: Record<string, unknown>): Promise<void>;
  countExecutedToday(accountRef: string): Promise<number>;
  latestDoneExecution(actionId: string): Promise<CcExecutionRow | null>;
  createAction(values: Record<string, unknown>): Promise<CcActionRow>;
}

export interface ExecutorDeps {
  repo: ExecutorRepo;
  adapters: { for(network: CcNetwork): NetworkAdapter };
  settings: { get(workspaceId: string): Promise<CcSettingsValues> };
  auth: { resolve(action: CcActionRow): Promise<AdapterAuth> };
  dryRun: boolean;
  now(): Date;
}

export interface ExecOutcome {
  ok: boolean;
  blocked?: GateResult[];
  dryRun?: boolean;
  error?: string;
  executionId?: string;
}

function toInput(row: CcActionRow, override?: CcActionInput): CcActionInput {
  if (override) return override;
  return {
    actionType: row.actionType as CcInternalActionType,
    entityKind: row.entityKind as CcEntityKind,
    entityRef: row.entityRef,
    payload: (row.payload ?? {}) as CcPayload,
  };
}

async function prepare(row: CcActionRow, input: CcActionInput, deps: ExecutorDeps) {
  const adapter = deps.adapters.for(row.network as CcNetwork);
  const auth = await deps.auth.resolve(row);
  const capabilities = adapter.capabilities(auth);
  const before = capabilities.read
    ? await adapter.snapshot(auth, row.accountRef, input.entityKind, input.entityRef)
    : ({ entityKind: input.entityKind, entityRef: input.entityRef, status: "UNKNOWN" } as EntitySnapshot);
  const settings = await deps.settings.get(row.workspaceId);
  const executedTodayForAccount = await deps.repo.countExecutedToday(row.accountRef);
  const validateResult =
    row.network === "google_ads" && adapter.validate && capabilities.write
      ? await adapter.validate(auth, row.accountRef, input, before)
      : null;
  const gates = runGates({
    settings,
    network: row.network as CcNetwork,
    action: input,
    capabilities,
    before,
    expected: (row.expected ?? null) as Partial<EntitySnapshot> | null,
    executedTodayForAccount,
    validateResult,
  });
  return { adapter, auth, before, gates, validateResult };
}

async function performWrite(opts: {
  row: CcActionRow; input: CcActionInput; adapter: NetworkAdapter; auth: AdapterAuth;
  before: EntitySnapshot; gates: GateResult[]; actor: string; deps: ExecutorDeps;
  recipe: RollbackRecipe | null;
}): Promise<{ ok: boolean; executionId?: string; error?: string }> {
  const { row, input, adapter, auth, before, gates, actor, deps, recipe } = opts;
  const hash = requestHash({ network: row.network, accountRef: row.accountRef, input });
  const ledger = await deps.repo.insertExecution({
    actionId: row.id, network: row.network, accountRef: row.accountRef,
    operation: `${input.actionType}:${input.entityKind}:${input.entityRef}`,
    requestHash: hash, validateOnly: false, before,
    rollbackRecipe: recipe, status: "pending", actor,
  });
  try {
    const exec = await adapter.execute(auth, row.accountRef, input, before);
    let after: EntitySnapshot | null = null;
    try { after = await adapter.snapshot(auth, row.accountRef, input.entityKind, input.entityRef); } catch { /* verificación opcional */ }
    const finalRecipe = adapter.buildRollback(input, before, exec) ?? recipe;
    await deps.repo.updateExecution(ledger.id, {
      operation: exec.operation, request: exec.request, response: exec.response,
      after, rollbackRecipe: finalRecipe, status: "done",
    });
    return { ok: true, executionId: ledger.id };
  } catch (e) {
    const message = e instanceof Error ? e.message : "error de red desconocido";
    await deps.repo.updateExecution(ledger.id, { status: "failed", response: { error: message } });
    void gates;
    return { ok: false, executionId: ledger.id, error: message };
  }
}

export async function executeAction(
  actionId: string, actor: string, workspaceIds: string[], deps: ExecutorDeps
): Promise<ExecOutcome> {
  const row = await deps.repo.getAction(actionId, workspaceIds);
  if (!row) return { ok: false, error: "Acción no encontrada." };
  if (row.status !== "approved") return { ok: false, error: "La acción debe estar aprobada antes de ejecutarse." };
  if (!row.approvedBy) return { ok: false, error: "Falta aprobación registrada (dos pasos requeridos)." };

  const input = toInput(row);
  const { adapter, auth, before, gates } = await prepare(row, input, deps);
  const blocking = blockingFailures(gates);
  if (blocking.length > 0) {
    await deps.repo.transitionAction(row, "approved", { gateResults: gates }).catch(() => undefined);
    return { ok: false, blocked: gates };
  }

  if (deps.dryRun) {
    const hash = requestHash({ network: row.network, accountRef: row.accountRef, input, dryRun: true });
    await deps.repo.insertExecution({
      actionId: row.id, network: row.network, accountRef: row.accountRef,
      operation: `dry-run:${input.actionType}:${input.entityRef}`,
      requestHash: hash, validateOnly: true, before,
      rollbackRecipe: null, status: "done", actor,
    });
    return { ok: true, dryRun: true };
  }

  await deps.repo.transitionAction(row, "executing", { gateResults: gates });
  const recipe = adapter.buildRollback(input, before, { operation: "", request: null, response: null }) ?? null;
  const result = await performWrite({ row, input, adapter, auth, before, gates, actor, deps, recipe });
  if (result.ok) {
    await deps.repo.transitionAction({ ...row, status: "executing" } as CcActionRow, "executed", {
      executedAt: deps.now(), error: null,
    });
    return { ok: true, executionId: result.executionId };
  }
  await deps.repo.transitionAction({ ...row, status: "executing" } as CcActionRow, "failed", { error: result.error });
  return { ok: false, error: result.error, executionId: result.executionId };
}

export async function rollbackAction(
  actionId: string, actor: string, workspaceIds: string[], deps: ExecutorDeps
): Promise<ExecOutcome> {
  const row = await deps.repo.getAction(actionId, workspaceIds);
  if (!row) return { ok: false, error: "Acción no encontrada." };
  if (row.status !== "executed" && row.status !== "verified") {
    return { ok: false, error: "Solo se puede revertir una acción ejecutada." };
  }
  const lastExec = await deps.repo.latestDoneExecution(row.id);
  const recipe = (lastExec?.rollbackRecipe ?? null) as RollbackRecipe | null;
  if (!recipe) return { ok: false, error: "Esta acción no tiene receta de rollback registrada." };

  const input = recipe.action;
  const { adapter, auth, before, gates } = await prepare(row, input, deps);
  // Rollback bypasses BUDGET_DELTA/BLAST_RADIUS/DRIFT by design: restoring a
  // prior state must always be possible. Only hard operational gates apply.
  const hardBlockers = blockingFailures(gates).filter((g) =>
    ["KILL_SWITCH", "CAPABILITY", "CURRENCY_SANITY", "VALIDATE_ONLY"].includes(g.id)
  );
  if (hardBlockers.length > 0) return { ok: false, blocked: gates };

  const result = await performWrite({ row, input, adapter, auth, before, gates, actor, deps, recipe: null });
  if (!result.ok) return { ok: false, error: result.error, executionId: result.executionId };
  await deps.repo.transitionAction(row, "rolled_back", { error: null });
  return { ok: true, executionId: result.executionId };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/command`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/lib/command
git commit -m "feat(command): execution chokepoint — gates, crash-safe ledger, dry-run, rollback"
```

---

### Task 9: Access helper, real deps wiring, engine import, ALL /api/command routes

**Files:**
- Create: `src/lib/command/access.ts`
- Create: `src/lib/command/executor-deps.ts`
- Create: `src/lib/command/engine-import.ts`
- Create: `src/app/api/command/actions/route.ts`
- Create: `src/app/api/command/actions/[id]/route.ts`
- Create: `src/app/api/command/actions/[id]/approve/route.ts`
- Create: `src/app/api/command/actions/[id]/reject/route.ts`
- Create: `src/app/api/command/actions/[id]/execute/route.ts`
- Create: `src/app/api/command/actions/[id]/rollback/route.ts`
- Create: `src/app/api/command/import-engine/route.ts`
- Create: `src/app/api/command/accounts/route.ts`
- Create: `src/app/api/command/settings/route.ts`
- Test: `src/lib/command/__tests__/engine-import.test.ts`

- [ ] **Step 1: Create `src/lib/command/access.ts`**

```ts
// Access gate for every /api/command/* route and /command page:
// session → COMMAND_CENTER_BETA flag → admin allowlist → workspace ids (RLS).
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { isAdminEmail } from "@/lib/admin";

export interface CommandAccess {
  email: string;
  userId: string;
  accessToken: string | undefined;
  workspaceIds: string[];
}

export function betaEnabled(): boolean {
  return process.env.COMMAND_CENTER_BETA === "true";
}

export async function getCommandAccess(): Promise<CommandAccess | null> {
  if (!betaEnabled()) return null;
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user?.email || !isAdminEmail(user.email)) return null;
  const { data: { session } } = await authClient.auth.getSession();
  const db = createSupabaseReadClient(session?.access_token);
  const { data: memberships } = await db.from("workspace_members").select("workspace_id").eq("user_id", user.id);
  const workspaceIds = (memberships ?? []).map((m) => String(m.workspace_id)).filter(Boolean);
  return { email: user.email, userId: user.id, accessToken: session?.access_token, workspaceIds };
}

export function commandDenied(): NextResponse {
  return NextResponse.json(
    { error: betaEnabled() ? "no autorizado para el Centro de Mando" : "not found" },
    { status: betaEnabled() ? 403 : 404 }
  );
}
```

- [ ] **Step 2: Create `src/lib/command/executor-deps.ts`** (real wiring; per-request because Google auth needs the caller's Supabase token for RLS)

```ts
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { decryptSecret } from "@/lib/ads-connections";
import * as repo from "./actions-repo";
import { adapterFor } from "./networks";
import { getCcSettings } from "./settings";
import type { CcActionRow } from "./actions-repo";
import type { AdapterAuth } from "./types";
import type { ExecutorDeps } from "./executor";

export function buildExecutorDeps(supabaseAccessToken: string | undefined): ExecutorDeps {
  return {
    repo: {
      getAction: repo.getAction,
      transitionAction: (row, to, patch) => repo.transitionAction(row as CcActionRow, to as never, patch as never),
      insertExecution: (v) => repo.insertExecution(v as never),
      updateExecution: (id, patch) => repo.updateExecution(id, patch as never),
      countExecutedToday: repo.countExecutedToday,
      latestDoneExecution: repo.latestDoneExecution,
      createAction: (v) => repo.createAction(v as never),
    },
    adapters: { for: adapterFor },
    settings: { get: getCcSettings },
    auth: {
      async resolve(action: CcActionRow): Promise<AdapterAuth> {
        if (action.network !== "google_ads") return {};
        if (!action.connectionId) throw new Error("La acción de Google no tiene conexión asociada.");
        const db = createSupabaseReadClient(supabaseAccessToken);
        const { data, error } = await db
          .from("ads_google_connections")
          .select("id, refresh_token_enc")
          .eq("id", action.connectionId)
          .maybeSingle();
        if (error || !data?.refresh_token_enc) throw new Error("Conexión de Google no accesible para este usuario.");
        return { googleRefreshToken: decryptSecret(String(data.refresh_token_enc)) };
      },
    },
    dryRun: process.env.CC_DRY_RUN === "true",
    now: () => new Date(),
  };
}
```

- [ ] **Step 3: Write the failing engine-import test**

`src/lib/command/__tests__/engine-import.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { mapEngineOptimizations } from "../engine-import";

const OPTS = [
  { tipo: "negativas", campaign_id: "111", campaign: "Brand", terminos: ["gratis", "empleo"], texto: "Bloquear términos", confianza: "alta" },
  { tipo: "pausar", campaign_id: "222", campaign: "Prospecting", texto: "Pausar campaña sin conversiones" },
  { tipo: "presupuesto", campaign_id: "333", campaign: "PMax", nuevo_presupuesto_micros: 15000000, texto: "Subir presupuesto" },
  { tipo: "presupuesto", campaign_id: "444", texto: "Ajustar presupuesto (sin monto)" },
  { tipo: "otra_cosa", texto: "No mapeable" },
];

describe("mapEngineOptimizations", () => {
  it("maps negativas/pausar/presupuesto-with-amount; skips the rest", () => {
    const { actions, skipped } = mapEngineOptimizations(OPTS as never, {
      workspaceId: "w1", connectionId: "c1", accountRef: "123", createdBy: "op@x.com",
    });
    expect(actions).toHaveLength(3);
    expect(skipped).toBe(2);
    const [neg, pause, budget] = actions;
    expect(neg.actionType).toBe("add_negatives");
    expect(neg.payload).toEqual({ negatives: [{ text: "gratis", match: "PHRASE" }, { text: "empleo", match: "PHRASE" }] });
    expect(neg.recKey).toMatch(/^eng-/);
    expect(pause.actionType).toBe("pause");
    expect(pause.entityRef).toBe("222");
    expect(budget.actionType).toBe("budget_update");
    expect(budget.payload).toEqual({ newDailyBudgetMicros: 15000000 });
    expect(budget.source).toBe("engine");
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `bun test src/lib/command`
Expected: FAIL (cannot resolve `../engine-import`).

- [ ] **Step 5: Create `src/lib/command/engine-import.ts`**

```ts
// Maps gads-sentinel ai_plan.optimizations into cc_actions drafts.
// Only unambiguous, low-blast-radius shapes are imported; the rest are counted
// as skipped so the UI can say "N no importables".
import { createHash } from "crypto";
import type { CcActionType, CcPayload } from "./types";

interface EngineOpt {
  tipo?: string; campaign_id?: string | number; campaign?: string;
  terminos?: unknown; texto?: string; confianza?: string;
  nuevo_presupuesto_micros?: unknown; budget_id?: string | number;
}

export interface ImportTarget {
  workspaceId: string; connectionId: string; accountRef: string; createdBy: string;
}

export interface ImportedAction {
  workspaceId: string; createdBy: string; network: "google_ads"; connectionId: string;
  accountRef: string; entityKind: "campaign"; entityRef: string; entityName: string | null;
  actionType: CcActionType; payload: CcPayload; source: "engine"; recKey: string;
  rationale: string | null; evidence: Record<string, unknown>;
}

function recKeyFor(accountRef: string, tipo: string, entityRef: string, extra: string): string {
  const h = createHash("sha256").update(`${accountRef}|${tipo}|${entityRef}|${extra}`).digest("hex").slice(0, 14);
  return `eng-${h}`;
}

export function mapEngineOptimizations(
  opts: EngineOpt[], target: ImportTarget
): { actions: ImportedAction[]; skipped: number } {
  const actions: ImportedAction[] = [];
  let skipped = 0;
  for (const opt of opts ?? []) {
    const tipo = String(opt.tipo ?? "").toLowerCase();
    const campaignId = opt.campaign_id != null ? String(opt.campaign_id) : "";
    const common = {
      workspaceId: target.workspaceId, createdBy: target.createdBy,
      network: "google_ads" as const, connectionId: target.connectionId,
      accountRef: target.accountRef, entityKind: "campaign" as const,
      entityRef: campaignId, entityName: opt.campaign ?? null,
      source: "engine" as const, rationale: opt.texto ?? null,
      evidence: { engine: true, tipo, confianza: opt.confianza ?? null },
    };
    if (tipo === "negativas" && campaignId && Array.isArray(opt.terminos) && opt.terminos.length) {
      const negatives = (opt.terminos as unknown[])
        .map((t) => String(t ?? "").trim()).filter(Boolean)
        .map((text) => ({ text, match: "PHRASE" as const }));
      actions.push({ ...common, actionType: "add_negatives", payload: { negatives },
        recKey: recKeyFor(target.accountRef, tipo, campaignId, negatives.map((n) => n.text).join(",")) });
    } else if (tipo === "pausar" && campaignId) {
      actions.push({ ...common, actionType: "pause", payload: {},
        recKey: recKeyFor(target.accountRef, tipo, campaignId, "") });
    } else if (tipo === "presupuesto" && campaignId && typeof opt.nuevo_presupuesto_micros === "number" && opt.nuevo_presupuesto_micros > 0) {
      actions.push({ ...common, actionType: "budget_update",
        payload: { newDailyBudgetMicros: Math.round(opt.nuevo_presupuesto_micros) },
        recKey: recKeyFor(target.accountRef, tipo, campaignId, String(opt.nuevo_presupuesto_micros)) });
    } else {
      skipped += 1;
    }
  }
  return { actions, skipped };
}
```

- [ ] **Step 6: Run tests**

Run: `bun test src/lib/command`
Expected: PASS.

- [ ] **Step 7: Create the routes** (all follow the same skeleton; each file sets `runtime`/`dynamic`, gates via `getCommandAccess()`)

`src/app/api/command/actions/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { createAction, listActions } from "@/lib/command/actions-repo";
import { CC_ACTION_TYPES, type CcActionType, type CcNetwork } from "@/lib/command/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const status = request.nextUrl.searchParams.get("status") ?? undefined;
  const network = request.nextUrl.searchParams.get("network") ?? undefined;
  try {
    const actions = await listActions(access.workspaceIds, {
      status: status as never, network: network as CcNetwork | undefined,
    });
    return NextResponse.json({ actions });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}

interface CreateBody {
  workspace_id?: unknown; network?: unknown; connection_id?: unknown; account_ref?: unknown;
  entity_kind?: unknown; entity_ref?: unknown; entity_name?: unknown;
  action_type?: unknown; payload?: unknown; rationale?: unknown;
}

export async function POST(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  let body: CreateBody;
  try { body = (await request.json()) as CreateBody; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : access.workspaceIds[0];
  if (!workspaceId || !access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }
  const network = body.network === "meta_ads" ? "meta_ads" : body.network === "google_ads" ? "google_ads" : null;
  const actionType = CC_ACTION_TYPES.includes(body.action_type as CcActionType) ? (body.action_type as CcActionType) : null;
  const entityKind = ["campaign", "ad_group", "adset"].includes(String(body.entity_kind)) ? String(body.entity_kind) : null;
  const accountRef = typeof body.account_ref === "string" && body.account_ref ? body.account_ref : null;
  const entityRef = typeof body.entity_ref === "string" && body.entity_ref ? body.entity_ref : null;
  if (!network || !actionType || !entityKind || !accountRef || !entityRef) {
    return NextResponse.json({ error: "Faltan campos: network, action_type, entity_kind, account_ref, entity_ref" }, { status: 400 });
  }
  if (network === "google_ads" && typeof body.connection_id !== "string") {
    return NextResponse.json({ error: "connection_id es obligatorio para Google Ads" }, { status: 400 });
  }
  try {
    const action = await createAction({
      workspaceId, createdBy: access.email, network,
      connectionId: network === "google_ads" ? String(body.connection_id) : null,
      accountRef, entityKind, entityRef,
      entityName: typeof body.entity_name === "string" ? body.entity_name : null,
      actionType, payload: (body.payload ?? {}) as never,
      source: "manual", rationale: typeof body.rationale === "string" ? body.rationale : null,
    });
    return NextResponse.json({ action });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
```

`src/app/api/command/actions/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getAction } from "@/lib/command/actions-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  const action = await getAction(id, access.workspaceIds);
  if (!action) return NextResponse.json({ error: "no encontrada" }, { status: 404 });
  return NextResponse.json({ action });
}
```

`src/app/api/command/actions/[id]/approve/route.ts` — **captures the drift baseline (`expected`) from a live snapshot at approve time**:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getAction, transitionAction } from "@/lib/command/actions-repo";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { adapterFor } from "@/lib/command/networks";
import type { CcActionRow } from "@/lib/command/actions-repo";
import type { CcEntityKind, CcNetwork, EntitySnapshot } from "@/lib/command/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  const action = await getAction(id, access.workspaceIds);
  if (!action) return NextResponse.json({ error: "no encontrada" }, { status: 404 });
  if (action.status !== "proposed" && action.status !== "failed") {
    return NextResponse.json({ error: `No se puede aprobar desde estado ${action.status}` }, { status: 409 });
  }
  let expected: Partial<EntitySnapshot> | null = null;
  try {
    const deps = buildExecutorDeps(access.accessToken);
    const auth = await deps.auth.resolve(action as CcActionRow);
    const adapter = adapterFor(action.network as CcNetwork);
    if (adapter.capabilities(auth).read) {
      const snap = await adapter.snapshot(auth, action.accountRef, action.entityKind as CcEntityKind, action.entityRef);
      expected = { status: snap.status, dailyBudgetMicros: snap.dailyBudgetMicros };
    }
  } catch { /* baseline opcional: DRIFT pasará sin expected */ }
  try {
    await transitionAction(action as CcActionRow, "approved", {
      approvedBy: access.email, approvedAt: new Date(), expected, error: null,
    });
    return NextResponse.json({ ok: true, expected });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 409 });
  }
}
```

`src/app/api/command/actions/[id]/reject/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getAction, transitionAction } from "@/lib/command/actions-repo";
import type { CcActionRow } from "@/lib/command/actions-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  const action = await getAction(id, access.workspaceIds);
  if (!action) return NextResponse.json({ error: "no encontrada" }, { status: 404 });
  try {
    await transitionAction(action as CcActionRow, "rejected", {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 409 });
  }
}
```

`src/app/api/command/actions/[id]/execute/route.ts` — **THE chokepoint route**:
```ts
// THE SINGLE EXECUTE CHOKEPOINT for the Centro de Mando. No other route may
// trigger network mutations. Two-step: the action must already be approved.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { executeAction } from "@/lib/command/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  try {
    const deps = buildExecutorDeps(access.accessToken);
    const outcome = await executeAction(id, access.email, access.workspaceIds, deps);
    if (!outcome.ok && outcome.blocked) {
      return NextResponse.json({ ok: false, blocked: outcome.blocked }, { status: 409 });
    }
    if (!outcome.ok) {
      return NextResponse.json({ ok: false, error: outcome.error }, { status: 502 });
    }
    return NextResponse.json(outcome);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
```

`src/app/api/command/actions/[id]/rollback/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { rollbackAction } from "@/lib/command/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const { id } = await params;
  try {
    const deps = buildExecutorDeps(access.accessToken);
    const outcome = await rollbackAction(id, access.email, access.workspaceIds, deps);
    if (!outcome.ok && outcome.blocked) return NextResponse.json({ ok: false, blocked: outcome.blocked }, { status: 409 });
    if (!outcome.ok) return NextResponse.json({ ok: false, error: outcome.error }, { status: 502 });
    return NextResponse.json(outcome);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
```

`src/app/api/command/import-engine/route.ts`:
```ts
// Pull gads-sentinel optimizations for one engine account and stage them as
// cc_actions (source='engine'), deduped by rec_key.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { fetchAccountFull } from "@/lib/sentinel";
import { mapEngineOptimizations } from "@/lib/command/engine-import";
import { createActionDeduped } from "@/lib/command/actions-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body { engine_account_id?: unknown; workspace_id?: unknown; connection_id?: unknown; account_ref?: unknown }

export async function POST(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  let body: Body;
  try { body = (await request.json()) as Body; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const engineAccountId = typeof body.engine_account_id === "string" ? body.engine_account_id : null;
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : access.workspaceIds[0];
  const connectionId = typeof body.connection_id === "string" ? body.connection_id : null;
  const accountRef = typeof body.account_ref === "string" ? body.account_ref : null;
  if (!engineAccountId || !workspaceId || !connectionId || !accountRef) {
    return NextResponse.json({ error: "Faltan campos: engine_account_id, connection_id, account_ref" }, { status: 400 });
  }
  if (!access.workspaceIds.includes(workspaceId)) return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  try {
    const full = await fetchAccountFull(engineAccountId);
    const opts = (full.ai_plan?.optimizations ?? []) as never[];
    const { actions, skipped } = mapEngineOptimizations(opts, {
      workspaceId, connectionId, accountRef, createdBy: access.email,
    });
    let imported = 0;
    let duplicated = 0;
    for (const a of actions) {
      const row = await createActionDeduped(a as never);
      if (row) imported += 1; else duplicated += 1;
    }
    return NextResponse.json({ imported, duplicated, skipped, total: opts.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 502 });
  }
}
```

`src/app/api/command/accounts/route.ts`:
```ts
// Unified account list: enabled Google connection accounts (Supabase, RLS)
// + Meta env-allowlisted accounts, with adapter capabilities.
import { NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { adapterFor } from "@/lib/command/networks";
import { metaAccountRefs } from "@/lib/command/networks/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  try {
    const db = createSupabaseReadClient(access.accessToken);
    const { data: connections } = await db
      .from("ads_google_connections")
      .select("id, workspace_id, google_email, status, ads_connection_accounts(id, customer_id, descriptive_name, currency, is_manager, enabled)")
      .in("workspace_id", access.workspaceIds);
    const google = (connections ?? []).flatMap((c) =>
      ((c.ads_connection_accounts as Array<Record<string, unknown>>) ?? [])
        .filter((a) => a.enabled === true && a.is_manager !== true)
        .map((a) => ({
          network: "google_ads" as const,
          accountRef: String(a.customer_id),
          name: (a.descriptive_name as string) ?? null,
          currency: (a.currency as string) ?? null,
          connectionId: String(c.id),
          workspaceId: String(c.workspace_id),
          googleEmail: String(c.google_email ?? ""),
        })));
    const metaCaps = adapterFor("meta_ads").capabilities({});
    const meta = metaAccountRefs().map((ref) => ({
      network: "meta_ads" as const, accountRef: ref, name: ref, currency: null,
      connectionId: null, workspaceId: access.workspaceIds[0] ?? null, googleEmail: null,
    }));
    return NextResponse.json({
      google, meta,
      capabilities: {
        google_ads: { read: google.length > 0, write: google.length > 0, reason: google.length ? undefined : "Sin cuentas habilitadas en Conexiones." },
        meta_ads: metaCaps,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
```

`src/app/api/command/settings/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { getCcSettings, saveCcSettings } from "@/lib/command/settings";
import { CC_ACTION_TYPES, type CcActionType } from "@/lib/command/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const workspaceId = request.nextUrl.searchParams.get("workspace") ?? access.workspaceIds[0];
  if (!workspaceId || !access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }
  return NextResponse.json({ workspaceId, settings: await getCcSettings(workspaceId) });
}

export async function POST(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : access.workspaceIds[0];
  if (!workspaceId || !access.workspaceIds.includes(workspaceId)) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }
  const patch: Record<string, unknown> = {};
  if (typeof body.executions_paused === "boolean") patch.executionsPaused = body.executions_paused;
  if (typeof body.max_budget_delta_pct === "number") patch.maxBudgetDeltaPct = Math.max(1, Math.min(100, body.max_budget_delta_pct));
  if (typeof body.max_actions_per_account_day === "number") patch.maxActionsPerAccountDay = Math.max(1, Math.min(200, body.max_actions_per_account_day));
  if (Array.isArray(body.allowed_action_types)) {
    patch.allowedActionTypes = body.allowed_action_types.filter((t): t is CcActionType => CC_ACTION_TYPES.includes(t as CcActionType));
  }
  try {
    const settings = await saveCcSettings(workspaceId, patch, access.email);
    return NextResponse.json({ workspaceId, settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
```

- [ ] **Step 8: Typecheck + tests**

Run: `bunx tsc --noEmit && bun test src/lib/command`
Expected: no new type errors; tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/command src/app/api/command
git commit -m "feat(command): access gate, real deps wiring, engine import, full /api/command surface"
```

---

### Task 10: Campaigns browse route + beta gating in shell, sidebar, command palette

**Files:**
- Create: `src/app/api/command/campaigns/route.ts`
- Modify: `src/components/app-shell.tsx` (thread a `commandCenter` boolean)
- Modify: `src/components/app-sidebar.tsx` (NAV_GROUPS ~line 199 + Icon map)
- Modify: `src/components/command-palette.tsx` (DESTINATIONS ~line 34)

**Before editing the components, READ the three files** — they are client components with typed props; mirror their existing prop/threading style exactly.

- [ ] **Step 1: Create `src/app/api/command/campaigns/route.ts`** (on-demand campaign snapshots for the Cuentas browser)

```ts
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { adapterFor } from "@/lib/command/networks";
import type { CcNetwork } from "@/lib/command/types";
import type { CcActionRow } from "@/lib/command/actions-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  const network = request.nextUrl.searchParams.get("network");
  const accountRef = request.nextUrl.searchParams.get("account");
  const connectionId = request.nextUrl.searchParams.get("connection");
  if ((network !== "google_ads" && network !== "meta_ads") || !accountRef) {
    return NextResponse.json({ error: "network y account son obligatorios" }, { status: 400 });
  }
  if (network === "google_ads" && !connectionId) {
    return NextResponse.json({ error: "connection es obligatorio para Google" }, { status: 400 });
  }
  try {
    const deps = buildExecutorDeps(access.accessToken);
    const auth = await deps.auth.resolve({
      network, connectionId: connectionId ?? null, workspaceId: access.workspaceIds[0] ?? "",
    } as CcActionRow);
    const adapter = adapterFor(network as CcNetwork);
    const caps = adapter.capabilities(auth);
    if (!caps.read) return NextResponse.json({ error: caps.reason ?? "sin acceso de lectura" }, { status: 409 });
    const campaigns = await adapter.listCampaigns(auth, accountRef);
    return NextResponse.json({ campaigns, capabilities: caps });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 502 });
  }
}
```

- [ ] **Step 2: Thread the flag through AppShell**

In `src/components/app-shell.tsx` (server component): compute the flag and admin state, pass to the sidebar and palette mount. Add near the top of the component body:

```tsx
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { isAdminEmail } from "@/lib/admin";

// inside the async AppShell component, before the return:
let commandCenter = false;
if (process.env.COMMAND_CENTER_BETA === "true") {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  commandCenter = Boolean(user?.email && isAdminEmail(user.email));
}
```

Then pass `commandCenter={commandCenter}` to `<AppSidebar …>` and to the command-palette mount component. If AppShell is not async, make it `async function AppShell`.

- [ ] **Step 3: Sidebar group** (in `src/components/app-sidebar.tsx`)

1. Add prop: `commandCenter?: boolean` to the component's props type.
2. Add an icon entry to the existing `Icon` map (same inline-SVG style as neighbors), key `"comando"`:
```tsx
comando: (
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8" />
  </>
),
```
3. Convert the static list into a function directly below `NAV_GROUPS` (keep `NAV_GROUPS` untouched) and use it in the render + active-href logic:
```tsx
const COMMAND_GROUP: NavGroup = {
  label: "Centro de Mando",
  items: [
    { href: "/command", label: "Resumen", icon: "comando" },
    { href: "/command/acciones", label: "Acciones", icon: "comando" },
    { href: "/command/cuentas", label: "Cuentas", icon: "comando" },
    { href: "/command/bitacora", label: "Bitácora", icon: "comando" },
  ],
};
function navGroups(commandCenter: boolean): NavGroup[] {
  return commandCenter ? [...NAV_GROUPS.slice(0, 1), COMMAND_GROUP, ...NAV_GROUPS.slice(1)] : NAV_GROUPS;
}
```
Replace both usages of `NAV_GROUPS` (the active-href loop at ~line 257 and the `.map` render at ~line 336) with `navGroups(commandCenter)`.

- [ ] **Step 4: Command palette entries** (in `src/components/command-palette.tsx`)

Add prop `commandCenter?: boolean` (threaded from AppShell through the mount component) and extend the destinations used for rendering:
```tsx
const COMMAND_DESTINATIONS: Destination[] = [
  { href: "/command", label: "Centro de Mando · Resumen" },
  { href: "/command/acciones", label: "Centro de Mando · Acciones" },
  { href: "/command/cuentas", label: "Centro de Mando · Cuentas" },
  { href: "/command/bitacora", label: "Centro de Mando · Bitácora" },
];
// where DESTINATIONS is consumed:
const destinations = commandCenter ? [...DESTINATIONS, ...COMMAND_DESTINATIONS] : DESTINATIONS;
```
(Adapt the `Destination` object shape to the file's actual type — read it first; if entries carry keywords/icons, copy a neighbor's shape.)

- [ ] **Step 5: Typecheck + build sanity**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components src/app/api/command
git commit -m "feat(command): beta-gated sidebar group, palette entries, campaigns browse route"
```

---

### Task 11: UI — /command layout, Resumen page, Cuentas page

**Files:**
- Create: `src/app/command/layout.tsx`
- Create: `src/app/command/page.tsx`
- Create: `src/app/command/resumen-client.tsx`
- Create: `src/app/command/cuentas/page.tsx`
- Create: `src/app/command/cuentas/cuentas-client.tsx`

**Mirror the canonical page template first:** read `src/app/security/page.tsx` + its layout to copy exact imports (`Header` breadcrumbs component path, main width/padding). UI text in Spanish.

- [ ] **Step 1: Create `src/app/command/layout.tsx`**

```tsx
import { notFound } from "next/navigation";
import AppShell from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { isAdminEmail } from "@/lib/admin";

export const dynamic = "force-dynamic";

export default async function CommandLayout({ children }: { children: React.ReactNode }) {
  if (process.env.COMMAND_CENTER_BETA !== "true") notFound();
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user?.email || !isAdminEmail(user.email)) notFound();
  return <AppShell>{children}</AppShell>;
}
```
(If `AppShell` is a named export or takes props in this repo, mirror `src/app/security/layout.tsx` exactly.)

- [ ] **Step 2: Create `src/app/command/page.tsx`** (Resumen)

```tsx
import { redirect } from "next/navigation";
import { PageHeader, Card, StatCard, ErrorCard, SectionLabel, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { countByStatus } from "@/lib/command/actions-repo";
import { getCcSettings } from "@/lib/command/settings";
import { adapterFor } from "@/lib/command/networks";
import { metaAccountRefs } from "@/lib/command/networks/meta";
import ResumenClient from "./resumen-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CommandPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  let error: string | null = null;
  let counts: Record<string, number> = {};
  let settings = null as Awaited<ReturnType<typeof getCcSettings>> | null;
  const workspaceId = access.workspaceIds[0] ?? null;
  try {
    counts = await countByStatus(access.workspaceIds);
    if (workspaceId) settings = await getCcSettings(workspaceId);
  } catch (e) {
    error = e instanceof Error ? e.message : "Error cargando el Centro de Mando";
  }
  const metaCaps = adapterFor("meta_ads").capabilities({});
  return (
    <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
      <PageHeader
        title="Centro de Mando"
        subtitle="Beta · ejecución aprobada con compuertas deterministas, bitácora y rollback. Nada se ejecuta sin aprobación humana."
      />
      {error ? <ErrorCard message={error} /> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 24 }}>
        <StatCard label="Propuestas" value={String(counts.proposed ?? 0)} sub="pendientes de revisión" />
        <StatCard label="Aprobadas" value={String(counts.approved ?? 0)} sub="listas para ejecutar" tone="warn" />
        <StatCard label="Ejecutadas" value={String(counts.executed ?? 0)} sub="con receta de rollback" tone="ok" />
        <StatCard label="Fallidas / revertidas" value={String((counts.failed ?? 0) + (counts.rolled_back ?? 0))} sub="ver bitácora" tone={counts.failed ? "danger" : "muted"} />
      </div>
      <Card>
        <SectionLabel>Redes</SectionLabel>
        <p style={{ color: UI.muted, margin: "8px 0 0" }}>
          Google Ads: opera sobre cuentas conectadas en Conexiones. · Meta Ads: {metaCaps.write
            ? `listo (${metaAccountRefs().length} cuentas permitidas)`
            : metaCaps.reason ?? "pendiente de credenciales"}.
        </p>
      </Card>
      {workspaceId && settings ? (
        <ResumenClient workspaceId={workspaceId} initialSettings={settings} />
      ) : null}
    </main>
  );
}
```

- [ ] **Step 3: Create `src/app/command/resumen-client.tsx`** (kill switch + caps editor)

```tsx
"use client";

import { useState } from "react";
import { Card, SectionLabel, Badge, PrimaryButton, GhostDangerButton, UI } from "@/components/ui-kit";
import type { CcSettingsValues } from "@/lib/command/types";

export default function ResumenClient({ workspaceId, initialSettings }: {
  workspaceId: string; initialSettings: CcSettingsValues;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: Record<string, unknown>) {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/command/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSettings(data.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error guardando ajustes");
    } finally { setBusy(false); }
  }

  return (
    <Card style={{ marginTop: 16 }}>
      <SectionLabel>Guardarraíles</SectionLabel>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <Badge tone={settings.executionsPaused ? "danger" : "ok"} dot>
          {settings.executionsPaused ? "Ejecuciones PAUSADAS (kill switch)" : "Ejecuciones habilitadas"}
        </Badge>
        {settings.executionsPaused ? (
          <PrimaryButton disabled={busy} onClick={() => save({ executions_paused: false })}>Reanudar ejecuciones</PrimaryButton>
        ) : (
          <GhostDangerButton disabled={busy} onClick={() => save({ executions_paused: true })}>Pausar todo (kill switch)</GhostDangerButton>
        )}
        <span style={{ color: UI.muted, fontSize: 13 }}>
          Δ presupuesto máx {settings.maxBudgetDeltaPct}% · {settings.maxActionsPerAccountDay} acciones/cuenta/día
        </span>
      </div>
      {error ? <p style={{ color: UI.danger, marginTop: 8 }}>{error}</p> : null}
    </Card>
  );
}
```
(If ui-kit buttons don't accept `onClick` on the server-safe variant, check `ui-kit.tsx`; in client components they render `<button>` so handlers work.)

- [ ] **Step 4: Create `src/app/command/cuentas/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { PageHeader, ErrorCard, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { adapterFor } from "@/lib/command/networks";
import { metaAccountRefs } from "@/lib/command/networks/meta";
import CuentasClient, { type UnifiedAccount } from "./cuentas-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CuentasPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  let error: string | null = null;
  const accounts: UnifiedAccount[] = [];
  try {
    const db = createSupabaseReadClient(access.accessToken);
    const { data: connections } = await db
      .from("ads_google_connections")
      .select("id, google_email, ads_connection_accounts(customer_id, descriptive_name, currency, is_manager, enabled)")
      .in("workspace_id", access.workspaceIds);
    for (const c of connections ?? []) {
      for (const a of (c.ads_connection_accounts as Array<Record<string, unknown>>) ?? []) {
        if (a.enabled === true && a.is_manager !== true) {
          accounts.push({
            network: "google_ads", accountRef: String(a.customer_id),
            name: (a.descriptive_name as string) ?? String(a.customer_id),
            connectionId: String(c.id),
          });
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Error cargando cuentas";
  }
  const metaCaps = adapterFor("meta_ads").capabilities({});
  for (const ref of metaAccountRefs()) {
    accounts.push({ network: "meta_ads", accountRef: ref, name: ref, connectionId: null });
  }
  return (
    <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
      <PageHeader title="Cuentas" subtitle="Cuentas operables por red. Selecciona una para explorar campañas y proponer acciones." />
      {error ? <ErrorCard message={error} /> : null}
      <CuentasClient accounts={accounts} metaWritable={metaCaps.write} metaReason={metaCaps.reason ?? null} />
    </main>
  );
}
```

- [ ] **Step 5: Create `src/app/command/cuentas/cuentas-client.tsx`**

```tsx
"use client";

import { useState } from "react";
import { Card, DataTable, THead, Row, Cell, Badge, EmptyState, SecondaryButton, PrimaryButton, UI } from "@/components/ui-kit";

export interface UnifiedAccount {
  network: "google_ads" | "meta_ads";
  accountRef: string;
  name: string;
  connectionId: string | null;
}
interface CampaignRow {
  entityKind: string; entityRef: string; name?: string | null;
  status?: string; dailyBudgetMicros?: number | null; learningPhase?: string;
}

const NET_LABEL = { google_ads: "Google Ads", meta_ads: "Meta Ads" } as const;

export default function CuentasClient({ accounts, metaWritable, metaReason }: {
  accounts: UnifiedAccount[]; metaWritable: boolean; metaReason: string | null;
}) {
  const [selected, setSelected] = useState<UnifiedAccount | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposing, setProposing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadCampaigns(account: UnifiedAccount) {
    setSelected(account); setCampaigns(null); setError(null); setBusy(true);
    try {
      const qs = new URLSearchParams({ network: account.network, account: account.accountRef });
      if (account.connectionId) qs.set("connection", account.connectionId);
      const res = await fetch(`/api/command/campaigns?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCampaigns(data.campaigns ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error cargando campañas");
    } finally { setBusy(false); }
  }

  async function propose(campaign: CampaignRow, actionType: "pause" | "enable") {
    if (!selected) return;
    setProposing(campaign.entityRef); setNotice(null); setError(null);
    try {
      const res = await fetch("/api/command/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: selected.network, connection_id: selected.connectionId,
          account_ref: selected.accountRef, entity_kind: campaign.entityKind,
          entity_ref: campaign.entityRef, entity_name: campaign.name ?? null,
          action_type: actionType, payload: {},
          rationale: `Propuesta manual desde Cuentas (${NET_LABEL[selected.network]})`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNotice(`Acción "${actionType}" propuesta para ${campaign.name ?? campaign.entityRef}. Revísala en Acciones.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error proponiendo acción");
    } finally { setProposing(null); }
  }

  return (
    <>
      <Card>
        {accounts.length === 0 ? (
          <EmptyState title="Sin cuentas operables" hint="Habilita cuentas en Conexiones (Google) o configura META_AD_ACCOUNT_IDS (Meta)." />
        ) : (
          <DataTable>
            <THead cols={[{ label: "Red" }, { label: "Cuenta" }, { label: "Referencia" }, { label: "" }]} />
            {accounts.map((a) => (
              <Row key={`${a.network}:${a.accountRef}`}>
                <Cell><Badge tone={a.network === "google_ads" ? "accent" : a.network === "meta_ads" && !metaWritable ? "muted" : "ok"}>{NET_LABEL[a.network]}</Badge></Cell>
                <Cell>{a.name}</Cell>
                <Cell mono>{a.accountRef}</Cell>
                <Cell><SecondaryButton disabled={busy} onClick={() => loadCampaigns(a)}>Ver campañas</SecondaryButton></Cell>
              </Row>
            ))}
          </DataTable>
        )}
        {!metaWritable && metaReason ? <p style={{ color: UI.muted, fontSize: 13, marginTop: 12 }}>Meta: {metaReason}</p> : null}
      </Card>
      {selected ? (
        <Card style={{ marginTop: 16 }}>
          <h3 style={{ margin: "0 0 12px", fontWeight: 600 }}>Campañas · {selected.name}</h3>
          {error ? <p style={{ color: UI.danger }}>{error}</p> : null}
          {notice ? <p style={{ color: UI.accent }}>{notice}</p> : null}
          {busy ? <p style={{ color: UI.muted }}>Cargando…</p> : null}
          {campaigns && campaigns.length === 0 ? <EmptyState title="Sin campañas" /> : null}
          {campaigns && campaigns.length > 0 ? (
            <DataTable>
              <THead cols={[{ label: "Campaña" }, { label: "Estado" }, { label: "Presupuesto/día", align: "right" }, { label: "Aprendizaje" }, { label: "Acciones" }]} />
              {campaigns.map((c) => (
                <Row key={c.entityRef}>
                  <Cell>{c.name ?? c.entityRef}</Cell>
                  <Cell><Badge tone={c.status === "ENABLED" ? "ok" : c.status === "PAUSED" ? "warn" : "muted"}>{c.status ?? "?"}</Badge></Cell>
                  <Cell align="right" mono>{c.dailyBudgetMicros != null ? (c.dailyBudgetMicros / 1_000_000).toFixed(2) : "—"}</Cell>
                  <Cell>{c.learningPhase ?? "—"}</Cell>
                  <Cell>
                    {c.status === "ENABLED" ? (
                      <SecondaryButton disabled={proposing === c.entityRef} onClick={() => propose(c, "pause")}>Proponer pausa</SecondaryButton>
                    ) : c.status === "PAUSED" ? (
                      <PrimaryButton disabled={proposing === c.entityRef} onClick={() => propose(c, "enable")}>Proponer activación</PrimaryButton>
                    ) : null}
                  </Cell>
                </Row>
              ))}
            </DataTable>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors. Fix any ui-kit prop mismatches by reading `src/components/ui-kit.tsx` (e.g. `THead` col shape, button props) and adapting.

- [ ] **Step 7: Commit**

```bash
git add src/app/command src/app/api/command
git commit -m "feat(command): layout gating, Resumen with kill switch, Cuentas browser with manual proposals"
```

---

### Task 12: UI — Acciones queue (approve → execute → gates → rollback) + engine import + composer

**Files:**
- Create: `src/app/command/acciones/page.tsx`
- Create: `src/app/command/acciones/acciones-client.tsx`

- [ ] **Step 1: Create `src/app/command/acciones/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { PageHeader, ErrorCard, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { listActions } from "@/lib/command/actions-repo";
import AccionesClient, { type ActionRowDto } from "./acciones-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AccionesPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  let error: string | null = null;
  let actions: ActionRowDto[] = [];
  try {
    const rows = await listActions(access.workspaceIds, { limit: 200 });
    actions = rows.map((r) => ({
      id: r.id, network: r.network as ActionRowDto["network"], accountRef: r.accountRef,
      entityKind: r.entityKind, entityRef: r.entityRef, entityName: r.entityName,
      actionType: r.actionType, payload: r.payload as Record<string, unknown>,
      source: r.source, status: r.status as ActionRowDto["status"],
      rationale: r.rationale, approvedBy: r.approvedBy,
      gateResults: (r.gateResults ?? null) as ActionRowDto["gateResults"],
      error: r.error, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    }));
  } catch (e) {
    error = e instanceof Error ? e.message : "Error cargando acciones";
  }
  return (
    <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
      <PageHeader
        title="Acciones"
        subtitle="Cola multi-red. Dos pasos siempre: Aprobar registra el baseline; Ejecutar corre las compuertas y solo entonces toca la red."
      />
      {error ? <ErrorCard message={error} /> : null}
      <AccionesClient initialActions={actions} />
    </main>
  );
}
```

- [ ] **Step 2: Create `src/app/command/acciones/acciones-client.tsx`**

```tsx
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, DataTable, THead, Row, Cell, Badge, EmptyState, SectionLabel, PrimaryButton, SecondaryButton, GhostDangerButton, UI } from "@/components/ui-kit";

export interface GateDto { id: string; severity: "blocking" | "warning"; status: "pass" | "fail"; evidence: string }
export interface ActionRowDto {
  id: string; network: "google_ads" | "meta_ads"; accountRef: string;
  entityKind: string; entityRef: string; entityName: string | null;
  actionType: string; payload: Record<string, unknown>; source: string;
  status: "proposed" | "approved" | "executing" | "executed" | "verified" | "failed" | "rolled_back" | "rejected" | "expired";
  rationale: string | null; approvedBy: string | null;
  gateResults: GateDto[] | null; error: string | null; createdAt: string | null;
}

const STATUS_TONE: Record<string, "ok" | "accent" | "warn" | "danger" | "muted"> = {
  proposed: "muted", approved: "warn", executing: "accent", executed: "ok",
  verified: "ok", failed: "danger", rolled_back: "muted", rejected: "muted", expired: "muted",
};
const TYPE_LABEL: Record<string, string> = {
  budget_update: "Cambio de presupuesto", pause: "Pausar", enable: "Activar", add_negatives: "Añadir negativas",
};
const NET_LABEL = { google_ads: "Google", meta_ads: "Meta" } as const;

export default function AccionesClient({ initialActions }: { initialActions: ActionRowDto[] }) {
  const router = useRouter();
  const [actions, setActions] = useState(initialActions);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [gatePanel, setGatePanel] = useState<{ id: string; gates: GateDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("todas");
  const [importForm, setImportForm] = useState({ engineAccountId: "", connectionId: "", accountRef: "" });
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const visible = useMemo(
    () => (filter === "todas" ? actions : actions.filter((a) => a.status === filter)),
    [actions, filter]
  );

  async function call(id: string, verb: "approve" | "reject" | "execute" | "rollback") {
    setBusyId(id); setError(null); setGatePanel(null);
    try {
      const res = await fetch(`/api/command/actions/${id}/${verb}`, { method: "POST" });
      const data = await res.json();
      if (res.status === 409 && data.blocked) {
        setGatePanel({ id, gates: data.blocked });
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.refresh();
      // optimistic local update so the row reflects immediately
      setActions((prev) => prev.map((a) => a.id === id ? {
        ...a,
        status: verb === "approve" ? "approved" : verb === "reject" ? "rejected"
          : verb === "execute" ? (data.dryRun ? "approved" : "executed") : "rolled_back",
      } : a));
      if (data.dryRun) setError("Modo CC_DRY_RUN activo: se registró un ensayo, no una ejecución real.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally { setBusyId(null); }
  }

  async function importEngine() {
    setImportMsg(null); setError(null);
    try {
      const res = await fetch("/api/command/import-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine_account_id: importForm.engineAccountId,
          connection_id: importForm.connectionId,
          account_ref: importForm.accountRef,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setImportMsg(`Importadas ${data.imported} (duplicadas ${data.duplicated}, no mapeables ${data.skipped}).`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error importando del motor");
    }
  }

  const inputStyle = { background: UI.surface2, border: `1px solid ${UI.border}`, borderRadius: 8, color: UI.text, padding: "8px 10px", fontSize: 13 } as const;

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <SectionLabel>Importar del motor (Google)</SectionLabel>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input style={inputStyle} placeholder="ID de cuenta en el motor" value={importForm.engineAccountId}
            onChange={(e) => setImportForm((f) => ({ ...f, engineAccountId: e.target.value }))} />
          <input style={inputStyle} placeholder="connection_id (Conexiones)" value={importForm.connectionId}
            onChange={(e) => setImportForm((f) => ({ ...f, connectionId: e.target.value }))} />
          <input style={inputStyle} placeholder="customer_id destino" value={importForm.accountRef}
            onChange={(e) => setImportForm((f) => ({ ...f, accountRef: e.target.value }))} />
          <SecondaryButton onClick={importEngine}>Importar recomendaciones</SecondaryButton>
          {importMsg ? <span style={{ color: UI.accent, fontSize: 13 }}>{importMsg}</span> : null}
        </div>
      </Card>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {["todas", "proposed", "approved", "executed", "failed", "rolled_back"].map((s) => (
          <SecondaryButton key={s} onClick={() => setFilter(s)}
            style={filter === s ? { borderColor: UI.accent, color: UI.accent } : undefined}>
            {s === "todas" ? "Todas" : s}
          </SecondaryButton>
        ))}
      </div>

      {error ? <p style={{ color: UI.warn, marginBottom: 12 }}>{error}</p> : null}

      {gatePanel ? (
        <Card style={{ marginBottom: 16, borderColor: UI.danger }}>
          <SectionLabel>Compuertas — ejecución bloqueada</SectionLabel>
          <DataTable>
            <THead cols={[{ label: "Compuerta" }, { label: "Severidad" }, { label: "Estado" }, { label: "Evidencia" }]} />
            {gatePanel.gates.map((g) => (
              <Row key={g.id}>
                <Cell mono>{g.id}</Cell>
                <Cell>{g.severity}</Cell>
                <Cell><Badge tone={g.status === "pass" ? "ok" : g.severity === "blocking" ? "danger" : "warn"}>{g.status}</Badge></Cell>
                <Cell>{g.evidence}</Cell>
              </Row>
            ))}
          </DataTable>
        </Card>
      ) : null}

      <Card>
        {visible.length === 0 ? (
          <EmptyState title="Sin acciones" hint="Importa recomendaciones del motor o propón acciones desde Cuentas." />
        ) : (
          <DataTable>
            <THead cols={[{ label: "Red" }, { label: "Acción" }, { label: "Entidad" }, { label: "Origen" }, { label: "Estado" }, { label: "" }]} />
            {visible.map((a) => (
              <Row key={a.id}>
                <Cell><Badge tone="muted">{NET_LABEL[a.network]}</Badge></Cell>
                <Cell>
                  {TYPE_LABEL[a.actionType] ?? a.actionType}
                  {a.actionType === "budget_update" && typeof a.payload.newDailyBudgetMicros === "number"
                    ? ` → ${(Number(a.payload.newDailyBudgetMicros) / 1_000_000).toFixed(2)}/día` : ""}
                  {a.rationale ? <span style={{ display: "block", color: UI.faint, fontSize: 12 }}>{a.rationale}</span> : null}
                  {a.error ? <span style={{ display: "block", color: UI.danger, fontSize: 12 }}>{a.error}</span> : null}
                </Cell>
                <Cell mono>{a.entityName ?? a.entityRef}<span style={{ color: UI.faint }}> · {a.accountRef}</span></Cell>
                <Cell>{a.source}</Cell>
                <Cell><Badge tone={STATUS_TONE[a.status] ?? "muted"}>{a.status}{a.approvedBy ? ` · ${a.approvedBy}` : ""}</Badge></Cell>
                <Cell>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {a.status === "proposed" || a.status === "failed" ? (
                      <>
                        <PrimaryButton disabled={busyId === a.id} onClick={() => call(a.id, "approve")}>Aprobar</PrimaryButton>
                        <GhostDangerButton disabled={busyId === a.id} onClick={() => call(a.id, "reject")}>Rechazar</GhostDangerButton>
                      </>
                    ) : null}
                    {a.status === "approved" ? (
                      <PrimaryButton disabled={busyId === a.id} onClick={() => call(a.id, "execute")}>
                        {busyId === a.id ? "Ejecutando…" : "Ejecutar"}
                      </PrimaryButton>
                    ) : null}
                    {a.status === "executed" || a.status === "verified" ? (
                      <GhostDangerButton disabled={busyId === a.id} onClick={() => call(a.id, "rollback")}>Revertir</GhostDangerButton>
                    ) : null}
                  </div>
                </Cell>
              </Row>
            ))}
          </DataTable>
        )}
      </Card>
    </>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean (adapt ui-kit prop shapes if needed by reading `ui-kit.tsx`).

- [ ] **Step 4: Commit**

```bash
git add src/app/command/acciones
git commit -m "feat(command): Acciones queue — approve/execute with gate panel, engine import, rollback"
```

---

### Task 13: UI — Bitácora (flight recorder) + Conexiones Meta status card

**Files:**
- Create: `src/app/command/bitacora/page.tsx`
- Create: `src/app/command/bitacora/bitacora-client.tsx`
- Modify: `src/app/conexiones/page.tsx` + its client (append Meta status card)

- [ ] **Step 1: Create `src/app/command/bitacora/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { PageHeader, ErrorCard, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { listExecutions } from "@/lib/command/actions-repo";
import BitacoraClient, { type ExecutionDto } from "./bitacora-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function BitacoraPage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  let error: string | null = null;
  let rows: ExecutionDto[] = [];
  try {
    const executions = await listExecutions(access.workspaceIds, 200);
    rows = executions.map(({ execution: e, action: a }) => ({
      id: e.id, actionId: a.id, network: a.network, accountRef: e.accountRef,
      operation: e.operation, validateOnly: e.validateOnly, status: e.status,
      actor: e.actor, createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : null,
      actionType: a.actionType, entityName: a.entityName ?? a.entityRef,
      actionStatus: a.status,
      before: (e.before ?? null) as Record<string, unknown> | null,
      after: (e.after ?? null) as Record<string, unknown> | null,
      rollbackNote: ((e.rollbackRecipe as { note?: string } | null)?.note) ?? null,
    }));
  } catch (e) {
    error = e instanceof Error ? e.message : "Error cargando la bitácora";
  }
  return (
    <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
      <PageHeader
        title="Bitácora"
        subtitle="Registro inmutable de cada ejecución: antes/después, actor, compuertas y receta de reversión."
      />
      {error ? <ErrorCard message={error} /> : null}
      <BitacoraClient rows={rows} />
    </main>
  );
}
```

- [ ] **Step 2: Create `src/app/command/bitacora/bitacora-client.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, DataTable, THead, Row, Cell, Badge, EmptyState, GhostDangerButton, UI } from "@/components/ui-kit";

export interface ExecutionDto {
  id: string; actionId: string; network: string; accountRef: string;
  operation: string; validateOnly: boolean; status: string; actor: string;
  createdAt: string | null; actionType: string; entityName: string; actionStatus: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  rollbackNote: string | null;
}

function fmtBudget(v: unknown): string {
  return typeof v === "number" ? (v / 1_000_000).toFixed(2) : "—";
}
function diffLine(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!before) return "—";
  const b = `estado ${before.status ?? "?"} · $${fmtBudget(before.dailyBudgetMicros)}/día`;
  if (!after) return b;
  return `${b} → estado ${after.status ?? "?"} · $${fmtBudget(after.dailyBudgetMicros)}/día`;
}

export default function BitacoraClient({ rows }: { rows: ExecutionDto[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revert(actionId: string) {
    setBusyId(actionId); setError(null);
    try {
      const res = await fetch(`/api/command/actions/${actionId}/rollback`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? (data.blocked ? "Bloqueada por compuertas" : `HTTP ${res.status}`));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error revirtiendo");
    } finally { setBusyId(null); }
  }

  return (
    <Card>
      {error ? <p style={{ color: UI.danger, marginBottom: 12 }}>{error}</p> : null}
      {rows.length === 0 ? (
        <EmptyState title="Bitácora vacía" hint="Las ejecuciones (reales y ensayos) aparecerán aquí con su antes/después." />
      ) : (
        <DataTable>
          <THead cols={[{ label: "Cuándo" }, { label: "Red / cuenta" }, { label: "Operación" }, { label: "Antes → Después" }, { label: "Actor" }, { label: "Estado" }, { label: "" }]} />
          {rows.map((r) => (
            <Row key={r.id}>
              <Cell mono>{r.createdAt ? new Date(r.createdAt).toLocaleString("es-MX") : "—"}</Cell>
              <Cell>{r.network === "google_ads" ? "Google" : "Meta"}<span style={{ color: UI.faint }}> · {r.accountRef}</span></Cell>
              <Cell>
                {r.entityName}
                <span style={{ display: "block", color: UI.faint, fontSize: 12 }}>
                  {r.operation}{r.validateOnly ? " · ensayo (dry-run)" : ""}
                </span>
              </Cell>
              <Cell>{diffLine(r.before, r.after)}</Cell>
              <Cell>{r.actor}</Cell>
              <Cell><Badge tone={r.status === "done" ? "ok" : r.status === "failed" ? "danger" : "muted"}>{r.status}</Badge></Cell>
              <Cell>
                {!r.validateOnly && r.status === "done" && (r.actionStatus === "executed" || r.actionStatus === "verified") ? (
                  <GhostDangerButton disabled={busyId === r.actionId} onClick={() => revert(r.actionId)}>
                    {busyId === r.actionId ? "Revirtiendo…" : "Revertir"}
                  </GhostDangerButton>
                ) : r.rollbackNote ? (
                  <span style={{ color: UI.faint, fontSize: 12 }}>{r.rollbackNote}</span>
                ) : null}
              </Cell>
            </Row>
          ))}
        </DataTable>
      )}
    </Card>
  );
}
```

- [ ] **Step 3: Conexiones — Meta status card**

Read `src/app/conexiones/page.tsx`. In the **server page**, compute and pass:
```tsx
const metaConfigured = Boolean((process.env.META_SYSTEM_USER_TOKEN ?? "").trim());
const metaAccounts = (process.env.META_AD_ACCOUNT_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
```
Render (or pass to the client and render there, matching how the page composes cards) a card AFTER the Google connections section:
```tsx
<Card style={{ marginTop: 16 }}>
  <SectionLabel>Meta Ads (beta · Centro de Mando)</SectionLabel>
  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
    <Badge tone={metaConfigured ? "ok" : "muted"} dot>
      {metaConfigured ? "Token de sistema configurado" : "Pendiente de credenciales"}
    </Badge>
    <span style={{ color: UI.muted, fontSize: 13 }}>
      {metaConfigured
        ? `${metaAccounts.length} cuenta(s) permitidas: ${metaAccounts.join(", ")}`
        : "Configura META_SYSTEM_USER_TOKEN y META_AD_ACCOUNT_IDS en el servidor para habilitar lecturas y ejecución en Meta."}
    </span>
  </div>
</Card>
```
Import whatever ui-kit pieces the page doesn't already import.

- [ ] **Step 4: Typecheck + tests**

Run: `bunx tsc --noEmit && bun test src/lib/command`
Expected: clean + PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/command/bitacora src/app/conexiones
git commit -m "feat(command): Bitácora flight recorder with rollback; Meta status card in Conexiones"
```

---

### Task 14: Full verification, deploy notes, wrap-up

**Files:**
- Create: `docs/superpowers/plans/DEPLOY-NOTES-command-center.md`

- [ ] **Step 1: Full test suite**

Run: `bun test src/lib/command`
Expected: ALL PASS (hash, state, gates, google adapter, meta adapter, settings, executor, engine-import).

- [ ] **Step 2: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: no NEW errors vs. `main` (pre-existing issues out of scope — verify with `git stash && bunx tsc --noEmit; git stash pop` if unsure).

- [ ] **Step 3: Production build**

Run: `bun run build`
If it fails on missing public env, create `.env.local` with the two public values already baked in the Dockerfile (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) — never add secrets.
Expected: build completes; `/command/*` routes listed in output.

- [ ] **Step 4: Dev smoke with Playwright MCP**

```bash
COMMAND_CENTER_BETA=true PORT=4200 bun run dev
```
Then with the Playwright browser tools: navigate `http://localhost:4200/command` → expect redirect to `/login` (no session) — confirms gating chain runs without crashing; navigate `http://localhost:4200/login` → page renders. Stop the dev server.

- [ ] **Step 5: Write `docs/superpowers/plans/DEPLOY-NOTES-command-center.md`**

```markdown
# Deploy — Centro de Mando (beta)

NO merge to main without Pedro. Steps at release time:
1. Merge `feat/command-center-beta` → main (Coolify auto-deploys app tk8s8s4k44s8co8ow8cw8koo).
2. Coolify env (runtime): COMMAND_CENTER_BETA=true · CC_DRY_RUN=true (first week!) ·
   META_SYSTEM_USER_TOKEN=<crear en Meta Business Manager: system user con ads_read+ads_management sobre las cuentas> ·
   META_AD_ACCOUNT_IDS=act_xxx,act_yyy · META_API_VERSION=<verificada en docs>.
3. POST /api/migrate (admin logueado) → verifica "007_command_center" en schema_migrations.
4. Smoke en prod con CC_DRY_RUN=true: importar del motor → aprobar → ejecutar (ensayo) → bitácora.
5. Primera ejecución real: budget_update mínimo en cuenta interna → verificar en Google Ads UI → revertir → verificar.
6. Quitar CC_DRY_RUN cuando la bitácora tenga ≥1 semana limpia.
Pendiente Pedro: crear el system user token de Meta (Business Manager → Usuarios del sistema → generar token con ads_management).
```

- [ ] **Step 6: Final commit + summary**

```bash
git add -A && git commit -m "docs(command): deploy notes for Centro de Mando beta"
git log --oneline main..HEAD
```
Report: list of commits, test count, and any pre-existing issues encountered.

---

## Plan self-review notes

- Spec coverage: §6 tables→Task 3; §7 adapters→Tasks 5–6; §8 gates→Task 4; §9 chokepoint/lifecycle/routes→Tasks 8–9; §10 UI→Tasks 10–13; §11 env/deploy→Task 14; §13 testing→Tasks 1–9. Settings UI (kill switch + caps display) lives in Resumen (Task 11).
- Types cross-checked: `CcActionInput`/`EntitySnapshot`/`GateResult`/`ExecutorDeps` names consistent across Tasks 1, 4, 5, 6, 8, 9.
- Known adaptation points (NOT placeholders — the implementer must read the named file and mirror its real shape): ui-kit prop shapes, AppShell/AppSidebar/CommandPalette prop threading, conexiones page composition, Header import path. Each task names the exact file to read first.

---

### Task 15: Knowledge pack — MIT playbooks + distilled threshold constants

**Files:**
- Create: `docs/knowledge/ads/ATTRIBUTION.md`
- Create: `docs/knowledge/ads/meta-decision-system.md` (copied, MIT)
- Create: `docs/knowledge/ads/google-search-playbook.md` (copied, MIT)
- Create: `docs/knowledge/ads/safe-executor.md` (copied, MIT)
- Create: `src/lib/command/knowledge.ts` (distilled numeric constants)
- Test: `src/lib/command/__tests__/knowledge.test.ts`

Context: `docs/research/2026-07-07-oss-harvest-verdict.md` records the sources/licenses.
The three copied markdown files come from the session harvest clones (all MIT):
`marketingskills/skills/ads/references/{meta-decision-system,google-search-playbook}.md`
and `NotFair/google-ads/manage/references/safe-executor.md`. These are Copiloto
grounding docs (not executed). `knowledge.ts` distills the numbers the gate engine and
`source='regla'` suggestions will use. Numbers are facts (not copyrightable); the prose
files carry MIT notices via ATTRIBUTION.md.

- [ ] **Step 1: Copy the three MIT playbook files**

Copy verbatim from the harvest clones into `docs/knowledge/ads/` (keep any in-file
lineage footers). If the clones are gone, re-clone shallowly:
```bash
cd /tmp && rm -rf _kh && mkdir _kh && cd _kh
git clone --depth 1 https://github.com/coreyhaines31/marketingskills.git
git clone --depth 1 https://github.com/nowork-studio/notfair.git
cp marketingskills/skills/ads/references/meta-decision-system.md /home/coder/projects/ads-airankia/docs/knowledge/ads/
cp marketingskills/skills/ads/references/google-search-playbook.md /home/coder/projects/ads-airankia/docs/knowledge/ads/
cp notfair/google-ads/manage/references/safe-executor.md /home/coder/projects/ads-airankia/docs/knowledge/ads/
```
(Adjust the safe-executor path if the repo layout differs — find it with `find notfair -name safe-executor.md`.)

- [ ] **Step 2: Write `docs/knowledge/ads/ATTRIBUTION.md`**

```markdown
# Attribution — third-party knowledge in this directory

The playbook markdown here is copied under MIT and used as AI grounding (not executed).
Numeric thresholds distilled into `src/lib/command/knowledge.ts` are facts (not
copyrightable) and carry courtesy source comments.

- `meta-decision-system.md`, `google-search-playbook.md` — from
  coreyhaines31/marketingskills, MIT License, Copyright (c) 2025 Corey Haines.
  Lineage (per the files' own footers): adapted from practitioner operating systems,
  notably Ivan Falco's ads-skills. Thresholds are starting points — recalibrate per account.
- `safe-executor.md` — from nowork-studio/NotFair, MIT License,
  Copyright (c) 2026 Toprank Contributors.
- Check-registry thresholds referenced in code comments — from AgriciDaniel/claude-ads,
  MIT License, Copyright (c) 2026 agricidaniel.

MIT permission notice (applies to the copied files above):
> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files... The above copyright notice and this
> permission notice shall be included in all copies or substantial portions of the Software.

NOT included from research: pipeboard-co/meta-ads-mcp (BSL 1.1, non-compete — study only).
```

- [ ] **Step 3: Write the failing test** `src/lib/command/__tests__/knowledge.test.ts`

```ts
import { describe, it, expect } from "bun:test";
import { META_THRESHOLDS, GOOGLE_THRESHOLDS, budgetStepOk, isFatigued } from "../knowledge";

describe("knowledge constants", () => {
  it("exposes the canonical scaling + kill numbers", () => {
    expect(META_THRESHOLDS.scaleStepPct).toBe(20);
    expect(META_THRESHOLDS.scaleCadenceDays).toBe(5);
    expect(META_THRESHOLDS.killCpaMultiple).toBe(3);
    expect(META_THRESHOLDS.learningConversionsPerWeek).toBe(50);
    expect(GOOGLE_THRESHOLDS.smartBiddingMinConv30d).toBe(30);
    expect(GOOGLE_THRESHOLDS.budgetSpendMultiplierPerDay).toBe(2);
  });
  it("budgetStepOk enforces +20%/5d style single-step ceiling", () => {
    expect(budgetStepOk(10_000_000, 12_000_000)).toBe(true);   // +20%
    expect(budgetStepOk(10_000_000, 13_000_000)).toBe(false);  // +30%
    expect(budgetStepOk(10_000_000, 9_000_000)).toBe(true);    // decrease always ok
  });
  it("isFatigued flags frequency+CTR-decay on prospecting", () => {
    expect(isFatigued({ campaignType: "prospecting", frequency7d: 4.5, ctrDeltaPct: -25 })).toBe(true);
    expect(isFatigued({ campaignType: "prospecting", frequency7d: 1.5, ctrDeltaPct: -5 })).toBe(false);
    expect(isFatigued({ campaignType: "retargeting", frequency7d: 5.0, ctrDeltaPct: -10 })).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `bun test src/lib/command`
Expected: FAIL (cannot resolve `../knowledge`).

- [ ] **Step 5: Create `src/lib/command/knowledge.ts`**

```ts
// Distilled paid-media thresholds (facts) powering source='regla' suggestions and
// future gate tuning. Sources (MIT): coreyhaines31/marketingskills, AgriciDaniel/
// claude-ads, nowork-studio/NotFair — see docs/knowledge/ads/ATTRIBUTION.md.
// All budgets in micros. Thresholds are starting points; recalibrate per account.

export const META_THRESHOLDS = {
  scaleStepPct: 20,               // +20% per scale move (never >=30% — resets learning)
  scaleCadenceDays: 5,            // wait 5 days between scale steps
  killCpaMultiple: 3,             // spend > 3x target CPA with 0 conv -> pause
  learningConversionsPerWeek: 50, // learning-phase exit ("50 in 7")
  learningResetBudgetDeltaPct: 20,// budget delta >20% resets learning
  freqProspectingWarn: 3.0,       // ad-set frequency/7d warn
  freqProspectingCritical: 4.0,
  freqRetargetingCritical: 6.0,
  ctrDecayPctFatigue: -20,        // CTR down >=20% over 7d = fatigue
  budgetSufficiencyCpaMultiple: 5,// daily budget >= 5x target CPA per ad set
} as const;

export const GOOGLE_THRESHOLDS = {
  smartBiddingMinConv30d: 30,     // >=30 conv/30d before Target CPA/ROAS
  broadMatchMinConv30d: 30,       // broad match only with smart bidding + 30 conv + negatives
  tcpaStepPct: 15,                // move tCPA in +/-10-15% steps
  budgetSpendMultiplierPerDay: 2, // campaigns can spend up to 2x daily budget in a day
  wastedSpendClickFloor: 3,       // search terms with >=3 clicks and 0 conv -> negative candidate
  qualityScoreFloor: 7,           // avg QS >= 7 healthy
} as const;

/** A single budget step must not raise spend by >= META scaleStepPct. Decreases always ok. */
export function budgetStepOk(prevMicros: number, nextMicros: number): boolean {
  if (prevMicros <= 0) return false;
  if (nextMicros <= prevMicros) return true;
  const pct = (nextMicros - prevMicros) / prevMicros * 100;
  return pct < META_THRESHOLDS.scaleStepPct + 0.0001 ? pct <= META_THRESHOLDS.scaleStepPct : false;
}

export interface FatigueSignal { campaignType: "prospecting" | "retargeting"; frequency7d: number; ctrDeltaPct: number }

/** Prospecting fatigue = frequency over critical AND CTR decayed past the fatigue floor. */
export function isFatigued(s: FatigueSignal): boolean {
  const freqCritical = s.campaignType === "prospecting"
    ? META_THRESHOLDS.freqProspectingCritical
    : META_THRESHOLDS.freqRetargetingCritical;
  return s.frequency7d >= freqCritical && s.ctrDeltaPct <= META_THRESHOLDS.ctrDecayPctFatigue;
}
```

- [ ] **Step 6: Run tests**

Run: `bun test src/lib/command`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/knowledge docs/research src/lib/command/knowledge.ts src/lib/command/__tests__/knowledge.test.ts
git commit -m "feat(command): knowledge pack — MIT playbooks + distilled ad thresholds (attribution recorded)"
```
