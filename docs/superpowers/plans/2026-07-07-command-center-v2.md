# Command Center v2 — Guided Google Search Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship slice 1 of Command Center v2 — a guided UI that creates a full Google Search campaign (budget → campaign → ad group → keywords → RSA) on a connected client account, compiled into ordered actions that run through the **untouched** v1 gate→ledger→rollback engine, created PAUSED, with per-field AI suggestions.

**Architecture:** An editable JSONB **blueprint** (`cc_blueprints`) → a pure `compile()` → ordered `cc_actions` with `tmp:` parent-refs → a **plan runner** that resolves refs and calls the existing `executeAction` per action → reverse-order `rollbackBlueprint`. Creation adds new action types to the existing Google adapter; three tiny gate edits (no new module); one executor edit (synthetic `before` for creates).

**Tech Stack:** Next.js 16.2.2 App Router (async params, `runtime="nodejs"`, `force-dynamic`), TypeScript 5, Drizzle + pg (ADS DB), Supabase SSR (auth/RLS), Zod (blueprint validation), `bun test`, Google Ads REST API v21, OpenRouter `callStructured` for AI.

**Spec:** `docs/superpowers/specs/2026-07-07-command-center-v2-design.md` (READ FIRST). Builds on v1 (committed).

## Global Constraints

- Branch `feat/command-center-beta`; NEVER push/touch main. Commit after each task. bun at `~/.bun/bin/bun`; tests `~/.bun/bin/bun test src/lib/command`; typecheck `~/.local/bin/bunx tsc --noEmit`.
- **Sacred invariants (spec §2):** created campaigns are PAUSED (`status:'PAUSED'` explicit, missing = fail-closed); AI proposes / human accepts / gates enforce — no AI route calls `executeAction`; the runner may ONLY substitute `tmp:` placeholders in an approved payload (deep-equal-except-resolved), under the optimistic status guard; `/api/command/actions/[id]/execute` stays the single per-action chokepoint (the runner is a loop *above* it, never beside).
- **Frozen vocabulary:** action types `create_budget`, `create_campaign`, `create_ad_group`, `create_keywords`, `create_ad` (user-proposable) + `remove_entity` (internal-only rollback). Ref convention `tmp:<localRef>`, `localRef = "<kind>:<seq>"` (e.g. `tmp:budget:1`, `tmp:campaign:2`).
- **Money:** all budgets in micros. Google native micros. RSA limits: headlines 3–15 each ≤30 chars; descriptions 2–4 each ≤90; path1/path2 ≤15. Google mutate field masks are **camelCase** (`amountMicros`), GAQL is snake_case.
- **Next 16:** `await params` on dynamic routes; every route `export const runtime="nodejs"; export const dynamic="force-dynamic";` + the `getCommandAccess()` gate.
- UI text in Spanish (es-MX). Reuse ui-kit primitives; `AppShell` is a **named** export; every page renders `<Header breadcrumbs>`; wrap `<Row>` in `<tbody>`.
- Repo conventions primer for v1 lives in `docs/superpowers/plans/2026-07-07-command-center-beta.md` lines 1-33 — the same rules apply.

---

### Task 1: Migration 008 + Drizzle schema (cc_blueprints + cc_actions columns)

**Files:**
- Modify: `src/lib/schema.ts` (append `ccBlueprints`; add 4 columns to `ccActions`)
- Modify: `src/app/api/migrate/route.ts` (append `008_command_center_v2` block)

**Interfaces:**
- Produces: Drizzle `ccBlueprints` table (`$inferSelect`/`$inferInsert`); `ccActions.blueprintId/seq/localRef/resultRef` columns; `cc_blueprints` + the new `cc_actions` columns in the DB via `/api/migrate`.

- [ ] **Step 1: Append `ccBlueprints` + the 4 `ccActions` columns to `src/lib/schema.ts`**

Add the 4 columns inside the existing `ccActions` pgTable definition (after `error`):
```ts
    blueprintId: uuid("blueprint_id"),
    seq: integer("seq"),
    localRef: text("local_ref"),
    resultRef: text("result_ref"),
```
Append at end of file:
```ts
export const ccBlueprints = pgTable(
  "cc_blueprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    createdBy: text("created_by").notNull(),
    network: text("network").notNull(),
    accountRef: text("account_ref").notNull(),
    connectionId: uuid("connection_id"),
    doc: jsonb("doc").notNull(),
    status: text("status").default("draft").notNull(), // draft|approved|executing|executed|failed
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_cc_blueprints_workspace").on(table.workspaceId)]
);
```

- [ ] **Step 2: Append the 008 block to `/api/migrate`** (inside `migrations` array, before the closing `];`)
```ts
    // 008_command_center_v2 — guided builder: blueprints + action threading columns.
    sql`ALTER TABLE cc_actions ADD COLUMN IF NOT EXISTS blueprint_id UUID`,
    sql`ALTER TABLE cc_actions ADD COLUMN IF NOT EXISTS seq INT`,
    sql`ALTER TABLE cc_actions ADD COLUMN IF NOT EXISTS local_ref TEXT`,
    sql`ALTER TABLE cc_actions ADD COLUMN IF NOT EXISTS result_ref TEXT`,
    sql`CREATE INDEX IF NOT EXISTS idx_cc_actions_blueprint ON cc_actions(blueprint_id, seq)`,
    sql`CREATE TABLE IF NOT EXISTS cc_blueprints (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL,
      created_by TEXT NOT NULL,
      network TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      connection_id UUID,
      doc JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE INDEX IF NOT EXISTS idx_cc_blueprints_workspace ON cc_blueprints(workspace_id)`,
    sql`UPDATE cc_settings SET allowed_action_types =
      '["budget_update","pause","enable","add_negatives","create_budget","create_campaign","create_ad_group","create_keywords","create_ad"]'::jsonb
      WHERE NOT (allowed_action_types ? 'create_campaign')`,
    sql`INSERT INTO schema_migrations (version) VALUES ('008_command_center_v2') ON CONFLICT (version) DO NOTHING`,
```

- [ ] **Step 3: Typecheck.** Run `~/.local/bin/bunx tsc --noEmit` → exit 0.
- [ ] **Step 4: Commit.**
```bash
git add src/lib/schema.ts src/app/api/migrate/route.ts
git commit -m "feat(v2): cc_blueprints table + cc_actions blueprint columns + 008 migration"
```

---

### Task 2: types.ts — create action families, payloads, ExecOutcome.resourceNames

**Files:**
- Modify: `src/lib/command/types.ts`
- Modify: `src/lib/command/executor.ts` (add `resourceNames?` to `ExecOutcome`)

**Interfaces:**
- Consumes: v1 `CcActionType`, `CcEntityKind`, `CcPayload`, `NetworkAdapter`.
- Produces: extended `CcInternalActionType` (create family + `remove_entity`); `CcEntityKind` gains `"ad"`; `CreateBudgetPayload`, `CreateCampaignPayload`, `CreateAdGroupPayload`, `CreateKeywordsPayload`, `CreateAdPayload`, `RemoveEntityPayload`; `BiddingStrategy` type; `ExecOutcome.resourceNames?: string[]`.

- [ ] **Step 1: Edit `src/lib/command/types.ts`** — widen entity kind + action type, add payloads.
Replace the `CcEntityKind` and `CcInternalActionType` lines:
```ts
export type CcEntityKind = "campaign" | "ad_group" | "adset" | "ad";
```
```ts
export type CcCreateActionType =
  | "create_budget" | "create_campaign" | "create_ad_group" | "create_keywords" | "create_ad";
export type CcInternalActionType = CcActionType | CcCreateActionType | "remove_negatives" | "remove_entity";
```
Add after the existing payload interfaces:
```ts
export type BiddingStrategy = "MAXIMIZE_CONVERSIONS" | "TARGET_CPA" | "TARGET_ROAS";
/** A parent reference: either a live Google resourceName or a `tmp:<localRef>` placeholder. */
export type CcRef = string;
export interface CreateBudgetPayload { name: string; amountMicros: number }
export interface CreateCampaignPayload {
  name: string; status: "PAUSED"; channel: "SEARCH"; budgetRef: CcRef;
  bidding: { strategy: BiddingStrategy; targetCpaMicros?: number; targetRoas?: number };
  geoTargetIds: string[]; languageId?: string; presenceOnly: boolean;
}
export interface CreateAdGroupPayload { name: string; campaignRef: CcRef; cpcBidMicros?: number }
export interface CreateKeywordsPayload {
  adGroupRef: CcRef;
  keywords: Array<{ text: string; match: "EXACT" | "PHRASE" | "BROAD"; negative?: boolean }>;
}
export interface CreateAdPayload {
  adGroupRef: CcRef; finalUrl: string;
  headlines: Array<{ text: string; pinnedField?: string }>;
  descriptions: Array<{ text: string }>; path1?: string; path2?: string;
}
export interface RemoveEntityPayload { resourceNames: string[] }
```
Extend `CcPayload`:
```ts
export type CcPayload =
  | BudgetUpdatePayload | NegativesPayload | RemoveNegativesPayload
  | CreateBudgetPayload | CreateCampaignPayload | CreateAdGroupPayload
  | CreateKeywordsPayload | CreateAdPayload | RemoveEntityPayload
  | Record<string, never>;
```

- [ ] **Step 2: Add `resourceNames` to `ExecOutcome`** in `src/lib/command/executor.ts` (the interface near the top):
```ts
export interface ExecOutcome {
  ok: boolean;
  blocked?: GateResult[];
  dryRun?: boolean;
  error?: string;
  executionId?: string;
  resourceNames?: string[];
}
```
And in `executeAction`, in the success branch, thread `resourceNames` from the write result: after `performWrite` returns `result.ok`, change the success `return` to include them — `performWrite`'s success path already has `exec.resourceNames`; surface it by having `performWrite` return `{ ok, executionId, resourceNames }` and the caller pass it through: in `performWrite` success `return { ok: true, executionId: ledger.id, resourceNames: exec.resourceNames }` and in `executeAction` success `return { ok: true, executionId: result.executionId, resourceNames: result.resourceNames }`.

- [ ] **Step 3: Typecheck.** `~/.local/bin/bunx tsc --noEmit` → exit 0 (expect a few "not handled in switch" errors ONLY if adapters exhaustively switch — google.ts/meta.ts default-throw on unknown actionType, so they compile; if tsc flags an exhaustiveness issue, note it — Task 6/8 add the cases).
- [ ] **Step 4: Run tests** `~/.bun/bin/bun test src/lib/command` → still green (63 pass).
- [ ] **Step 5: Commit.**
```bash
git add src/lib/command/types.ts src/lib/command/executor.ts
git commit -m "feat(v2): create action families, payloads, ExecOutcome.resourceNames"
```

---

### Task 3: knowledge.ts — RSA_SPEC constants

**Files:**
- Modify: `src/lib/command/knowledge.ts`
- Test: `src/lib/command/__tests__/knowledge.test.ts` (extend)

**Interfaces:**
- Produces: `RSA_SPEC` const (headline/description/path limits) consumed by the blueprint Zod schema (Task 4) and the AI suggest schemas (Task 12).

- [ ] **Step 1: Write the failing test** (append inside the existing `describe` in `knowledge.test.ts`):
```ts
import { RSA_SPEC } from "../knowledge";
// ...
it("RSA_SPEC carries Google's real RSA limits", () => {
  expect(RSA_SPEC.headline.maxLen).toBe(30);
  expect(RSA_SPEC.headline.min).toBe(3);
  expect(RSA_SPEC.headline.max).toBe(15);
  expect(RSA_SPEC.description.maxLen).toBe(90);
  expect(RSA_SPEC.description.min).toBe(2);
  expect(RSA_SPEC.description.max).toBe(4);
  expect(RSA_SPEC.path.maxLen).toBe(15);
});
```
- [ ] **Step 2: Run → fail** (`~/.bun/bin/bun test src/lib/command` → RSA_SPEC undefined).
- [ ] **Step 3: Add to `knowledge.ts`:**
```ts
/** Google Responsive Search Ad limits (API-enforced; validateOnly is the authoritative backstop). */
export const RSA_SPEC = {
  headline: { min: 3, max: 15, maxLen: 30 },
  description: { min: 2, max: 4, maxLen: 90 },
  path: { maxLen: 15 },
} as const;
```
- [ ] **Step 4: Run → pass.** - [ ] **Step 5: Commit** `git add src/lib/command/knowledge.ts src/lib/command/__tests__/knowledge.test.ts && git commit -m "feat(v2): RSA_SPEC limit constants in knowledge pack"`

---

### Task 4: Blueprint Zod schema (Google Search)

**Files:**
- Create: `src/lib/command/blueprint/schema.ts`
- Test: `src/lib/command/__tests__/blueprint-schema.test.ts`

**Interfaces:**
- Consumes: `RSA_SPEC` (Task 3), `MICROS_PER_UNIT` (types).
- Produces: `CcBlueprintDoc` (type), `blueprintDocSchema` (Zod), `parseBlueprint(doc): CcBlueprintDoc` (throws on invalid). Zod is a devDependency check — confirm `zod` is installed (`grep '"zod"' package.json`); if absent, `~/.bun/bin/bun add zod` in Step 3.

- [ ] **Step 1: Write the failing test** `src/lib/command/__tests__/blueprint-schema.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { blueprintDocSchema, parseBlueprint } from "../blueprint/schema";

function validDoc() {
  return {
    network: "google_ads",
    campaign: {
      nodeId: "c1", tempId: "campaign:2", name: "Sonrisa — Búsqueda MX",
      channel: "SEARCH", status: "PAUSED",
      budget: { nodeId: "b1", tempId: "budget:1", dailyMicros: 350_000_000 },
      bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
      geo: { countryCodes: ["MX"], presenceOnly: true },
      adGroups: [{
        nodeId: "g1", tempId: "ad_group:3", name: "Implantes",
        keywords: [{ text: "implantes dentales cdmx", match: "PHRASE" }],
        negatives: [{ text: "gratis", match: "PHRASE" }],
        ads: [{
          nodeId: "a1", tempId: "ad:4", finalUrl: "https://clinicasonrisa.mx/implantes",
          headlines: [{ text: "Implantes en CDMX" }, { text: "Valoración Gratis" }, { text: "Clínica Sonrisa" }],
          descriptions: [{ text: "Recupera tu sonrisa con especialistas certificados." }, { text: "Agenda sin costo hoy." }],
        }],
      }],
    },
  };
}

describe("blueprintDocSchema", () => {
  it("accepts a valid Google Search blueprint", () => {
    expect(() => parseBlueprint(validDoc())).not.toThrow();
  });
  it("rejects a non-PAUSED campaign", () => {
    const d = validDoc(); d.campaign.status = "ENABLED";
    expect(() => parseBlueprint(d)).toThrow();
  });
  it("rejects empty geo (fail-closed)", () => {
    const d = validDoc(); d.campaign.geo.countryCodes = [];
    expect(() => parseBlueprint(d)).toThrow();
  });
  it("rejects fewer than 3 headlines", () => {
    const d = validDoc(); d.campaign.adGroups[0].ads[0].headlines = [{ text: "Solo uno" }];
    expect(() => parseBlueprint(d)).toThrow();
  });
  it("rejects a headline over 30 chars", () => {
    const d = validDoc(); d.campaign.adGroups[0].ads[0].headlines[0] = { text: "x".repeat(31) };
    expect(() => parseBlueprint(d)).toThrow();
  });
  it("rejects an ad group with zero keywords", () => {
    const d = validDoc(); d.campaign.adGroups[0].keywords = [];
    expect(() => parseBlueprint(d)).toThrow();
  });
});
```

- [ ] **Step 2: Run → fail.** Confirm `zod` present: `grep '"zod"' package.json` (if missing: `~/.bun/bin/bun add zod`).

- [ ] **Step 3: Create `src/lib/command/blueprint/schema.ts`:**
```ts
import { z } from "zod";
import { RSA_SPEC } from "../knowledge";
import { MICROS_PER_UNIT } from "../types";

const match = z.enum(["EXACT", "PHRASE", "BROAD"]);
const headline = z.object({ text: z.string().min(1).max(RSA_SPEC.headline.maxLen), pinnedField: z.string().optional() });
const description = z.object({ text: z.string().min(1).max(RSA_SPEC.description.maxLen) });

const ad = z.object({
  nodeId: z.string(), tempId: z.string(),
  finalUrl: z.string().url(),
  headlines: z.array(headline).min(RSA_SPEC.headline.min).max(RSA_SPEC.headline.max),
  descriptions: z.array(description).min(RSA_SPEC.description.min).max(RSA_SPEC.description.max),
  path1: z.string().max(RSA_SPEC.path.maxLen).optional(),
  path2: z.string().max(RSA_SPEC.path.maxLen).optional(),
});

const adGroup = z.object({
  nodeId: z.string(), tempId: z.string(), name: z.string().min(1), cpcMicros: z.number().int().optional(),
  keywords: z.array(z.object({ text: z.string().min(1), match })).min(1),
  negatives: z.array(z.object({ text: z.string().min(1), match })).default([]),
  ads: z.array(ad).min(1),
});

export const blueprintDocSchema = z.object({
  network: z.literal("google_ads"),
  campaign: z.object({
    nodeId: z.string(), tempId: z.string(), name: z.string().min(1),
    channel: z.literal("SEARCH"), status: z.literal("PAUSED"),
    budget: z.object({ nodeId: z.string(), tempId: z.string(), dailyMicros: z.number().int().min(MICROS_PER_UNIT) }),
    bidding: z.object({
      strategy: z.enum(["MAXIMIZE_CONVERSIONS", "TARGET_CPA", "TARGET_ROAS"]),
      targetCpaMicros: z.number().int().optional(), targetRoas: z.number().optional(),
    }),
    geo: z.object({ countryCodes: z.array(z.string().min(2)).min(1), presenceOnly: z.boolean() }),
    languageCode: z.string().optional(),
    adGroups: z.array(adGroup).min(1),
  }),
});

export type CcBlueprintDoc = z.infer<typeof blueprintDocSchema>;
export function parseBlueprint(doc: unknown): CcBlueprintDoc {
  return blueprintDocSchema.parse(doc);
}
```

- [ ] **Step 4: Run → pass.** `~/.local/bin/bunx tsc --noEmit` → exit 0.
- [ ] **Step 5: Commit** `git add src/lib/command/blueprint/schema.ts src/lib/command/__tests__/blueprint-schema.test.ts package.json && git commit -m "feat(v2): Google Search blueprint Zod schema"`

---

### Task 5: compile() — blueprint → ordered CompiledAction[]

**Files:**
- Create: `src/lib/command/blueprint/compile.ts`
- Test: `src/lib/command/__tests__/blueprint-compile.test.ts`

**Interfaces:**
- Consumes: `CcBlueprintDoc` (Task 4), `recKeyFor` pattern from `engine-import.ts` (or a local hash), payload types (Task 2).
- Produces: `compile(doc: CcBlueprintDoc, blueprintId: string): CompiledAction[]` where `CompiledAction = { seq: number; localRef: string; actionType: CcCreateActionType; entityKind: CcEntityKind; entityRef: string; payload: CcPayload; recKey: string }`. Ordering: budget(seq0) → campaign(1) → per ad group: ad_group → keywords(+negatives) → ads. `entityRef` for a create = its own `tmp:<localRef>` (the entity doesn't exist yet); parent refs inside payloads use `tmp:<parentLocalRef>`.

- [ ] **Step 1: Write the failing test** `src/lib/command/__tests__/blueprint-compile.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { compile, type CompiledAction } from "../blueprint/compile";
import { parseBlueprint } from "../blueprint/schema";

function doc() { /* paste validDoc() from blueprint-schema.test.ts */ return parseBlueprint({
  network:"google_ads", campaign:{ nodeId:"c1", tempId:"campaign:2", name:"Camp", channel:"SEARCH", status:"PAUSED",
    budget:{nodeId:"b1",tempId:"budget:1",dailyMicros:350_000_000}, bidding:{strategy:"MAXIMIZE_CONVERSIONS"},
    geo:{countryCodes:["MX"],presenceOnly:true},
    adGroups:[{nodeId:"g1",tempId:"ad_group:3",name:"AG",keywords:[{text:"kw",match:"PHRASE"}],negatives:[{text:"gratis",match:"PHRASE"}],
      ads:[{nodeId:"a1",tempId:"ad:4",finalUrl:"https://x.mx/a",headlines:[{text:"H1"},{text:"H2"},{text:"H3"}],descriptions:[{text:"D1"},{text:"D2"}]}]}] } }); }

describe("compile", () => {
  it("emits budget→campaign→ad_group→keywords→ad in seq order", () => {
    const a = compile(doc(), "bp-1");
    expect(a.map((x) => x.actionType)).toEqual(["create_budget","create_campaign","create_ad_group","create_keywords","create_ad"]);
    expect(a.map((x) => x.seq)).toEqual([0,1,2,3,4]);
  });
  it("threads tmp: parent refs", () => {
    const a = compile(doc(), "bp-1");
    const campaign = a.find((x) => x.actionType === "create_campaign")!;
    expect((campaign.payload as { budgetRef: string }).budgetRef).toBe("tmp:budget:1");
    const group = a.find((x) => x.actionType === "create_ad_group")!;
    expect((group.payload as { campaignRef: string }).campaignRef).toBe("tmp:campaign:2");
    const kws = a.find((x) => x.actionType === "create_keywords")!;
    expect((kws.payload as { adGroupRef: string }).adGroupRef).toBe("tmp:ad_group:3");
  });
  it("campaign create is PAUSED and carries geo + bidding", () => {
    const c = compile(doc(), "bp-1").find((x) => x.actionType === "create_campaign")!;
    const p = c.payload as { status: string };
    expect(p.status).toBe("PAUSED");
  });
  it("keywords action bundles keywords + negatives", () => {
    const k = compile(doc(), "bp-1").find((x) => x.actionType === "create_keywords")!;
    const p = k.payload as { keywords: Array<{ negative?: boolean }> };
    expect(p.keywords.some((x) => x.negative)).toBe(true);
    expect(p.keywords.some((x) => !x.negative)).toBe(true);
  });
  it("stable recKey per (blueprintId, seq)", () => {
    expect(compile(doc(), "bp-1")[0].recKey).toBe(compile(doc(), "bp-1")[0].recKey);
    expect(compile(doc(), "bp-1")[0].recKey).not.toBe(compile(doc(), "bp-2")[0].recKey);
  });
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Create `src/lib/command/blueprint/compile.ts`:**
```ts
import { createHash } from "crypto";
import type {
  CcBlueprintDoc,
} from "./schema";
import type {
  CcCreateActionType, CcEntityKind, CcPayload,
  CreateBudgetPayload, CreateCampaignPayload, CreateAdGroupPayload, CreateKeywordsPayload, CreateAdPayload,
} from "../types";

export interface CompiledAction {
  seq: number; localRef: string; actionType: CcCreateActionType;
  entityKind: CcEntityKind; entityRef: string; payload: CcPayload; recKey: string;
}

const tmp = (ref: string) => `tmp:${ref}`;
function recKey(blueprintId: string, seq: number): string {
  return "bp-" + createHash("sha256").update(`${blueprintId}|${seq}`).digest("hex").slice(0, 14);
}

export function compile(doc: CcBlueprintDoc, blueprintId: string): CompiledAction[] {
  const out: CompiledAction[] = [];
  let seq = 0;
  const c = doc.campaign;
  const push = (actionType: CcCreateActionType, entityKind: CcEntityKind, localRef: string, payload: CcPayload) => {
    out.push({ seq, localRef, actionType, entityKind, entityRef: tmp(localRef), payload, recKey: recKey(blueprintId, seq) });
    seq += 1;
  };

  push("create_budget", "campaign", c.budget.tempId,
    { name: `${c.name} — Presupuesto`, amountMicros: c.budget.dailyMicros } as CreateBudgetPayload);
  push("create_campaign", "campaign", c.tempId, {
    name: c.name, status: "PAUSED", channel: "SEARCH", budgetRef: tmp(c.budget.tempId),
    bidding: c.bidding, geoTargetIds: c.geo.countryCodes, presenceOnly: c.geo.presenceOnly,
  } as CreateCampaignPayload);
  for (const g of c.adGroups) {
    push("create_ad_group", "ad_group", g.tempId,
      { name: g.name, campaignRef: tmp(c.tempId), cpcBidMicros: g.cpcMicros } as CreateAdGroupPayload);
    push("create_keywords", "ad_group", `${g.tempId}:kw`, {
      adGroupRef: tmp(g.tempId),
      keywords: [
        ...g.keywords.map((k) => ({ text: k.text, match: k.match })),
        ...g.negatives.map((k) => ({ text: k.text, match: k.match, negative: true })),
      ],
    } as CreateKeywordsPayload);
    for (const adNode of g.ads) {
      push("create_ad", "ad", adNode.tempId, {
        adGroupRef: tmp(g.tempId), finalUrl: adNode.finalUrl,
        headlines: adNode.headlines, descriptions: adNode.descriptions,
        path1: adNode.path1, path2: adNode.path2,
      } as CreateAdPayload);
    }
  }
  return out;
}
```
Note: geo country codes are passed through as-is for slice 1 (resolving to Google geoTargetConstant IDs is the adapter's job in Task 8; if the adapter needs numeric IDs, it maps country code → constant there).

- [ ] **Step 4: Run → pass.** `~/.local/bin/bunx tsc --noEmit` → exit 0.
- [ ] **Step 5: Commit** `git add src/lib/command/blueprint/compile.ts src/lib/command/__tests__/blueprint-compile.test.ts && git commit -m "feat(v2): pure blueprint compiler → ordered create actions with tmp refs"`

---

### Task 6: Gate edits — remove_entity carve-out, create_budget caps, PAUSED_ON_CREATE

**Files:**
- Modify: `src/lib/command/gates.ts`
- Test: `src/lib/command/__tests__/gates.test.ts` (extend)

**Interfaces:**
- Consumes: v1 `GateInput`, `runGates`, `blockingFailures`.
- Produces: `remove_entity` allowed by ACTION_ALLOWED; `CURRENCY_SANITY`/`ABS_BUDGET_CAP` also read `create_budget.amountMicros`; new blocking `PAUSED_ON_CREATE` gate registered in `GATES`. No new module.

- [ ] **Step 1: Write failing tests** (append inside `describe("gates", ...)`):
```ts
  it("ACTION_ALLOWED permits remove_entity (internal rollback type)", () => {
    const rs = runGates(baseInput({ action: { actionType: "remove_entity", entityKind: "campaign", entityRef: "temp:campaign:2", payload: { resourceNames: ["rn1"] } } }));
    expect(rs.find(r => r.id === "ACTION_ALLOWED")?.status).toBe("pass");
  });
  it("CURRENCY_SANITY + ABS_BUDGET_CAP apply to create_budget too", () => {
    const settings = { ...CC_SETTINGS_DEFAULTS, maxDailyBudgetMicros: 50_000_000 };
    const over = runGates(baseInput({ settings, action: { actionType: "create_budget", entityKind: "campaign", entityRef: "temp:budget:1", payload: { name: "b", newDailyBudgetMicros: undefined, amountMicros: 60_000_000 } as never } }));
    expect(blockingFailures(over).map(r => r.id)).toContain("ABS_BUDGET_CAP");
    const bad = runGates(baseInput({ action: { actionType: "create_budget", entityKind: "campaign", entityRef: "temp:budget:1", payload: { name: "b", amountMicros: 900_000 } as never } }));
    expect(blockingFailures(bad).map(r => r.id)).toContain("CURRENCY_SANITY");
  });
  it("PAUSED_ON_CREATE blocks a create_campaign not PAUSED and passes when PAUSED", () => {
    const bad = runGates(baseInput({ action: { actionType: "create_campaign", entityKind: "campaign", entityRef: "temp:campaign:2", payload: { name: "c", status: "ENABLED" } as never } }));
    expect(blockingFailures(bad).map(r => r.id)).toContain("PAUSED_ON_CREATE");
    const ok = runGates(baseInput({ action: { actionType: "create_campaign", entityKind: "campaign", entityRef: "temp:campaign:2", payload: { name: "c", status: "PAUSED" } as never } }));
    expect(ok.find(r => r.id === "PAUSED_ON_CREATE")?.status).toBe("pass");
  });
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Edit `gates.ts`.**
  (a) In `actionAllowed`, the internal carve-out currently returns pass for `remove_negatives`. Extend it to a set:
```ts
const INTERNAL_ACTION_TYPES = new Set(["remove_negatives", "remove_entity"]);
// inside actionAllowed, replace the `=== "remove_negatives"` early-return with:
if (INTERNAL_ACTION_TYPES.has(i.action.actionType)) {
  return gate("ACTION_ALLOWED", "blocking", true, `${i.action.actionType} (rollback interno).`);
}
```
  (b) Make `budgetMicros(i)` read `create_budget` too — update the helper:
```ts
function budgetMicros(i: GateInput): number | null {
  const p = i.action.payload as { newDailyBudgetMicros?: unknown; amountMicros?: unknown };
  const v = i.action.actionType === "create_budget" ? p?.amountMicros : p?.newDailyBudgetMicros;
  return typeof v === "number" ? v : null;
}
```
  (c) Extend the `currencySanity` and `absBudgetCap` guards so they apply to `create_budget` as well as `budget_update` — change their leading `if (i.action.actionType !== "budget_update")` to:
```ts
  const isBudget = i.action.actionType === "budget_update" || i.action.actionType === "create_budget";
  if (!isBudget) return gate(<id>, "blocking", true, "No aplica.");
```
  (d) Add the new gate + register it (append to `GATES` after `metaLearningReset`):
```ts
const pausedOnCreate: Gate = (i) => {
  if (i.action.actionType !== "create_campaign") return gate("PAUSED_ON_CREATE", "blocking", true, "No aplica.");
  const status = (i.action.payload as { status?: string })?.status;
  return gate("PAUSED_ON_CREATE", "blocking", status === "PAUSED",
    status === "PAUSED" ? "Campaña se crea en pausa." : `Campaña de creación debe nacer PAUSED (status=${status ?? "ausente"}).`);
};
```
Add `pausedOnCreate` to the `GATES` array.

- [ ] **Step 4: Run → pass** (`~/.bun/bin/bun test src/lib/command`); `~/.local/bin/bunx tsc --noEmit` → exit 0.
- [ ] **Step 5: Commit** `git add src/lib/command/gates.ts src/lib/command/__tests__/gates.test.ts && git commit -m "feat(v2): gate edits — remove_entity carve-out, create_budget caps, PAUSED_ON_CREATE"`

---

### Task 7: Executor synthetic-before for create actions

**Files:**
- Modify: `src/lib/command/executor.ts`
- Test: `src/lib/command/__tests__/executor.test.ts` (extend)

**Interfaces:**
- Consumes: v1 `prepare()`, `ExecutorDeps`.
- Produces: create-family actions skip `adapter.snapshot()` and use a synthetic `before`; non-create actions carrying a `temp:` entityRef are rejected. Keyed on actionType, never on the `temp:` string.

- [ ] **Step 1: Write failing test** (append to executor.test.ts):
```ts
  it("create actions use a synthetic before (no snapshot call) and still gate", async () => {
    const deps = fakeDeps();
    deps.repo.getAction = async () => baseAction({ status: "approved", actionType: "create_budget", entityRef: "temp:budget:1", payload: { name: "b", amountMicros: 5_000_000 } }) as never;
    let snapCalled = false;
    deps.adapters = { for: () => fakeAdapter({ snapshot: async () => { snapCalled = true; throw new Error("should not snapshot a temp entity"); } }) };
    const out = await executeAction("a1", "op@x.com", ["w1"], deps);
    expect(snapCalled).toBe(false);
    expect(out.ok).toBe(true);
  });
```
(Ensure `fakeAdapter` capabilities include the create types + `validate` returns ok.)

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Edit `prepare()` in `executor.ts`** — add a create-family guard before the snapshot:
```ts
const CREATE_ACTION_TYPES = new Set(["create_budget","create_campaign","create_ad_group","create_keywords","create_ad"]);
// inside prepare(), replace the `const before = ...` block:
const isCreate = CREATE_ACTION_TYPES.has(input.actionType);
if (!isCreate && input.entityRef.startsWith("temp:")) {
  throw new Error(`Ref temporal en acción no-create: ${input.actionType} ${input.entityRef}`);
}
const before = isCreate
  ? ({ entityKind: input.entityKind, entityRef: input.entityRef, status: "UNKNOWN" } as EntitySnapshot)
  : capabilities.read
    ? await adapter.snapshot(auth, row.accountRef, input.entityKind, input.entityRef)
    : ({ entityKind: input.entityKind, entityRef: input.entityRef, status: "UNKNOWN" } as EntitySnapshot);
```
(Google `validate` still runs for creates — `buildMutation` needs no `before`.)

- [ ] **Step 4: Run → pass** (all executor tests green); `~/.local/bin/bunx tsc --noEmit` → exit 0.
- [ ] **Step 5: Commit** `git add src/lib/command/executor.ts src/lib/command/__tests__/executor.test.ts && git commit -m "feat(v2): executor synthetic-before for create actions; reject temp refs on non-create"`

---

### Task 8: Google adapter — create mutations + remove_entity + rollback

**Files:**
- Modify: `src/lib/command/networks/google.ts`
- Test: `src/lib/command/__tests__/google-adapter.test.ts` (extend)

**Interfaces:**
- Consumes: v1 `buildMutation`/`validate`/`execute`/`buildRollback`/`capabilities`.
- Produces: `buildMutation` handles `create_budget|create_campaign|create_ad_group|create_keywords|create_ad|remove_entity`; `validate()` handles them (CRITICAL — else create-rollback blocks); `buildRollback` returns `remove_entity{resourceNames}` for every create (never null); `capabilities().actionTypes` includes the create family + `remove_entity`.

**BEFORE writing code:** read `src/lib/agents/a6-activator.ts` — it already builds the exact Google mutate bodies for a Search campaign (campaignBudgets/campaigns/adGroups/adGroupCriteria/adGroupAds). MIRROR its request bodies precisely, including **camelCase field masks** (`amountMicros`, not `amount_micros` — the v1 field-mask bug) and the geo/language `campaignCriteria` handling. The parent refs in payloads are `tmp:...` placeholders at compile time but the RUNNER resolves them to real resourceNames BEFORE `execute()` is called, so `buildMutation` receives already-resolved refs.

- [ ] **Step 1: Write failing tests** (extend google-adapter.test.ts; mirror the existing fetch-mock pattern):
```ts
  it("capabilities include the create family + remove_entity", () => {
    const caps = googleAdapter.capabilities(AUTH);
    ["create_budget","create_campaign","create_ad_group","create_keywords","create_ad","remove_entity"].forEach(t =>
      expect(caps.actionTypes).toContain(t));
  });
  it("create_budget → campaignBudgets:mutate create with amountMicros string", async () => {
    responder = () => ({ results: [{ resourceName: "customers/123/campaignBudgets/9" }] });
    const exec = await googleAdapter.execute(AUTH, "123", { actionType: "create_budget", entityKind: "campaign", entityRef: "temp:budget:1", payload: { name: "B", amountMicros: 350_000_000 } }, synthBefore());
    const body = JSON.parse(String(calls.find(c => c.url.endsWith("campaignBudgets:mutate"))?.init?.body));
    expect(body.operations[0].create.amountMicros).toBe("350000000");
    expect(exec.resourceNames?.[0]).toBe("customers/123/campaignBudgets/9");
  });
  it("create_campaign create is PAUSED + SEARCH + references the resolved budget", async () => {
    responder = () => ({ results: [{ resourceName: "customers/123/campaigns/5" }] });
    await googleAdapter.execute(AUTH, "123", { actionType: "create_campaign", entityKind: "campaign", entityRef: "temp:campaign:2", payload: { name: "C", status: "PAUSED", channel: "SEARCH", budgetRef: "customers/123/campaignBudgets/9", bidding: { strategy: "MAXIMIZE_CONVERSIONS" }, geoTargetIds: ["MX"], presenceOnly: true } }, synthBefore());
    const body = JSON.parse(String(calls.find(c => c.url.endsWith("campaigns:mutate"))?.init?.body));
    expect(body.operations[0].create.status).toBe("PAUSED");
    expect(body.operations[0].create.advertisingChannelType).toBe("SEARCH");
    expect(body.operations[0].create.campaignBudget).toBe("customers/123/campaignBudgets/9");
  });
  it("validate() handles remove_entity (else create-rollback is permanently blocked)", async () => {
    responder = () => ({});
    const res = await googleAdapter.validate!(AUTH, "123", { actionType: "remove_entity", entityKind: "campaign", entityRef: "customers/123/campaigns/5", payload: { resourceNames: ["customers/123/campaigns/5"] } }, synthBefore());
    expect(res.ok).toBe(true);
  });
  it("buildRollback for a create returns remove_entity with the created resourceNames (never null)", () => {
    const r = googleAdapter.buildRollback(
      { actionType: "create_campaign", entityKind: "campaign", entityRef: "temp:campaign:2", payload: {} as never },
      synthBefore(), { operation: "campaigns:mutate", request: {}, response: {}, resourceNames: ["customers/123/campaigns/5"] });
    expect(r?.action.actionType).toBe("remove_entity");
    expect((r?.action.payload as { resourceNames: string[] }).resourceNames).toEqual(["customers/123/campaigns/5"]);
  });
```
Add a `synthBefore()` helper: `{ entityKind: "campaign", entityRef: "temp:x", status: "UNKNOWN" }`.

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Extend `google.ts`.** In `buildMutation`'s switch add the create cases (mirror a6-activator bodies; camelCase masks; `create_keywords` splits keywords vs negatives into `adGroupCriteria:mutate` create ops with `negative:true` for negatives; `create_ad` → `adGroupAds:mutate` with the RSA `responsiveSearchAd{headlines,descriptions}`; geo → resolve country code to `geoTargetConstants/<id>` via a small `COUNTRY_GEO` map or the `geoTargetConstant` REST — for slice 1 a static map of the countries in Cuentas (`MX,ES,US,AR,CO,CL,PE`) is fine). Add `remove_entity` → `<inferred service>:mutate` remove; since remove targets a resourceName whose service varies, route by the resourceName segment (`/campaigns/`→campaigns:mutate, `/campaignBudgets/`→…, `/adGroups/`→…, `/adGroupAds/`→…, `/campaignCriteria|adGroupCriteria/`→…). `validate()` already calls `buildMutation(...)+validateOnly` — since all create/remove now flow through `buildMutation`, validate handles them for free; **verify remove_entity does not throw in buildMutation** (that's the test above). `capabilities()` add the 6 types. `buildRollback`: add cases for each `create_*` returning `{ action: { actionType:"remove_entity", entityKind, entityRef, payload:{ resourceNames: exec.resourceNames ?? [] } }, note: "Eliminar recurso creado." }` — return null ONLY if `exec.resourceNames` is empty (and log-worthy), else always a recipe.

- [ ] **Step 4: Run → pass**; `~/.local/bin/bunx tsc --noEmit` → exit 0. Confirm the whole suite green.
- [ ] **Step 5: Commit** `git add src/lib/command/networks/google.ts src/lib/command/__tests__/google-adapter.test.ts && git commit -m "feat(v2): Google adapter create mutations + remove_entity + create rollback recipes"`

---

### Task 9: Plan runner — executeBlueprint + rollbackBlueprint

**Files:**
- Create: `src/lib/command/blueprint/plan-runner.ts`
- Modify: `src/lib/command/actions-repo.ts` (add `listActionsByBlueprint`, `updateActionResolved`)
- Test: `src/lib/command/__tests__/plan-runner.test.ts`

**Interfaces:**
- Consumes: v1 `executeAction`/`rollbackAction`, `ExecutorDeps`, `CompiledAction`, `countExecutedToday`, `transitionAction`.
- Produces: `executeBlueprint(blueprintId, actor, workspaceIds, deps, repo2): Promise<{ ok: boolean; failedSeq?: number }>` — sequential, pre-checks plan size vs remaining daily quota, skips executed, **substitutes only `tmp:` refs** (deep-equal-except-resolved) then persists, calls `executeAction`, stamps `result_ref`, stops on first failure; `rollbackBlueprint(...)` reverse-seq loop over `rollbackAction`. `resolvePayload(payload, refMap)` exported + unit-tested for the placeholders-only invariant.

- [ ] **Step 1: Write failing tests** `plan-runner.test.ts` — cover: (a) `resolvePayload` replaces `tmp:budget:1` with the real resourceName and changes NOTHING else (deep-equal on all non-ref fields); (b) `resolvePayload` throws if a non-`tmp:` value would change; (c) `executeBlueprint` happy path calls executeAction per seq in order and stamps result_ref; (d) stops on first failure and returns `failedSeq`; (e) pre-check refuses when plan size + executedToday > cap; (f) `rollbackBlueprint` calls rollbackAction in reverse seq. Use in-memory fakes (mirror executor.test.ts's fake deps + a fake repo2 with an in-memory action list).
```ts
import { describe, it, expect } from "bun:test";
import { resolvePayload } from "../blueprint/plan-runner";
describe("resolvePayload (placeholders-only invariant)", () => {
  it("substitutes tmp: refs and touches nothing else", () => {
    const out = resolvePayload({ budgetRef: "tmp:budget:1", name: "C", status: "PAUSED" }, { "budget:1": "customers/1/campaignBudgets/9" });
    expect(out).toEqual({ budgetRef: "customers/1/campaignBudgets/9", name: "C", status: "PAUSED" });
  });
  it("leaves non-tmp values byte-identical", () => {
    const p = { adGroupRef: "tmp:ad_group:3", keywords: [{ text: "kw", match: "PHRASE" }] };
    const out = resolvePayload(p, { "ad_group:3": "customers/1/adGroups/7" });
    expect(out.keywords).toEqual(p.keywords);
  });
  it("throws if a tmp ref is unresolved", () => {
    expect(() => resolvePayload({ budgetRef: "tmp:budget:1" }, {})).toThrow();
  });
});
```
(Add executeBlueprint/rollbackBlueprint sequencing tests with fakes.)

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** `resolvePayload(payload, refMap)`: deep-walk the payload; for any string value matching `^tmp:(.+)$`, replace with `refMap[localRef]` or throw if missing; all other values pass through unchanged (build a new object; assert structurally identical shape). `executeBlueprint`: load actions via `listActionsByBlueprint(blueprintId)` ordered by seq; pre-check `compiled.length + countExecutedToday(accountRef) <= settings.maxActionsPerAccountDay` else return `{ ok:false, failedSeq:-1, error:"plan excede el cupo diario" }`; build a `refMap` accumulating `localRef → result_ref`; for each action in seq: skip if `status==='executed'` (seed refMap from its result_ref); else `resolved = resolvePayload(action.payload, refMap)`, `updateActionResolved(action.id, resolved)` (under optimistic guard — only when status==='approved'), then `executeAction(action.id, actor, workspaceIds, deps)`; if `!outcome.ok` → set blueprint status failed, return `{ ok:false, failedSeq: action.seq }`; else `result = outcome.resourceNames?.[0]`, stamp `updateActionResolved(action.id, resolved, result)`, `refMap[action.localRef] = result`. On all done → blueprint executed. `rollbackBlueprint`: load executed actions, reverse seq, `rollbackAction(id, ...)` each.
- [ ] **Step 4: Add `listActionsByBlueprint(blueprintId)` + `updateActionResolved(id, payload, resultRef?)` to `actions-repo.ts`** (Drizzle: select where blueprintId order by seq; update payload/resultRef where id AND status='approved').
- [ ] **Step 5: Run → pass**; `~/.local/bin/bunx tsc --noEmit` → exit 0.
- [ ] **Step 6: Commit** `git add src/lib/command/blueprint/plan-runner.ts src/lib/command/actions-repo.ts src/lib/command/__tests__/plan-runner.test.ts && git commit -m "feat(v2): plan runner — placeholders-only resolution, sequential execute, reverse rollback"`

---

### Task 10: Blueprint repo + service (persist draft, compile→actions, bulk approve)

**Files:**
- Create: `src/lib/command/blueprint/repo.ts`
- Test: `src/lib/command/__tests__/blueprint-repo.test.ts` (light — mostly tsc + one bulk-approve unit with a fake)

**Interfaces:**
- Produces: `createBlueprint`, `getBlueprint(id, workspaceIds)`, `saveBlueprintDoc(id, doc, workspaceIds)`, `compileBlueprintToActions(blueprintId, deps)` (parseBlueprint→compile→insert cc_actions rows status 'proposed' with blueprint_id/seq/local_ref + source 'manual'/'copiloto'), `approveBlueprint(id, approver, workspaceIds)` (bulk transition its proposed actions → approved + blueprint status 'approved'). All workspace-scoped.

- [ ] **Step 1..N (TDD):** write a fake-backed test for `approveBlueprint` (all proposed actions → approved, approvedBy stamped) and `compileBlueprintToActions` (row count = compiled length, seq/local_ref set). Implement over `adsDb` + `ccBlueprints`/`ccActions`, reusing `createAction`. `compileBlueprintToActions` sets `source:'copiloto'` on any action whose blueprint node carries an AI-accepted field (read an `aiFields: string[]` list off the doc; for slice 1 the doc may carry `_ai?: string[]` node paths — if absent, all `source:'manual'`).
- [ ] Verify `~/.local/bin/bunx tsc --noEmit` exit 0; suite green. Commit `feat(v2): blueprint repo — draft persistence, compile-to-actions, bulk approve`.

---

### Task 11: API routes — blueprint CRUD, compile/review, approve, execute, rollback

**Files:**
- Create: `src/app/api/command/blueprint/route.ts` (POST create draft, GET list)
- Create: `src/app/api/command/blueprint/[id]/route.ts` (GET one w/ compiled preview, PUT save doc)
- Create: `src/app/api/command/blueprint/[id]/approve/route.ts` (POST → compileBlueprintToActions + approveBlueprint)
- Create: `src/app/api/command/blueprint/[id]/execute/route.ts` (POST → executeBlueprint via buildExecutorDeps)
- Create: `src/app/api/command/blueprint/[id]/rollback/route.ts` (POST → rollbackBlueprint)

**Interfaces:**
- Consumes: `getCommandAccess`, `buildExecutorDeps`, blueprint repo + runner, `parseBlueprint`, `compile`.
- Produces: the HTTP surface. Every route: `runtime="nodejs"`, `dynamic="force-dynamic"`, `getCommandAccess()` gate, `await params`, workspace-scoped. Execute route validates the blueprint is `approved`, runs `executeBlueprint`, returns `{ ok, failedSeq? }` (409 with blocked info if a gate blocks — the per-action executeAction returns blocked; surface it). PUT save re-`parseBlueprint`s and rejects invalid (400 with the Zod message). The `[id]` GET returns `{ blueprint, compiled: compile(parseBlueprint(doc), id) }` for the review screen (per-node grouping done client-side).

- [ ] **Steps:** mirror the v1 `/api/command/actions/[id]/*` route skeletons exactly (auth block, await params, try/catch → NextResponse). No unit tests (tsc + manual E2E). Verify `~/.local/bin/bunx tsc --noEmit` exit 0. Commit `feat(v2): /api/command/blueprint surface — draft, compile/review, approve, execute, rollback`.

---

### Task 12: AI per-field suggest route

**Files:**
- Create: `src/lib/command/blueprint/suggest.ts` (buildSuggestion(field, context) via callStructured)
- Create: `src/app/api/command/blueprint/suggest/route.ts`
- Test: `src/lib/command/__tests__/blueprint-suggest.test.ts` (schema-shape test with a mocked callStructured)

**Interfaces:**
- Consumes: `callStructured` from `@/lib/llm`, `RSA_SPEC`.
- Produces: `suggestField({ kind, context }): Promise<{ value: unknown; warnings: GateResult[] }>` where kind ∈ `group_name|keywords|headline|description`; each returns a value validated against the same RSA_SPEC-derived Zod so an AI headline obeys ≤30. Route: `getCommandAccess` gate; server-side re-validate the accepted value against the field schema (never trust the client).

- [ ] **Steps (TDD):** test that `suggestField({kind:'headline'})` returns a value ≤30 chars (mock callStructured to return a too-long string → the function truncates/rejects and re-asks or clamps to schema). Implement one forced structured call per field with a Spanish system prompt + the field's Zod as `schema`. Grounding: include relevant `knowledge.ts` hints in the prompt. Verify tsc + tests. Commit `feat(v2): per-field AI suggest (callStructured) grounded in RSA_SPEC/knowledge`.

---

### Task 13: UI — the guided builder (crear)

**Files:**
- Create: `src/app/command/crear/page.tsx` (server: getCommandAccess gate → render)
- Create: `src/app/command/crear/builder-client.tsx` (the workbench island)
- Modify: sidebar/palette to add "Constructor" under Centro de Mando (`src/components/app-sidebar.tsx` COMMAND_GROUP + `command-palette.tsx` COMMAND_DESTINATIONS)

**Interfaces:**
- Consumes: the blueprint API routes (Task 11), suggest route (Task 12).
- Produces: the create flow matching the approved mockup — left structure tree, center one-step-at-a-time (objetivo / presupuesto+puja / grupo+palabras clave / anuncio) with per-field ✨ buttons + live validators (RSA_SPEC counts), right live SERP ad preview + running summary + "EN PAUSA". "Guardar borrador" PUTs the doc; "Revisar y publicar" navigates to review.

**REFERENCE the approved mockup** at `/tmp/.../scratchpad/cc-v2-builder-mockup.html` for exact layout/copy/interaction (it's the design of record). Build in ui-kit primitives + the crear page pattern from Task-11-adjacent v1 pages. Client holds the blueprint doc in React state, debounced-saves via PUT, calls the suggest route for ✨.

- [ ] **Steps:** build the page (server gate) + client island; add nav entries (adapt to real `navGroups`/`DESTINATIONS` shapes). Verify `~/.local/bin/bunx tsc --noEmit` exit 0; `~/.bun/bin/bun test src/lib/command` still green. Commit `feat(v2): guided campaign builder UI (tree + steps + preview + per-field AI)`.

---

### Task 14: UI — review & publish (per-node action review)

**Files:**
- Create: `src/app/command/crear/[id]/revisar/page.tsx`
- Create: `src/app/command/crear/[id]/revisar/revisar-client.tsx`

**Interfaces:**
- Consumes: blueprint `[id]` GET (returns `{blueprint, compiled}`), approve + execute routes.
- Produces: the review screen — renders **every compiled action's full payload grouped by tree node** (the mandatory per-node review, spec §10/critique §4c), the gate/validateOnly summary, "Publicar en pausa" → approve then execute → redirect to Bitácora on success; a 409 blocked response renders the gate panel (reuse the Acciones gate-panel pattern).

- [ ] **Steps:** server page (gate + fetch compiled) + client (grouped payload render, publish handler). Verify tsc + build. Commit `feat(v2): review & publish screen — per-node action review, approve→execute`.

---

### Task 15: Verification + deploy note update

**Files:**
- Modify: `docs/superpowers/plans/DEPLOY-NOTES-command-center.md` (add v2 migration `008` + the create-flow rollout)

- [ ] **Step 1:** full suite `~/.bun/bin/bun test src/lib/command` → all green (report count).
- [ ] **Step 2:** `~/.local/bin/bunx tsc --noEmit` → exit 0.
- [ ] **Step 3:** production build `~/.bun/bin/bun run build` → exit 0; confirm `/command/crear` + `/api/command/blueprint/*` routes appear.
- [ ] **Step 4:** runtime smoke — start dev with `COMMAND_CENTER_BETA=true` + public Supabase envs on :4200; `curl` `/command/crear` (→ 404 non-admin gate) and `/api/command/blueprint` (→ 403). Confirms the gating chain runs without crashing.
- [ ] **Step 5:** append to DEPLOY-NOTES: run `/api/migrate` picks up `008`; the create flow needs a connected Google account with an ENABLED conversion action; created campaigns are PAUSED — operator enables via the existing Acciones/enable path after review in Google Ads UI.
- [ ] **Step 6:** Commit `docs(v2): deploy notes — 008 migration + create-flow rollout` and report the commit list `git log --oneline main..HEAD`.

---

## Plan self-review

- Spec coverage: §3 architecture→Tasks 5/9; §4 data model→Task 1; §5 actions/adapter→Tasks 2/8; §6 gates→Task 6; §7 executor→Task 7; §8 runner→Task 9; §9 AI→Task 12; §10 UI→Tasks 13/14; §11 testing→each task + Task 15; §2 invariants→Tasks 6/7/9 (PAUSED_ON_CREATE, synthetic-before, placeholders-only). §5#1 (validate handles remove_entity)→Task 8 explicit test.
- Types cross-checked: `CompiledAction`, `CcCreateActionType`, `resolvePayload`, `executeBlueprint`, `RSA_SPEC`, `parseBlueprint` consistent across tasks.
- Known adaptation points (read-the-real-file, not placeholders): Task 8 mirrors a6-activator mutate bodies (camelCase masks); Tasks 11/13/14 mirror v1 route/page/ui-kit patterns; Task 13/14 reference the approved mockup. Each names the exact file to read.
