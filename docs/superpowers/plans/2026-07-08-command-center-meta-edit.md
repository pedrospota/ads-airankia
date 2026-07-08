# Command Center — Meta Edit Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit live Meta campaigns (pause/enable at campaign+adset+ad, daily-budget change at whichever level owns it) on the untouched v1 rail, with a clear es-MX 409 (never mocked baselines) while credentials stay dormant.

**Architecture:** A new `meta_edit_v1` doc type rides the exact v2.3 edit architecture — server-read baseline (`readMetaCampaignTree` → pure `buildMetaEditDoc`), blast-bound merge on save (`mergeMetaEditDoc`), pure differ to `EditCompiledAction[]` (`diffMetaEditDoc`, phases pauses→budgets→enables), dispatched by docType literal at the four existing seams (edit route, repo compile, [id] GET/PUT, gate preview) always BEFORE the `network === "meta_ads"` create branch. The ONE execute-path adapter change is the per-entityKind snapshot fields fix (ad nodes have no `daily_budget` field); gates/executor/verify/rollback are already meta-aware and stay byte-identical.

**Tech Stack:** Next.js 15 App Router, TypeScript, bun test, zod 3, Drizzle (ads Postgres), Meta Graph API v25.0 (mocked creds).

**Spec:** `docs/superpowers/specs/2026-07-08-command-center-meta-edit-design.md` (the authority for every decision below — all file:line citations verified against main @ 32519f5).

## Global Constraints

- **Zero migrations:** `src/app/api/migrate/route.ts` + `src/lib/schema.ts` untouched — `budget_update|pause|enable` are already in every cc_settings default (008/009/010 lockstep + Drizzle default, pinned by test in Task 4).
- **UNTOUCHED (load-bearing):** `gates.ts` · `executor.ts` · `executor-deps.ts` · `types.ts` · `verify.ts` · `settings.ts` · `edit/schema.ts` (Task 1 imports its exported `EDIT_BASELINE_MAX_AGE_MS` only) · `edit/diff.ts` (Task 3 imports the exported `EditCompiledAction` type only) · `edit/read-tree.ts` · `blueprint/meta-schema.ts` + `meta-compile.ts` · `networks/google.ts` · `patch/*` + `copiloto/route.ts` · all `/command/editar/[id]/*` google pages · `/api/command/blueprint` POST (its docType rejection already forces all edit sessions through `/api/command/edit`).
- All user-facing copy in es-MX.
- Tests: `bun test` (all existing suites keep passing) + `bunx tsc --noEmit` clean, per task.
- Commits: explicit `git add <paths>` only — never `git add -A`.
- No `package.json` changes anywhere in this plan.
- Fail-closed everywhere: no token → 409 with the credential reason and NO blueprint row; unsupported statuses → throw (campaign) / filter (leaves); >1 `paging.next` → throw; budget-where-base-null → schema reject + differ re-throw; wrong docType → notFound/400.

---

### Task 1: `src/lib/command/edit/meta-schema.ts` — doc schema + TTL + blast-bound merge

**Files:**
- Create: `src/lib/command/edit/meta-schema.ts`
- Test: `src/lib/command/__tests__/meta-edit-schema.test.ts` (new)

**Interfaces:**
- Consumes: `MICROS_PER_MINOR_UNIT`, `MICROS_PER_UNIT` from `../types`; `EDIT_BASELINE_MAX_AGE_MS` from `./schema` (re-exported, never re-declared).
- Produces: `metaEditDocSchema`; `type MetaEditDoc = z.infer<typeof metaEditDocSchema>`; `type MetaEditAdset`, `type MetaEditAd` (element helpers); `parseMetaEditDoc(input: unknown): MetaEditDoc`; `mergeMetaEditDoc(stored: MetaEditDoc, incoming: unknown): MetaEditDoc`. Tasks 2-6 all consume these.

- [ ] **Step 1: Write the failing test**

Create `src/lib/command/__tests__/meta-edit-schema.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { EDIT_BASELINE_MAX_AGE_MS } from "../edit/schema";
import {
  parseMetaEditDoc, mergeMetaEditDoc,
  EDIT_BASELINE_MAX_AGE_MS as reExported,
  type MetaEditDoc,
} from "../edit/meta-schema";

// Canonical fixture: ABO campaign (campaign daily null, budget lives on the adset).
// Mirrors edit-schema.test.ts's baseDoc() convention — parse the raw shape so every
// fixture is schema-valid by construction.
function baseDoc(): MetaEditDoc {
  return parseMetaEditDoc({
    docType: "meta_edit_v1", network: "meta_ads", accountRef: "act_123",
    loadedAt: "2026-07-08T12:00:00.000Z",
    campaign: {
      id: "111",
      base: { name: "C", status: "ENABLED", effectiveStatus: "ACTIVE",
              dailyBudgetMicros: null, lifetimeBudgetMicros: null, currency: "MXN" },
      desired: { status: "ENABLED", dailyBudgetMicros: null },
      adsets: [{
        id: "222",
        base: { name: "AS", status: "ENABLED", effectiveStatus: "ACTIVE",
                dailyBudgetMicros: 20_000_000, lifetimeBudgetMicros: null, learningPhase: "STABLE" },
        desired: { status: "ENABLED", dailyBudgetMicros: 20_000_000 },
        ads: [
          { id: "333", base: { name: "Ad 1", status: "ENABLED", effectiveStatus: "ACTIVE" }, desired: { status: "ENABLED" } },
          { id: "334", base: { name: "Ad 2", status: "PAUSED", effectiveStatus: "PAUSED" }, desired: { status: "PAUSED" } },
        ],
      }],
    },
  });
}

// CBO variant: campaign owns the daily budget, the adset does not.
function cboDoc(): MetaEditDoc {
  const raw = baseDoc() as unknown as Record<string, unknown>;
  const d = structuredClone(raw) as unknown as MetaEditDoc;
  d.campaign.base.dailyBudgetMicros = 50_000_000;
  d.campaign.desired.dailyBudgetMicros = 50_000_000;
  d.campaign.adsets[0].base.dailyBudgetMicros = null;
  d.campaign.adsets[0].desired.dailyBudgetMicros = null;
  return parseMetaEditDoc(d);
}

describe("metaEditDocSchema", () => {
  it("parses a valid ABO doc and a valid CBO doc (round-trip)", () => {
    expect(baseDoc().campaign.id).toBe("111");
    expect(cboDoc().campaign.base.dailyBudgetMicros).toBe(50_000_000);
    expect(() => parseMetaEditDoc(baseDoc())).not.toThrow();
  });

  it("rejects a wrong docType (google edit docs must not enter the meta path)", () => {
    const d = { ...baseDoc(), docType: "google_search_edit_v1" };
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("rejects a desired budget where base is null — adset level (no introducing a budget Meta doesn't own)", () => {
    const d = cboDoc(); // adset base daily is null under CBO
    d.campaign.adsets[0].desired.dailyBudgetMicros = 10_000_000;
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("rejects a desired budget where base is null — campaign level", () => {
    const d = baseDoc(); // campaign base daily is null under ABO
    d.campaign.desired.dailyBudgetMicros = 10_000_000;
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("rejects a null desired budget where base is non-null (no clearing an owned budget)", () => {
    const d = baseDoc();
    d.campaign.adsets[0].desired.dailyBudgetMicros = null;
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("rejects a non-cent-aligned desired budget (micros % 10_000 !== 0)", () => {
    const d = baseDoc();
    d.campaign.adsets[0].desired.dailyBudgetMicros = 20_005_001;
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("rejects a sub-floor desired budget (< MICROS_PER_UNIT, the CURRENCY_SANITY floor)", () => {
    const d = baseDoc();
    d.campaign.adsets[0].desired.dailyBudgetMicros = 990_000;
    expect(() => parseMetaEditDoc(d)).toThrow();
  });

  it("accepts a lifetime-budget adset (daily null both sides — budget-locked, status still editable)", () => {
    const d = baseDoc();
    d.campaign.adsets[0].base.dailyBudgetMicros = null;
    d.campaign.adsets[0].base.lifetimeBudgetMicros = 900_000_000;
    d.campaign.adsets[0].desired.dailyBudgetMicros = null;
    expect(() => parseMetaEditDoc(d)).not.toThrow();
  });

  it("rejects a bad status enum and a bad learningPhase enum", () => {
    const d1 = baseDoc();
    // @ts-expect-error deliberately invalid for the enum-rejection assertion
    d1.campaign.desired.status = "ARCHIVED";
    expect(() => parseMetaEditDoc(d1)).toThrow();
    const d2 = baseDoc();
    // @ts-expect-error deliberately invalid for the enum-rejection assertion
    d2.campaign.adsets[0].base.learningPhase = "WARMING_UP";
    expect(() => parseMetaEditDoc(d2)).toThrow();
  });

  it("TTL const is the SAME value re-exported from edit/schema — never re-declared", () => {
    expect(reExported).toBe(EDIT_BASELINE_MAX_AGE_MS);
    expect(reExported).toBe(60 * 60_000);
  });
});

describe("mergeMetaEditDoc (server-owned baseline, blast-bound)", () => {
  it("lifts ONLY desired per row, matched by id", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.desired.status = "PAUSED";
    incoming.campaign.adsets[0].desired.dailyBudgetMicros = 24_000_000;
    incoming.campaign.adsets[0].ads[1].desired.status = "ENABLED";
    const out = mergeMetaEditDoc(stored, incoming);
    expect(out.campaign.desired.status).toBe("PAUSED");
    expect(out.campaign.adsets[0].desired.dailyBudgetMicros).toBe(24_000_000);
    expect(out.campaign.adsets[0].ads[1].desired.status).toBe("ENABLED");
  });

  it("spoofing matrix: base flips / id swaps / loadedAt+accountRef tamper are all preserved-from-stored", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.loadedAt = "2027-01-01T00:00:00.000Z";       // TTL tamper
    incoming.accountRef = "act_999";                       // tenant tamper
    incoming.campaign.base.name = "spoofed";               // baseline tamper
    incoming.campaign.base.status = "PAUSED";
    incoming.campaign.adsets[0].base.dailyBudgetMicros = 1_000_000; // fake baseline for a bigger delta
    incoming.campaign.adsets[0].base.learningPhase = "LEARNING";
    const out = mergeMetaEditDoc(stored, incoming);
    expect(out.loadedAt).toBe(stored.loadedAt);
    expect(out.accountRef).toBe("act_123");
    expect(out.campaign.base).toEqual(stored.campaign.base);
    expect(out.campaign.adsets[0].base).toEqual(stored.campaign.adsets[0].base);
  });

  it("unknown incoming adset/ad ids are structurally dropped (server never loaded them)", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.adsets.push({
      id: "666",
      base: { name: "inyectado", status: "ENABLED", effectiveStatus: "ACTIVE",
              dailyBudgetMicros: 10_000_000, lifetimeBudgetMicros: null, learningPhase: "UNKNOWN" },
      desired: { status: "PAUSED", dailyBudgetMicros: 10_000_000 },
      ads: [],
    });
    incoming.campaign.adsets[0].ads.push({
      id: "667", base: { name: "ad inyectado", status: "ENABLED", effectiveStatus: "ACTIVE" },
      desired: { status: "PAUSED" },
    });
    const out = mergeMetaEditDoc(stored, incoming);
    expect(out.campaign.adsets.map((a) => a.id)).toEqual(["222"]);
    expect(out.campaign.adsets[0].ads.map((a) => a.id)).toEqual(["333", "334"]);
  });

  it("stored rows missing from incoming are preserved as-is", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.adsets[0].ads = [incoming.campaign.adsets[0].ads[0]]; // client dropped ad 334
    const out = mergeMetaEditDoc(stored, incoming);
    expect(out.campaign.adsets[0].ads).toHaveLength(2);
    expect(out.campaign.adsets[0].ads[1]).toEqual(stored.campaign.adsets[0].ads[1]);
  });

  it("final re-parse fires the superRefine against SERVER truth: a lifted budget on a base-null node throws", () => {
    // Client claims the campaign owns a budget (fake base) and lifts a desired one.
    // Incoming parses fine (its own base/desired are coherent), but after the merge
    // rebuilds base from STORED (null), the base-null⇔desired-null refine must throw.
    const stored = baseDoc(); // campaign base daily null (ABO)
    const incoming = baseDoc();
    incoming.campaign.base.dailyBudgetMicros = 50_000_000; // spoofed baseline
    incoming.campaign.desired.dailyBudgetMicros = 80_000_000;
    expect(() => mergeMetaEditDoc(stored, incoming)).toThrow();
  });

  it("invalid incoming (wrong docType / malformed) throws before touching anything", () => {
    const stored = baseDoc();
    expect(() => mergeMetaEditDoc(stored, { docType: "meta_ads_v1" })).toThrow();
    expect(() => mergeMetaEditDoc(stored, null)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/command/__tests__/meta-edit-schema.test.ts`
Expected: FAIL — module `../edit/meta-schema` does not exist.

- [ ] **Step 3: Create `src/lib/command/edit/meta-schema.ts`**

```ts
// Command Center meta-edit — doc schema + blast-bound merge for editing a LIVE
// Meta campaign (docType "meta_edit_v1", sibling of google_search_edit_v1).
// Uniform base/desired at all 3 levels (campaign → adsets → ads); `desired` is
// the ONLY client-writable family — everything else is server-owned and
// rebuilt from the stored doc on every save (see mergeMetaEditDoc).
import { z } from "zod";
import { MICROS_PER_MINOR_UNIT, MICROS_PER_UNIT } from "../types";

// TTL: the SHARED baseline clock — repo.ts reads top-level `loadedAt` through
// one code path for both edit docTypes. Re-exported (never re-declared) so a
// future TTL change can't fork the two editors.
export { EDIT_BASELINE_MAX_AGE_MS } from "./schema";

// Mapped from Graph CONFIGURED `status` (ACTIVE→ENABLED) — the mutation writes
// configured status and snapshot() maps entity.status, so DRIFT compares
// like-for-like. effective_status (CAMPAIGN_PAUSED, WITH_ISSUES, …) rides
// along as a plain display-only string, NEVER diffed (spec §a adjudication).
export const metaEntityStatusSchema = z.enum(["ENABLED", "PAUSED"]);

// Display/warn only (mapLearning convention, networks/meta.ts).
const learningPhaseSchema = z.enum(["LEARNING", "STABLE", "LIMITED", "UNKNOWN"]);

// The ONLY client-writable budget shape. Floor mirrors gates.ts
// CURRENCY_SANITY (≥ 1 unit); multipleOf keeps every editor-authored budget
// cent-aligned, so the adapter's Math.round(micros / MICROS_PER_MINOR_UNIT)
// write (networks/meta.ts buildMetaMutation) is exact and metaBudgetRoundMicros
// is an identity — DRIFT/verify can never see rounding skew.
const desiredDailyBudget = z.number().int().min(MICROS_PER_UNIT).multipleOf(MICROS_PER_MINOR_UNIT).nullable();

// Server-owned raw budget baselines: whatever the live account reports,
// converted minor-units → micros by the read-tree mapper. No floor here — the
// floor constrains what the OPERATOR may propose, not what Meta already runs.
const baseBudget = z.number().int().nullable();

// Fail-closed, BOTH directions (spec §a): desired.dailyBudgetMicros must be
// null ⇔ base.dailyBudgetMicros is null. No introducing a budget where Meta
// doesn't own one at that level (CBO adsets, lifetime-budget nodes — the
// analog of edit/diff.ts's budgetShared throw), and no clearing one it owns.
function refineBudgetCoupling(label: string) {
  return (
    node: { base: { dailyBudgetMicros: number | null }; desired: { dailyBudgetMicros: number | null } },
    ctx: z.RefinementCtx
  ): void => {
    const baseNull = node.base.dailyBudgetMicros === null;
    const desiredNull = node.desired.dailyBudgetMicros === null;
    if (baseNull && !desiredNull) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["desired", "dailyBudgetMicros"],
        message: `No se puede introducir un presupuesto diario en ${label}: Meta no administra presupuesto diario en este nivel.`,
      });
    }
    if (!baseNull && desiredNull) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["desired", "dailyBudgetMicros"],
        message: `No se puede quitar el presupuesto diario de ${label} desde este editor.`,
      });
    }
  };
}

const metaAdSchema = z.object({
  id: z.string(), // numeric Graph node id — server-owned
  base: z.object({
    name: z.string(),
    status: metaEntityStatusSchema,
    effectiveStatus: z.string(), // display-only, never diffed
  }),
  desired: z.object({ status: metaEntityStatusSchema }),
});

const metaAdsetSchema = z
  .object({
    id: z.string(),
    base: z.object({
      name: z.string(),
      status: metaEntityStatusSchema,
      effectiveStatus: z.string(),
      dailyBudgetMicros: baseBudget, // non-null under ABO; null under CBO/lifetime
      lifetimeBudgetMicros: baseBudget, // display-only: non-null ⇒ budget-locked node
      learningPhase: learningPhaseSchema,
    }),
    desired: z.object({
      status: metaEntityStatusSchema,
      dailyBudgetMicros: desiredDailyBudget,
    }),
    ads: z.array(metaAdSchema),
  })
  .superRefine(refineBudgetCoupling("el conjunto de anuncios"));

export const metaEditDocSchema = z.object({
  docType: z.literal("meta_edit_v1"), // docType-first dispatch key at every seam
  network: z.literal("meta_ads"),
  accountRef: z.string(), // "act_<id>", server-owned, ∈ metaAccountRefs() at the edit route
  loadedAt: z.string().datetime(), // TOP-LEVEL — same slot as the google doc (shared TTL guard)
  campaign: z
    .object({
      id: z.string(),
      base: z.object({
        name: z.string(),
        status: metaEntityStatusSchema,
        effectiveStatus: z.string(),
        dailyBudgetMicros: baseBudget, // non-null ⇒ CBO campaign
        lifetimeBudgetMicros: baseBudget,
        currency: z.string().nullable(),
      }),
      desired: z.object({
        status: metaEntityStatusSchema,
        dailyBudgetMicros: desiredDailyBudget,
      }),
      adsets: z.array(metaAdsetSchema),
    })
    .superRefine(refineBudgetCoupling("la campaña")),
});

export type MetaEditDoc = z.infer<typeof metaEditDocSchema>;
export type MetaEditAdset = MetaEditDoc["campaign"]["adsets"][number];
export type MetaEditAd = MetaEditAdset["ads"][number];

export function parseMetaEditDoc(input: unknown): MetaEditDoc {
  return metaEditDocSchema.parse(input);
}

/**
 * Same two-layer pattern as mergeEditDoc (edit/schema.ts) but ~60 lines: only
 * ONE field family (`desired`) is lifted from the client. 4 steps:
 *  (1) parse incoming (throw → 400);
 *  (2) rebuild FROM stored — docType/network/accountRef/loadedAt/ids/base.* all server-owned;
 *  (3) lift only `desired` per row, matched by id, iterating STORED rows
 *      (unknown incoming ids structurally dropped; stored rows missing from
 *      incoming preserved as-is);
 *  (4) final parse so the base-null⇔desired-null superRefine fires against
 *      SERVER truth, not client-claimed base (the schema.ts:224-229 pattern).
 * Deliberately NOT a genericization of mergeEditDoc — google lifts 8 field
 * families, meta lifts 1; the shared thing is the pattern, not code.
 */
export function mergeMetaEditDoc(stored: MetaEditDoc, incoming: unknown): MetaEditDoc {
  const incomingDoc = metaEditDocSchema.parse(incoming); // (1)

  const result: MetaEditDoc = { // (2) + (3)
    docType: stored.docType,
    network: stored.network,
    accountRef: stored.accountRef,
    loadedAt: stored.loadedAt, // server-owned, TTL clock must not be movable
    campaign: {
      id: stored.campaign.id,
      base: stored.campaign.base, // server-owned baseline, cannot be modified
      desired: incomingDoc.campaign.desired, // client-owned
      adsets: stored.campaign.adsets.map((storedAdset) => {
        const incomingAdset = incomingDoc.campaign.adsets.find((a) => a.id === storedAdset.id);
        if (!incomingAdset) return storedAdset; // missing from incoming → preserved as-is
        return {
          id: storedAdset.id,
          base: storedAdset.base,
          desired: incomingAdset.desired, // client-owned
          ads: storedAdset.ads.map((storedAd) => {
            const incomingAd = incomingAdset.ads.find((a) => a.id === storedAd.id);
            if (!incomingAd) return storedAd;
            return { id: storedAd.id, base: storedAd.base, desired: incomingAd.desired };
          }),
        };
      }),
    },
  };

  // (4) Two-layer validation guard: incoming.parse (shape) + result.parse
  // (truth). A client that spoofs base to smuggle a budget onto a node the
  // server knows is base-null passes (1), but the refine re-fires here against
  // stored base → ZodError → 400 → doc never poisoned. The doc can never
  // mutate an entity the server didn't load.
  return metaEditDocSchema.parse(result);
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/lib/command/__tests__/meta-edit-schema.test.ts` → PASS (16 tests).
Run: `bun test && bunx tsc --noEmit` → all green (nothing existing imports the new module yet).

- [ ] **Step 5: Commit**

```bash
git add src/lib/command/edit/meta-schema.ts src/lib/command/__tests__/meta-edit-schema.test.ts
git commit -m "feat(meta-edit): meta_edit_v1 doc schema + blast-bound merge — base-null⇔desired-null fail-closed, cent-aligned budgets"
```

---

### Task 2: `networks/meta.ts` — per-kind snapshot fields + `readMetaCampaignTree`, plus pure `edit/meta-read-tree.ts`

**Files:**
- Modify: `src/lib/command/networks/meta.ts` (snapshot fields fix at :297-301; new `RawMetaCampaignTree` + `readMetaCampaignTree` export at the bottom, mirroring google.ts's `readCampaignTree` placement)
- Create: `src/lib/command/edit/meta-read-tree.ts`
- Test: `src/lib/command/__tests__/meta-adapter.test.ts` (extend — snapshot field assertions, risk #6), `src/lib/command/__tests__/meta-read-tree.test.ts` (new — fetch-mocked tree read + pure mapper)

**Interfaces:**
- Consumes: module-private `metaGet`/`metaGetUrl` (meta.ts — why the IO half lives there, same reason `readCampaignTree` lives in google.ts next to private `gaql`); `MetaEditDoc`/`parseMetaEditDoc` (Task 1); `MICROS_PER_MINOR_UNIT`.
- Produces: `export interface RawMetaCampaignTree { campaign: Record<string, unknown>; adsets: Array<Record<string, unknown>>; ads: Array<Record<string, unknown>>; currency: string | null }`; `export async function readMetaCampaignTree(_auth: AdapterAuth, accountRef: string, campaignId: string): Promise<RawMetaCampaignTree>`; pure `export function buildMetaEditDoc(tree: RawMetaCampaignTree, accountRef: string, nowIso: string): MetaEditDoc`. Task 4's edit route consumes both.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/command/__tests__/meta-adapter.test.ts`, inside `describe("metaAdapter", …)` (reuses the file's existing `calls`/`responder` fetch harness):

```ts
  // Risk #6 (spec adjudication #1): the ad node has NO daily_budget field on the
  // Graph API — requesting it → error #100 → prepare() throws BEFORE gates,
  // killing every ad-level pause/enable, its rollback input, and its verify read.
  it("snapshot('ad') requests id,name,status,effective_status ONLY (no budget, no learning fields)", async () => {
    responder = (url) => {
      if (url.includes("/insights")) return { data: [] };
      return { id: "999", name: "Ad X", status: "ACTIVE", effective_status: "ACTIVE" };
    };
    const snap = await metaAdapter.snapshot({}, "act_1", "ad", "999");
    const entityCall = calls.find((c) => c.url.includes("/999?"));
    const fields = new URL(entityCall!.url).searchParams.get("fields");
    expect(fields).toBe("id,name,status,effective_status");
    expect(snap.status).toBe("ENABLED");
    expect(snap.dailyBudgetMicros).toBeNull();
    expect(snap.learningPhase).toBe("UNKNOWN");
  });

  it("snapshot('adset') regression: still requests daily_budget + learning_stage_info and maps both", async () => {
    responder = (url) => {
      if (url.includes("/insights")) return { data: [] };
      return { id: "555", name: "Adset X", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000", learning_stage_info: { status: "LEARNING" } };
    };
    const snap = await metaAdapter.snapshot({}, "act_1", "adset", "555");
    const fields = new URL(calls.find((c) => c.url.includes("/555?"))!.url).searchParams.get("fields");
    expect(fields).toBe("id,name,status,effective_status,daily_budget,learning_stage_info");
    expect(snap.dailyBudgetMicros).toBe(20_000_000);
    expect(snap.learningPhase).toBe("LEARNING");
  });

  it("snapshot('campaign') regression: requests daily_budget (no learning_stage_info)", async () => {
    responder = (url) => {
      if (url.includes("/insights")) return { data: [] };
      return { id: "111", name: "Camp", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "5000" };
    };
    const snap = await metaAdapter.snapshot({}, "act_1", "campaign", "111");
    const fields = new URL(calls.find((c) => c.url.includes("/111?"))!.url).searchParams.get("fields");
    expect(fields).toBe("id,name,status,effective_status,daily_budget");
    expect(snap.dailyBudgetMicros).toBe(50_000_000);
  });
```

Create `src/lib/command/__tests__/meta-read-tree.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readMetaCampaignTree, type RawMetaCampaignTree } from "../networks/meta";
import { buildMetaEditDoc } from "../edit/meta-read-tree";
import { parseMetaEditDoc } from "../edit/meta-schema";

// Same fetch harness as meta-adapter.test.ts.
let calls: Array<{ url: string; init?: RequestInit }> = [];
let responder: (url: string) => unknown = () => ({});
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  process.env.META_SYSTEM_USER_TOKEN = "meta-token";
  process.env.META_AD_ACCOUNT_IDS = "act_123";
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

// Graph responses for a healthy ABO campaign under act_123.
function healthyResponder(url: string): unknown {
  if (url.includes("/111/adsets")) {
    return { data: [
      { id: "222", name: "AS", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000", learning_stage_info: { status: "SUCCESS" } },
      { id: "223", name: "AS archivado", status: "ARCHIVED", effective_status: "ARCHIVED" }, // leaf → FILTERED
    ] };
  }
  if (url.includes("/111/ads")) {
    return { data: [
      { id: "333", name: "Ad 1", status: "ACTIVE", effective_status: "ACTIVE", adset_id: "222" },
      { id: "334", name: "Ad 2", status: "PAUSED", effective_status: "CAMPAIGN_PAUSED", adset_id: "222" },
      { id: "335", name: "Ad borrado", status: "DELETED", effective_status: "DELETED", adset_id: "222" }, // leaf → FILTERED
    ] };
  }
  if (url.includes("/act_123?")) return { currency: "MXN" };
  if (url.includes("/111?")) {
    return { id: "111", name: "C", status: "ACTIVE", effective_status: "ACTIVE", account_id: "123" };
  }
  return {};
}

describe("readMetaCampaignTree", () => {
  it("4 GETs (campaign, adsets, ads, account currency); leaves with status ∉ {ACTIVE,PAUSED} filtered", async () => {
    responder = healthyResponder;
    const tree = await readMetaCampaignTree({}, "act_123", "111");
    expect(calls).toHaveLength(4);
    const campaignCall = new URL(calls[0].url);
    expect(campaignCall.pathname.endsWith("/111")).toBe(true);
    expect(campaignCall.searchParams.get("fields")).toBe("id,name,status,effective_status,daily_budget,lifetime_budget,account_id");
    expect(new URL(calls[1].url).searchParams.get("fields")).toBe("id,name,status,effective_status,daily_budget,lifetime_budget,learning_stage_info");
    expect(new URL(calls[2].url).searchParams.get("fields")).toBe("id,name,status,effective_status,adset_id");
    expect(new URL(calls[3].url).searchParams.get("fields")).toBe("currency");
    expect(tree.adsets.map((a) => a.id)).toEqual(["222"]);   // ARCHIVED adset filtered
    expect(tree.ads.map((a) => a.id)).toEqual(["333", "334"]); // DELETED ad filtered
    expect(tree.currency).toBe("MXN");
  });

  it("tenant bind: account_id ≠ accountRef digits → es-MX throw (risk #8)", async () => {
    responder = (url) => url.includes("/111?")
      ? { id: "111", name: "C", status: "ACTIVE", account_id: "999" }
      : healthyResponder(url);
    await expect(readMetaCampaignTree({}, "act_123", "111")).rejects.toThrow(/no pertenece a la cuenta/);
  });

  it("campaign ARCHIVED/DELETED → throw (mirrors requireEditableStatus; only the campaign throws)", async () => {
    responder = (url) => url.includes("/111?")
      ? { id: "111", name: "C", status: "ARCHIVED", account_id: "123" }
      : healthyResponder(url);
    await expect(readMetaCampaignTree({}, "act_123", "111")).rejects.toThrow(/archivada\/eliminada/);
  });

  it("pagination: follows paging.next AT MOST once; a remaining second next → throw, never a truncated tree (risk #10)", async () => {
    responder = (url) => {
      if (url.includes("page3marker")) return { data: [] }; // must never be fetched
      if (url.includes("page2marker")) {
        return {
          data: [{ id: "225", name: "AS-2", status: "ACTIVE", effective_status: "ACTIVE" }],
          paging: { next: "https://graph.facebook.com/v25.0/111/adsets?page3marker=1" },
        };
      }
      if (url.includes("/111/adsets")) {
        return {
          data: [{ id: "222", name: "AS", status: "ACTIVE", effective_status: "ACTIVE" }],
          paging: { next: "https://graph.facebook.com/v25.0/111/adsets?page2marker=1" },
        };
      }
      return healthyResponder(url);
    };
    await expect(readMetaCampaignTree({}, "act_123", "111")).rejects.toThrow(/demasiado grande/);
    expect(calls.some((c) => c.url.includes("page3marker"))).toBe(false);
  });

  it("pagination happy path: exactly one next follow merges the second page", async () => {
    responder = (url) => {
      if (url.includes("page2marker")) {
        return { data: [{ id: "225", name: "AS-2", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "3000" }] };
      }
      if (url.includes("/111/adsets")) {
        return {
          data: [{ id: "222", name: "AS", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000" }],
          paging: { next: "https://graph.facebook.com/v25.0/111/adsets?page2marker=1" },
        };
      }
      return healthyResponder(url);
    };
    const tree = await readMetaCampaignTree({}, "act_123", "111");
    expect(tree.adsets.map((a) => a.id)).toEqual(["222", "225"]);
  });
});

// ---------------------------------------------------------------------------
// buildMetaEditDoc — PURE mapper (no fetch involved from here down)
// ---------------------------------------------------------------------------

const ABO_TREE: RawMetaCampaignTree = {
  campaign: { id: "111", name: "C", status: "ACTIVE", effective_status: "ACTIVE", account_id: "123" },
  adsets: [{ id: "222", name: "AS", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000", learning_stage_info: { status: "SUCCESS" } }],
  ads: [
    { id: "333", name: "Ad 1", status: "ACTIVE", effective_status: "ACTIVE", adset_id: "222" },
    { id: "334", name: "Ad 2", status: "PAUSED", effective_status: "CAMPAIGN_PAUSED", adset_id: "222" },
  ],
  currency: "MXN",
};

const CBO_TREE: RawMetaCampaignTree = {
  campaign: { id: "111", name: "C", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "5000", account_id: "123" },
  adsets: [{ id: "222", name: "AS", status: "PAUSED", effective_status: "PAUSED", learning_stage_info: { status: "LEARNING" } }],
  ads: [],
  currency: "USD",
};

const NOW = "2026-07-08T12:00:00.000Z";

describe("buildMetaEditDoc", () => {
  it("ABO shape: campaign daily null, adset minor-units → micros; desired seeded = base; loadedAt = nowIso", () => {
    const doc = buildMetaEditDoc(ABO_TREE, "act_123", NOW);
    expect(doc.docType).toBe("meta_edit_v1");
    expect(doc.accountRef).toBe("act_123");
    expect(doc.loadedAt).toBe(NOW);
    expect(doc.campaign.base.dailyBudgetMicros).toBeNull();
    expect(doc.campaign.desired.dailyBudgetMicros).toBeNull();
    expect(doc.campaign.adsets[0].base.dailyBudgetMicros).toBe(20_000_000); // "2000" cents → micros
    expect(doc.campaign.adsets[0].desired).toEqual({ status: "ENABLED", dailyBudgetMicros: 20_000_000 });
    expect(doc.campaign.base.currency).toBe("MXN");
  });

  it("CBO shape: campaign daily non-null, adset null (budget-locked at adset level)", () => {
    const doc = buildMetaEditDoc(CBO_TREE, "act_123", NOW);
    expect(doc.campaign.base.dailyBudgetMicros).toBe(50_000_000);
    expect(doc.campaign.adsets[0].base.dailyBudgetMicros).toBeNull();
    expect(doc.campaign.adsets[0].desired.dailyBudgetMicros).toBeNull();
  });

  it("statuses map from CONFIGURED status; effective_status rides along display-only (risk #4)", () => {
    const doc = buildMetaEditDoc(ABO_TREE, "act_123", NOW);
    // Ad 334 is configured PAUSED with effective CAMPAIGN_PAUSED — base.status must
    // come from the configured value; the divergent effective string is preserved
    // verbatim for the UI badge and never influences status.
    expect(doc.campaign.adsets[0].ads[1].base.status).toBe("PAUSED");
    expect(doc.campaign.adsets[0].ads[1].base.effectiveStatus).toBe("CAMPAIGN_PAUSED");
    // Ad 333: ACTIVE → ENABLED.
    expect(doc.campaign.adsets[0].ads[0].base.status).toBe("ENABLED");
  });

  it("learningPhase maps via the mapLearning convention (SUCCESS→STABLE, LEARNING→LEARNING)", () => {
    expect(buildMetaEditDoc(ABO_TREE, "act_123", NOW).campaign.adsets[0].base.learningPhase).toBe("STABLE");
    expect(buildMetaEditDoc(CBO_TREE, "act_123", NOW).campaign.adsets[0].base.learningPhase).toBe("LEARNING");
  });

  it("ads group under their adset by adset_id", () => {
    const doc = buildMetaEditDoc(ABO_TREE, "act_123", NOW);
    expect(doc.campaign.adsets[0].ads.map((a) => a.id)).toEqual(["333", "334"]);
  });

  it("fail-closed: an unrecognized configured status throws with an es-MX message", () => {
    const bad: RawMetaCampaignTree = { ...ABO_TREE, adsets: [{ ...ABO_TREE.adsets[0], status: "IN_PROCESS" }] };
    expect(() => buildMetaEditDoc(bad, "act_123", NOW)).toThrow(/no soportado/);
  });

  it("output round-trips through parseMetaEditDoc (schema-valid by construction)", () => {
    expect(() => parseMetaEditDoc(buildMetaEditDoc(ABO_TREE, "act_123", NOW))).not.toThrow();
    expect(() => parseMetaEditDoc(buildMetaEditDoc(CBO_TREE, "act_123", NOW))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/command/__tests__/meta-adapter.test.ts src/lib/command/__tests__/meta-read-tree.test.ts`
Expected: FAIL — `snapshot('ad')` still requests `daily_budget`; `readMetaCampaignTree`/`buildMetaEditDoc` don't exist.

- [ ] **Step 3: Fix `snapshot` per-kind fields in `src/lib/command/networks/meta.ts`**

Replace the two-branch `fields` ternary at the top of `snapshot` (meta.ts:298-300):

```ts
    // Per-entityKind field sets (meta-edit spec adjudication #1): the Graph Ad
    // node has NO daily_budget field — requesting it errors (#100) and killed
    // every ad-level snapshot (prepare() throws before gates). Budget/learning
    // fields only where the node actually has them.
    const fields = entityKind === "adset"
      ? "id,name,status,effective_status,daily_budget,learning_stage_info"
      : entityKind === "ad"
        ? "id,name,status,effective_status"
        : "id,name,status,effective_status,daily_budget";
```

(The rest of `snapshot` is untouched — `entity.daily_budget` is simply absent for ads, so `dailyBudgetMicros` maps to `null` through the existing `!= null` check.)

- [ ] **Step 4: Add `RawMetaCampaignTree` + `readMetaCampaignTree` to `meta.ts`**

Append after the `metaAdapter` object (mirrors google.ts's readCampaignTree placement — the IO half lives beside its module-private HTTP helpers):

```ts
// Command Center meta-edit: raw Graph tree for a single campaign, consumed by
// the PURE mapper in edit/meta-read-tree.ts (buildMetaEditDoc). Kept here (not
// in meta-read-tree.ts) because metaGet/metaGetUrl are module-private —
// exactly why google.ts hosts readCampaignTree next to its private gaql().
export interface RawMetaCampaignTree {
  campaign: Record<string, unknown>;
  adsets: Array<Record<string, unknown>>;
  ads: Array<Record<string, unknown>>;
  currency: string | null;
}

// Configured statuses the edit surface models. Adset/ad rows outside this set
// are FILTERED (leaves — mirrors the GAQL REMOVED exclusion in
// google.ts#readCampaignTree); only the campaign itself throws.
const META_EDITABLE_STATUSES = new Set(["ACTIVE", "PAUSED"]);

// Follows paging.next AT MOST once (the listCampaignMetrics precedent above);
// a SECOND remaining next throws — fail-closed beats a silently truncated
// baseline whose un-loaded ads would drift invisibly.
async function metaGetPaged(path: string, params: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const first = await metaGet(path, params);
  const rows = [...((first.data as Array<Record<string, unknown>> | undefined) ?? [])];
  const nextUrl = (first.paging as { next?: string } | undefined)?.next;
  if (nextUrl) {
    const second = await metaGetUrl(nextUrl);
    rows.push(...((second.data as Array<Record<string, unknown>> | undefined) ?? []));
    if ((second.paging as { next?: string } | undefined)?.next) {
      throw new Error("Campaña demasiado grande para el editor.");
    }
  }
  return rows;
}

/**
 * The IO half of the meta edit-tree read (mirror of google.ts#readCampaignTree).
 * `_auth` is unused — Meta auth is the workspace env token (metaGet reads it) —
 * but the signature mirrors google's so the edit route treats both uniformly.
 * campaignId is client-supplied: the account_id tenant bind below is the meta
 * analog of the google route's connection-workspace check.
 */
export async function readMetaCampaignTree(_auth: AdapterAuth, accountRef: string, campaignId: string): Promise<RawMetaCampaignTree> {
  const campaign = await metaGet(`/${campaignId}`, {
    fields: "id,name,status,effective_status,daily_budget,lifetime_budget,account_id",
  });
  // Tenant bind: Graph returns account_id as bare digits; accountRef is "act_<id>".
  if (String(campaign.account_id ?? "") !== accountRef.replace(/^act_/, "")) {
    throw new Error("La campaña no pertenece a la cuenta seleccionada.");
  }
  const campaignStatus = String(campaign.status ?? "").toUpperCase();
  if (!META_EDITABLE_STATUSES.has(campaignStatus)) {
    throw new Error("Campaña archivada/eliminada: no editable.");
  }
  const adsets = await metaGetPaged(`/${campaignId}/adsets`, {
    fields: "id,name,status,effective_status,daily_budget,lifetime_budget,learning_stage_info",
    limit: "200",
  });
  const ads = await metaGetPaged(`/${campaignId}/ads`, {
    fields: "id,name,status,effective_status,adset_id",
    limit: "500",
  });
  // One field for base.currency (google-doc parity: edit/schema.ts's currency slot).
  const account = await metaGet(`/${accountRef}`, { fields: "currency" });
  const editable = (row: Record<string, unknown>) => META_EDITABLE_STATUSES.has(String(row.status ?? "").toUpperCase());
  return {
    campaign,
    adsets: adsets.filter(editable),
    ads: ads.filter(editable),
    currency: typeof account.currency === "string" ? account.currency : null,
  };
}
```

- [ ] **Step 5: Create `src/lib/command/edit/meta-read-tree.ts`**

```ts
// Command Center meta-edit — PURE mapper from raw Graph rows
// (RawMetaCampaignTree, read via networks/meta.ts#readMetaCampaignTree) to the
// edit document the operator reviews (MetaEditDoc). No I/O, no
// Date.now()/new Date() — nowIso is injected by the caller (same purity rule
// as edit/read-tree.ts). doc.campaign.base becomes the DRIFT baseline, so
// every field here must faithfully reflect the live account.
import type { RawMetaCampaignTree } from "../networks/meta";
import { MICROS_PER_MINOR_UNIT } from "../types";
import type { MetaEditDoc } from "./meta-schema";

type Row = Record<string, unknown>;
type Status = "ENABLED" | "PAUSED";
type Learning = "LEARNING" | "STABLE" | "LIMITED" | "UNKNOWN";

function str(value: unknown): string {
  return typeof value === "string" ? value : value != null ? String(value) : "";
}

/** Fail-closed: the edit surface only models ACTIVE/PAUSED configured statuses
 * (readMetaCampaignTree already filtered leaves; this is the mapper's own belt,
 * mirroring read-tree.ts's requireEditableStatus). */
function requireEditableStatus(status: unknown, label: string): Status {
  const s = String(status ?? "").toUpperCase();
  if (s === "ACTIVE") return "ENABLED";
  if (s === "PAUSED") return "PAUSED";
  throw new Error(`Estado de ${label} no soportado en este editor: ${String(status)}`);
}

/** Graph budgets come back as minor-unit strings ("2000" cents). minor × 10_000
 * = micros — the listCampaigns conversion (networks/meta.ts). Missing/unset →
 * null (CBO adsets, lifetime-budget nodes), never 0. */
function budgetMicros(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n * MICROS_PER_MINOR_UNIT : null;
}

/** The mapLearning convention (networks/meta.ts): LEARNING → LEARNING,
 * SUCCESS → STABLE, FAIL → LIMITED, anything else → UNKNOWN. Re-derived here
 * (8 lines) rather than exported from the adapter — display/warn only. */
function learningPhase(info: unknown): Learning {
  const s = String((info as Row | undefined)?.status ?? "").toUpperCase();
  if (s === "LEARNING") return "LEARNING";
  if (s === "SUCCESS") return "STABLE";
  if (s === "FAIL") return "LIMITED";
  return "UNKNOWN";
}

/**
 * PURE — desired mirrors base on load (the operator hasn't proposed anything
 * yet). nowIso stamps loadedAt, the shared TTL clock (EDIT_BASELINE_MAX_AGE_MS).
 */
export function buildMetaEditDoc(tree: RawMetaCampaignTree, accountRef: string, nowIso: string): MetaEditDoc {
  const c = tree.campaign;
  const campaignStatus = requireEditableStatus(c.status, "campaña");
  const campaignDaily = budgetMicros(c.daily_budget);

  const adsByAdset = new Map<string, Row[]>();
  for (const ad of tree.ads) {
    const key = str(ad.adset_id);
    const list = adsByAdset.get(key) ?? [];
    list.push(ad);
    adsByAdset.set(key, list);
  }

  return {
    docType: "meta_edit_v1",
    network: "meta_ads",
    accountRef,
    loadedAt: nowIso,
    campaign: {
      id: str(c.id),
      base: {
        name: str(c.name),
        status: campaignStatus,
        effectiveStatus: str(c.effective_status),
        dailyBudgetMicros: campaignDaily,
        lifetimeBudgetMicros: budgetMicros(c.lifetime_budget),
        currency: tree.currency,
      },
      desired: { status: campaignStatus, dailyBudgetMicros: campaignDaily },
      adsets: tree.adsets.map((row) => {
        const status = requireEditableStatus(row.status, "conjunto de anuncios");
        const daily = budgetMicros(row.daily_budget);
        return {
          id: str(row.id),
          base: {
            name: str(row.name),
            status,
            effectiveStatus: str(row.effective_status),
            dailyBudgetMicros: daily,
            lifetimeBudgetMicros: budgetMicros(row.lifetime_budget),
            learningPhase: learningPhase(row.learning_stage_info),
          },
          desired: { status, dailyBudgetMicros: daily },
          ads: (adsByAdset.get(str(row.id)) ?? []).map((ad) => {
            const adStatus = requireEditableStatus(ad.status, "anuncio");
            return {
              id: str(ad.id),
              base: { name: str(ad.name), status: adStatus, effectiveStatus: str(ad.effective_status) },
              desired: { status: adStatus },
            };
          }),
        };
      }),
    },
  };
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test src/lib/command/__tests__/meta-adapter.test.ts src/lib/command/__tests__/meta-read-tree.test.ts` → PASS.
Run: `bun test && bunx tsc --noEmit` → all green (the snapshot fix changes no existing assertion — the old adset/campaign field strings are preserved verbatim).

- [ ] **Step 7: Commit**

```bash
git add src/lib/command/networks/meta.ts src/lib/command/edit/meta-read-tree.ts src/lib/command/__tests__/meta-adapter.test.ts src/lib/command/__tests__/meta-read-tree.test.ts
git commit -m "feat(meta-edit): per-kind snapshot fields (ad-node fix) + readMetaCampaignTree + pure buildMetaEditDoc"
```

---

### Task 3: `src/lib/command/edit/meta-diff.ts` — pure differ

**Files:**
- Create: `src/lib/command/edit/meta-diff.ts`
- Test: `src/lib/command/__tests__/meta-edit-diff.test.ts` (new)

**Interfaces:**
- Consumes: `EditCompiledAction` TYPE from `./diff` (already exported at diff.ts:28 — `edit/diff.ts` itself stays untouched); `MetaEditDoc` (Task 1); `node:crypto`.
- Produces: `export function diffMetaEditDoc(doc: MetaEditDoc, blueprintId: string): EditCompiledAction[]`. Tasks 4-6 consume it. Pure: no Date, no random, no IO.

- [ ] **Step 1: Write the failing test**

Create `src/lib/command/__tests__/meta-edit-diff.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { parseMetaEditDoc, type MetaEditDoc } from "../edit/meta-schema";
import { diffMetaEditDoc } from "../edit/meta-diff";

// Fixture builder identical to meta-edit-schema.test.ts's baseDoc() (tests are
// self-contained, mirroring edit-diff.test.ts's convention). ABO: budget on the adset.
function baseDoc(): MetaEditDoc {
  return parseMetaEditDoc({
    docType: "meta_edit_v1", network: "meta_ads", accountRef: "act_123",
    loadedAt: "2026-07-08T12:00:00.000Z",
    campaign: {
      id: "111",
      base: { name: "C", status: "ENABLED", effectiveStatus: "ACTIVE",
              dailyBudgetMicros: null, lifetimeBudgetMicros: null, currency: "MXN" },
      desired: { status: "ENABLED", dailyBudgetMicros: null },
      adsets: [{
        id: "222",
        base: { name: "AS", status: "ENABLED", effectiveStatus: "ACTIVE",
                dailyBudgetMicros: 20_000_000, lifetimeBudgetMicros: null, learningPhase: "STABLE" },
        desired: { status: "ENABLED", dailyBudgetMicros: 20_000_000 },
        ads: [
          { id: "333", base: { name: "Ad 1", status: "ENABLED", effectiveStatus: "ACTIVE" }, desired: { status: "ENABLED" } },
          { id: "334", base: { name: "Ad 2", status: "PAUSED", effectiveStatus: "PAUSED" }, desired: { status: "PAUSED" } },
        ],
      }],
    },
  });
}
const mk = baseDoc;

describe("diffMetaEditDoc — mapping", () => {
  it("no changes → []", () => expect(diffMetaEditDoc(mk(), "bp1")).toHaveLength(0));

  it("adset budget change → budget_update on the bare node id, expected from BASE", () => {
    const d = mk(); d.campaign.adsets[0].desired.dailyBudgetMicros = 30_000_000;
    const [a] = diffMetaEditDoc(d, "bp1");
    expect(a.actionType).toBe("budget_update");
    expect(a.entityKind).toBe("adset");
    expect(a.entityRef).toBe("222");                                  // bare Graph node id
    expect(a.payload).toEqual({ newDailyBudgetMicros: 30_000_000 });
    expect(a.expected).toEqual({ dailyBudgetMicros: 20_000_000 });    // ONLY the mutated field, from base
    expect(a.localRef).toBeNull();
    expect(a.note).toBe("Presupuesto de «AS»: 20 → 30");              // es-MX antes → después
  });

  it("campaign pause → expected {status: ENABLED}; ad enable → expected {status: PAUSED}", () => {
    const d1 = mk(); d1.campaign.desired.status = "PAUSED";
    const [p] = diffMetaEditDoc(d1, "bp1");
    expect(p.actionType).toBe("pause");
    expect(p.entityKind).toBe("campaign");
    expect(p.entityRef).toBe("111");
    expect(p.expected).toEqual({ status: "ENABLED" });
    expect(p.note).toBe("Pausar campaña «C»");

    const d2 = mk(); d2.campaign.adsets[0].ads[1].desired.status = "ENABLED";
    const [e] = diffMetaEditDoc(d2, "bp1");
    expect(e.actionType).toBe("enable");
    expect(e.entityKind).toBe("ad");
    expect(e.entityRef).toBe("334");
    expect(e.expected).toEqual({ status: "PAUSED" });
    expect(e.note).toBe("Habilitar anuncio «Ad 2»");
  });

  it("no emission when base budget is null (CBO adset / lifetime-locked node)", () => {
    const d = mk();
    d.campaign.adsets[0].base.dailyBudgetMicros = null;      // lifetime-locked shape
    d.campaign.adsets[0].base.lifetimeBudgetMicros = 900_000_000;
    d.campaign.adsets[0].desired.dailyBudgetMicros = null;
    expect(diffMetaEditDoc(parseMetaEditDoc(d), "bp1")).toHaveLength(0);
  });
});

describe("diffMetaEditDoc — phase ordering (A pauses broadest-first, B budgets, E enables narrowest-first LAST)", () => {
  it("full scenario keeps the safety order", () => {
    // Two adsets: one gets paused + budget-changed; the other's paused ad gets
    // enabled and the campaign gets a CBO-style budget change (mixed shape is
    // schema-legal: the coupling is per-node).
    const d = mk();
    d.campaign.base.dailyBudgetMicros = 50_000_000;
    d.campaign.desired.dailyBudgetMicros = 60_000_000;                 // B (campaign)
    d.campaign.adsets.push(structuredClone(d.campaign.adsets[0]));
    d.campaign.adsets[1].id = "223";
    d.campaign.adsets[1].base.name = "AS2";
    d.campaign.adsets[1].ads = [];
    const doc = parseMetaEditDoc(d);
    doc.campaign.adsets[0].desired.status = "PAUSED";                  // A (adset)
    doc.campaign.adsets[0].ads[0].desired.status = "PAUSED";           // A (ad)
    doc.campaign.adsets[1].desired.dailyBudgetMicros = 24_000_000;     // B (adset)
    doc.campaign.adsets[0].ads[1].desired.status = "ENABLED";          // E (ad)
    const acts = diffMetaEditDoc(doc, "bp1");
    expect(acts.map((a) => `${a.actionType}:${a.entityKind}`)).toEqual([
      "pause:adset",          // A — adset before its ads (broadest-first)
      "pause:ad",
      "budget_update:campaign", // B — campaign then adsets
      "budget_update:adset",
      "enable:ad",            // E — narrowest-first, LAST
    ]);
    expect(acts.map((a) => a.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("pauses run campaign → adset; enables run adset → campaign", () => {
    const dP = mk();
    dP.campaign.desired.status = "PAUSED";
    dP.campaign.adsets[0].desired.status = "PAUSED";
    expect(diffMetaEditDoc(dP, "bp1").map((a) => a.entityKind)).toEqual(["campaign", "adset"]);

    const dE = mk();
    dE.campaign.base.status = "PAUSED";
    dE.campaign.adsets[0].base.status = "PAUSED";
    const doc = parseMetaEditDoc(dE);
    doc.campaign.desired.status = "ENABLED";
    doc.campaign.adsets[0].desired.status = "ENABLED";
    expect(diffMetaEditDoc(doc, "bp1").map((a) => a.entityKind)).toEqual(["adset", "campaign"]);
  });
});

describe("diffMetaEditDoc — determinism + fail-closed", () => {
  it("recKeys are deterministic, 'me-'-prefixed, never colliding with 'ed-'", () => {
    const d = mk(); d.campaign.adsets[0].desired.dailyBudgetMicros = 30_000_000;
    const [a1] = diffMetaEditDoc(d, "bp1");
    const [a2] = diffMetaEditDoc(d, "bp1");
    expect(a1.recKey).toBe(a2.recKey);
    expect(a1.recKey.startsWith("me-")).toBe(true);
    expect(a1.recKey).toHaveLength(3 + 14);
  });

  it("defense-in-depth throw: desired budget on a base-null node (hand-built doc bypassing the schema)", () => {
    const d = mk();
    d.campaign.desired.dailyBudgetMicros = 10_000_000; // base is null — schema would reject; differ re-asserts
    expect(() => diffMetaEditDoc(d, "bp1")).toThrow(/no administra presupuesto/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/command/__tests__/meta-edit-diff.test.ts`
Expected: FAIL — module `../edit/meta-diff` does not exist.

- [ ] **Step 3: Create `src/lib/command/edit/meta-diff.ts`**

```ts
// Command Center meta-edit — PURE differ: MetaEditDoc -> ordered
// EditCompiledAction[] for the execution rail. Sibling of edit/diff.ts
// (google), same row type (imported — diff.ts already exports it), own recKey
// prefix ("me-", never collides with "ed-").
//
// Ordering encodes the same safety property as the google differ: the enabled
// delivery surface never grows before its container is ready. Phases run
// A (pauses, broadest-first: campaign → adsets → ads) -> B (budget_update:
// campaign, then per-adset) -> E (enables, narrowest-first, LAST: ads →
// adsets → campaign). Combined with the runner's stop-on-first-failure, a
// failed run never leaves more enabled than before.
//
// Slice-1 emits NO creates: entityRef is always the bare numeric Graph node id
// at every level — exactly what buildMetaMutation POSTs to (`/${entityRef}`)
// and snapshot() GETs. localRef is always null.
//
// PURITY: no Date, no random, no IO. Deterministic output for identical input.
import { createHash } from "node:crypto";
import type { EditCompiledAction } from "./diff";
import type { MetaEditDoc } from "./meta-schema";

/** Private sibling of diff.ts's recKey — 8 lines beat exporting/parameterizing
 * the google helper (spec adjudication #3). */
function recKey(blueprintId: string, seq: number): string {
  return (
    "me-" +
    createHash("sha256")
      .update(`${blueprintId}|${seq}`)
      .digest("hex")
      .slice(0, 14)
  );
}

/** Format micros as a currency-unit string for es-MX antes → después notes
 * (fmtMicros convention, edit/diff.ts). */
function fmtMicros(micros: number): string {
  return String(micros / 1_000_000);
}

export function diffMetaEditDoc(doc: MetaEditDoc, blueprintId: string): EditCompiledAction[] {
  const c = doc.campaign;
  const out: EditCompiledAction[] = [];
  let seq = 0;

  const push = (row: Omit<EditCompiledAction, "seq" | "recKey">) => {
    out.push({ ...row, seq, recKey: recKey(blueprintId, seq) });
    seq += 1;
  };

  const pushStatus = (
    actionType: "pause" | "enable",
    entityKind: "campaign" | "adset" | "ad",
    entityRef: string,
    name: string,
    baseStatus: "ENABLED" | "PAUSED"
  ) => {
    const label = entityKind === "campaign" ? "campaña" : entityKind === "adset" ? "conjunto de anuncios" : "anuncio";
    push({
      localRef: null,
      actionType,
      entityKind,
      entityRef,
      payload: {},
      expected: { status: baseStatus },
      entityName: name,
      note: `${actionType === "pause" ? "Pausar" : "Habilitar"} ${label} «${name}»`,
    });
  };

  // --- Phase A: pauses, broadest-first (campaign → adsets → ads) ---
  if (c.desired.status === "PAUSED" && c.base.status === "ENABLED") {
    pushStatus("pause", "campaign", c.id, c.base.name, "ENABLED");
  }
  for (const as of c.adsets) {
    if (as.desired.status === "PAUSED" && as.base.status === "ENABLED") {
      pushStatus("pause", "adset", as.id, as.base.name, "ENABLED");
    }
  }
  for (const as of c.adsets) {
    for (const ad of as.ads) {
      if (ad.desired.status === "PAUSED" && ad.base.status === "ENABLED") {
        pushStatus("pause", "ad", ad.id, ad.base.name, "ENABLED");
      }
    }
  }

  // --- Phase B: budget_update — campaign (CBO) then per-adset (ABO) ---
  // Defense-in-depth (mirrors diff.ts's budgetShared throw): the schema
  // already forbids a desired budget on a base-null node; the differ
  // re-asserts so a doc that somehow bypassed parse can never emit a write
  // that introduces a budget where Meta doesn't own one.
  const emitBudget = (
    entityKind: "campaign" | "adset",
    entityRef: string,
    name: string,
    baseMicros: number | null,
    desiredMicros: number | null
  ) => {
    if (desiredMicros === null || desiredMicros === baseMicros) return; // no-op / budget-locked node
    if (baseMicros === null) {
      throw new Error(`«${name}» no administra presupuesto diario en este nivel; no se puede introducir uno desde el editor.`);
    }
    push({
      localRef: null,
      actionType: "budget_update",
      entityKind,
      entityRef,
      payload: { newDailyBudgetMicros: desiredMicros },
      expected: { dailyBudgetMicros: baseMicros },
      entityName: name,
      note: `Presupuesto de «${name}»: ${fmtMicros(baseMicros)} → ${fmtMicros(desiredMicros)}`,
    });
  };
  emitBudget("campaign", c.id, c.base.name, c.base.dailyBudgetMicros, c.desired.dailyBudgetMicros);
  for (const as of c.adsets) {
    emitBudget("adset", as.id, as.base.name, as.base.dailyBudgetMicros, as.desired.dailyBudgetMicros);
  }

  // --- Phase E: enables, narrowest-first, LAST (ads → adsets → campaign) ---
  for (const as of c.adsets) {
    for (const ad of as.ads) {
      if (ad.desired.status === "ENABLED" && ad.base.status === "PAUSED") {
        pushStatus("enable", "ad", ad.id, ad.base.name, "PAUSED");
      }
    }
  }
  for (const as of c.adsets) {
    if (as.desired.status === "ENABLED" && as.base.status === "PAUSED") {
      pushStatus("enable", "adset", as.id, as.base.name, "PAUSED");
    }
  }
  if (c.desired.status === "ENABLED" && c.base.status === "PAUSED") {
    pushStatus("enable", "campaign", c.id, c.base.name, "PAUSED");
  }

  // Final self-assert (kept even though this differ emits no creates — the
  // 4-line invariant is what makes "every ref is a live Graph node id" a
  // checked property instead of a comment; mirrors diff.ts's tmp: guard).
  for (const a of out) {
    if (a.entityRef.startsWith("tmp:")) {
      throw new Error(`Invariante rota: acción de edición Meta con ref tmp: (${a.actionType} ${a.entityRef})`);
    }
  }

  return out;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/lib/command/__tests__/meta-edit-diff.test.ts` → PASS (8 tests).
Run: `bun test && bunx tsc --noEmit` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/command/edit/meta-diff.ts src/lib/command/__tests__/meta-edit-diff.test.ts
git commit -m "feat(meta-edit): diffMetaEditDoc — pauses broadest-first, budgets, enables narrowest-first LAST; 'me-' recKeys"
```

---

### Task 4: Dispatch seams part 1 — `/api/command/edit` meta branch + `repo.ts` compile branch + zero-migration guard

**Files:**
- Modify: `src/app/api/command/edit/route.ts`
- Modify: `src/lib/command/blueprint/repo.ts`
- Test: `src/lib/command/__tests__/blueprint-repo.test.ts` (extend)

**Interfaces:**
- Consumes: `metaAccountRefs`, `readMetaCampaignTree` (Task 2), `buildMetaEditDoc` (Task 2), `parseMetaEditDoc` (Task 1), `diffMetaEditDoc` (Task 3), `adapterFor` (unchanged).
- Produces: `POST /api/command/edit` accepts `{network:"meta_ads", account_ref, campaign_id}` (NO connection_id) → `{id}` | 400/409; `compileBlueprintToActions` compiles `meta_edit_v1` docs through the differ with `connectionId: null`, `source: "manual"`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/command/__tests__/blueprint-repo.test.ts` (reuses the file's `makeHarness`/`baseBlueprint` helpers; add the imports `readFileSync` from `node:fs` and `join` from `node:path` at the top, plus `CC_SETTINGS_DEFAULTS` from `../types`):

```ts
// Meta-EDIT doc fixture (meta-edit plan Task 4): same shape as
// meta-edit-schema.test.ts's baseDoc(), with one adset budget bump + one ad
// pause so it diffs to exactly two rows. Raw `unknown` on purpose —
// compileBlueprintToActions itself must parse it.
function metaEditDocWithChanges(loadedAt = new Date().toISOString()) {
  return {
    docType: "meta_edit_v1", network: "meta_ads", accountRef: "act_123",
    loadedAt,
    campaign: {
      id: "111",
      base: { name: "C", status: "ENABLED", effectiveStatus: "ACTIVE",
              dailyBudgetMicros: null, lifetimeBudgetMicros: null, currency: "MXN" },
      desired: { status: "ENABLED", dailyBudgetMicros: null },
      adsets: [{
        id: "222",
        base: { name: "AS", status: "ENABLED", effectiveStatus: "ACTIVE",
                dailyBudgetMicros: 20_000_000, lifetimeBudgetMicros: null, learningPhase: "STABLE" },
        desired: { status: "ENABLED", dailyBudgetMicros: 24_000_000 },
        ads: [{ id: "333", base: { name: "Ad 1", status: "ENABLED", effectiveStatus: "ACTIVE" }, desired: { status: "PAUSED" } }],
      }],
    },
  };
}

function baseMetaEditBlueprint(over: Partial<CcBlueprintRow> = {}): CcBlueprintRow {
  return baseMetaBlueprint({ doc: metaEditDocWithChanges(), ...over });
}

describe("compileBlueprintToActions — meta-edit docType branch", () => {
  const WS = "w1";

  it("meta-edit doc compiles via diffMetaEditDoc: 'me-' recKeys, connectionId null, source manual, expected + rationale set", async () => {
    const { deps } = makeHarness([baseMetaEditBlueprint()]);
    const rows = await compileBlueprintToActions("bp1", [WS], deps);

    expect(rows.map((r) => r.actionType)).toEqual(["pause", "budget_update"]); // A before B
    expect(rows.every((r) => r.recKey?.startsWith("me-"))).toBe(true);
    expect(rows.every((r) => r.connectionId === null)).toBe(true);
    expect(rows.every((r) => r.source === "manual")).toBe(true);
    expect(rows.every((r) => r.status === "proposed")).toBe(true);
    const budget = rows.find((r) => r.actionType === "budget_update")!;
    expect(budget.entityRef).toBe("222");
    expect(budget.expected).toEqual({ dailyBudgetMicros: 20_000_000 });
    expect(budget.rationale).toContain("«AS»");
  });

  it("risk #1 regression: four-way dispatch is unchanged — google edit 'ed-', meta CREATE 'bp-', google create 'bp-'", async () => {
    const gEdit = makeHarness([baseBlueprint({ doc: editDocWithBudgetChange() })]);
    expect((await compileBlueprintToActions("bp1", [WS], gEdit.deps))[0].recKey?.startsWith("ed-")).toBe(true);

    const mCreate = makeHarness([baseMetaBlueprint()]);
    const mRows = await compileBlueprintToActions("bp1", [WS], mCreate.deps);
    expect(mRows.map((r) => r.actionType)).toEqual(["create_campaign", "create_adset", "create_ad"]);
    expect(mRows.every((r) => r.recKey?.startsWith("bp-"))).toBe(true);

    const gCreate = makeHarness([baseBlueprint()]);
    expect(await compileBlueprintToActions("bp1", [WS], gCreate.deps)).toHaveLength(5);
  });

  it("risk #9: stale meta-edit baseline (>60 min) refuses BEFORE deleting existing proposed actions", async () => {
    const staleLoadedAt = new Date(Date.now() - 61 * 60_000).toISOString();
    const existing = baseAction({ id: "a1", blueprintId: "bp1", status: "proposed" });
    const { deps, actionStore } = makeHarness(
      [baseMetaEditBlueprint({ doc: metaEditDocWithChanges(staleLoadedAt) })], [existing]
    );

    await expect(compileBlueprintToActions("bp1", [WS], deps)).rejects.toThrow(/caducado/);
    expect(actionStore.size).toBe(1); // the doomed recompile wiped nothing
  });

  it("meta-edit doc with zero diffs throws 'No hay cambios que aplicar.'", async () => {
    const doc = metaEditDocWithChanges();
    doc.campaign.adsets[0].desired.dailyBudgetMicros = 20_000_000; // back to base
    doc.campaign.adsets[0].ads[0].desired.status = "ENABLED";
    const { deps } = makeHarness([baseMetaEditBlueprint({ doc })]);
    await expect(compileBlueprintToActions("bp1", [WS], deps)).rejects.toThrow(/No hay cambios/);
  });
});

describe("zero-migration guard (meta-edit risk #11)", () => {
  // Meta edit ships with ZERO migrations because budget_update|pause|enable are
  // already in every cc_settings default. These assertions turn that assumption
  // into a tripwire: if a future migration/default change drops one of the three
  // verbs, meta edit silently bricks at ACTION_ALLOWED — fail here instead.
  const VERBS = ["budget_update", "pause", "enable"] as const;

  it("CC_SETTINGS_DEFAULTS (types.ts, mirrored by schema.ts's Drizzle default) allows the three meta-edit verbs", () => {
    for (const v of VERBS) expect(CC_SETTINGS_DEFAULTS.allowedActionTypes).toContain(v);
  });

  it("the migrate route's 007 CREATE TABLE default and 010 cumulative default both carry the three verbs", () => {
    const src = readFileSync(join(import.meta.dir, "../../../app/api/migrate/route.ts"), "utf8");
    const defaults = src.match(/\["budget_update","pause","enable"[^\]]*\]/g) ?? [];
    // 007 CREATE TABLE default, 008 UPDATE+DEFAULT, 009 DEFAULT, 010 UPDATE(partial)+DEFAULT.
    expect(defaults.length).toBeGreaterThanOrEqual(4);
    for (const d of defaults) for (const v of VERBS) expect(d).toContain(`"${v}"`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/command/__tests__/blueprint-repo.test.ts`
Expected: the meta-edit compile tests FAIL — a `meta_edit_v1` doc currently falls into the `network === "meta_ads"` branch and dies inside `parseMetaBlueprint` (exactly risk #1). The zero-migration guard tests pass already (they pin the status quo).

- [ ] **Step 3: Widen the edit predicate + add the meta-edit branch in `repo.ts`**

In `src/lib/command/blueprint/repo.ts`, extend the imports:

```ts
import { diffMetaEditDoc } from "../edit/meta-diff";
import { parseMetaEditDoc } from "../edit/meta-schema";
```

Replace the single line `const isEditDoc = rawDoc?.docType === "google_search_edit_v1";` (repo.ts:161) with:

```ts
  const isGoogleEditDoc = rawDoc?.docType === "google_search_edit_v1";
  // meta-edit: keyed on the exact literal, and it MUST be resolved before the
  // `network === "meta_ads"` branch below — a meta edit row satisfies that
  // network check and would otherwise die inside parseMetaBlueprint (risk #1).
  const isMetaEditDoc = rawDoc?.docType === "meta_edit_v1";
  const isEditDoc = isGoogleEditDoc || isMetaEditDoc;
```

The TTL guard block right below (`if (isEditDoc) { … "Baseline caducado…" }`) is SHARED and stays byte-identical — it reads top-level `loadedAt`, which both docTypes carry in the same slot, and it already runs BEFORE the delete-first block (the risk #9 ordering invariant).

Then change the google edit block's guard from `if (isEditDoc)` to `if (isGoogleEditDoc)` (its body untouched), and insert the meta-edit block immediately after it — structurally before the `blueprint.network === "meta_ads"` create branch:

```ts
  // META-EDIT BRANCH: docType-first dispatch, sibling of the google edit block
  // above. Rows mirror the google edit branch field-by-field, but
  // `connectionId` is always null (Meta auth is the workspace env token, never
  // a per-blueprint OAuth connection) and `source` is always "manual" — the
  // `_ai` copiloto marker is a google convention; meta docs never carry it
  // (the meta editor never mounts CopilotoDock, spec adjudication #4).
  if (isMetaEditDoc) {
    const doc = parseMetaEditDoc(blueprint.doc);
    const compiled = diffMetaEditDoc(doc, blueprintId);
    if (compiled.length === 0) throw new Error("No hay cambios que aplicar.");

    const rows = compiled.map((a) => ({
      workspaceId: blueprint.workspaceId, createdBy: blueprint.createdBy, network: blueprint.network,
      connectionId: null, accountRef: blueprint.accountRef,
      entityKind: a.entityKind, entityRef: a.entityRef, entityName: a.entityName,
      actionType: a.actionType, payload: a.payload as never, expected: a.expected as never,
      source: "manual" as const,
      recKey: a.recKey, rationale: a.note,
      status: "proposed" as const, blueprintId, seq: a.seq, localRef: a.localRef,
    }));
    return deps.insertActions(rows);
  }
```

- [ ] **Step 4: Run the repo tests**

Run: `bun test src/lib/command/__tests__/blueprint-repo.test.ts` → PASS (all new + all pre-existing, including the untouched meta-create and google-edit suites).

- [ ] **Step 5: Add the meta branch to `src/app/api/command/edit/route.ts`**

Extend the imports:

```ts
import { metaAccountRefs, readMetaCampaignTree } from "@/lib/command/networks/meta";
import { buildMetaEditDoc } from "@/lib/command/edit/meta-read-tree";
```

Replace the `network` parse line (:41) and the missing-fields guard (:46-50) with:

```ts
  const network =
    body.network === "google_ads" ? ("google_ads" as const)
    : body.network === "meta_ads" ? ("meta_ads" as const)
    : null;
```

```ts
  // Meta needs no connection_id (auth is the workspace env token). The
  // connection_id requirement moves to a google-only guard placed right AFTER
  // the meta branch (below) — same error string, so the google contract is
  // unchanged AND TS keeps narrowing connectionId to string for the google code.
  if (!network || !accountRef || !campaignId) {
    return NextResponse.json(
      { error: "Faltan campos: network, connection_id, account_ref, campaign_id" }, { status: 400 }
    );
  }
```

Then, AFTER the shared `CAMPAIGN_ID_RE` check (:55-57) and the `workspaceId` check (:59-62), and BEFORE the google connection tenant-check block (:64-70), insert the self-contained meta branch followed by the relocated google connection guard (the google code below it stays byte-identical):

```ts
  // ── META-EDIT BRANCH ──────────────────────────────────────────────────────
  // No connection row exists for Meta; the tenant boundary is the env
  // allow-list (the meta analog of the google connection-workspace check
  // below) plus readMetaCampaignTree's own account_id bind on the campaign.
  if (network === "meta_ads") {
    if (!metaAccountRefs().includes(accountRef)) {
      return NextResponse.json({ error: "Cuenta Meta no permitida (META_AD_ACCOUNT_IDS)." }, { status: 400 });
    }
    try {
      const adapter = adapterFor("meta_ads");
      // No-token honesty (spec adjudication #5): an edit doc IS its baseline —
      // without read access there is nothing true to draft. Surface the
      // capabilities reason (es-MX credential message), create NO blueprint row.
      const capabilities = adapter.capabilities({});
      if (!capabilities.read) {
        return NextResponse.json({ error: capabilities.reason ?? "Sin acceso de lectura" }, { status: 409 });
      }

      let tree;
      try {
        tree = await readMetaCampaignTree({}, accountRef, campaignId);
      } catch (e) {
        // Known domain throws (tenant bind / archived / too-large) — es-MX
        // message as a 409, the same convention as the google branch below.
        return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 409 });
      }

      const doc = buildMetaEditDoc(tree, accountRef, new Date().toISOString());
      const bp = await createBlueprint({
        workspaceId, createdBy: access.email, network: "meta_ads",
        accountRef, connectionId: null, doc: doc as never, status: "draft",
      });
      return NextResponse.json({ id: bp.id });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
    }
  }
  // ── end meta branch ───────────────────────────────────────────────────────

  // Google-only: connection_id is required (relocated from the shared guard so
  // the meta branch above doesn't need it; same message → same google contract).
  if (!connectionId) {
    return NextResponse.json(
      { error: "Faltan campos: network, connection_id, account_ref, campaign_id" }, { status: 400 }
    );
  }
  // ── google path continues unchanged below ─────────────────────────────────
```

Also update the route's header comment to mention both docTypes (one sentence: "v-meta-edit: the meta_ads branch drafts docType 'meta_edit_v1' from readMetaCampaignTree, no connection_id, 409 with the credential reason when the token is absent.").

Route-level behavior that cannot be unit-tested here (no route-handler test idiom in this repo — the v3.0 Task 5 precedent) is pinned as a reviewer checklist instead (risk #8):
- [ ] POST `{network:"meta_ads", account_ref:"act_123", campaign_id:"111"}` without `META_SYSTEM_USER_TOKEN` → 409, body contains "META_SYSTEM_USER_TOKEN no configurado", and NO cc_blueprints row was inserted (the 409 returns before `createBlueprint`).
- [ ] `account_ref` ∉ `metaAccountRefs()` → 400 "Cuenta Meta no permitida (META_AD_ACCOUNT_IDS)."
- [ ] Cross-account campaign (Graph `account_id` ≠ ref digits) → 409 "La campaña no pertenece a la cuenta seleccionada." (the throw itself is unit-tested in Task 2).
- [ ] `campaign_id` non-numeric → 400 (shared `CAMPAIGN_ID_RE`, unchanged).
- [ ] Google POST body without `connection_id` still 400s with the original message.

- [ ] **Step 6: Run tests + typecheck + commit**

Run: `bun test && bunx tsc --noEmit` → all green.

```bash
git add src/app/api/command/edit/route.ts src/lib/command/blueprint/repo.ts src/lib/command/__tests__/blueprint-repo.test.ts
git commit -m "feat(meta-edit): edit route meta branch (no-token 409, allow-list 400) + repo compile dispatch + zero-migration tripwire"
```

---

### Task 5: Dispatch seams part 2 — `[id]` GET/PUT meta-edit branches + gate preview

**Files:**
- Modify: `src/app/api/command/blueprint/[id]/route.ts`
- Modify: `src/lib/command/blueprint/preview.ts`
- Test: `src/lib/command/__tests__/blueprint-preview.test.ts` (extend)

**Interfaces:**
- Consumes: `mergeMetaEditDoc`/`parseMetaEditDoc` (Task 1), `diffMetaEditDoc` (Task 3).
- Produces: GET `/api/command/blueprint/[id]` returns `{blueprint, compiled: EditCompiledAction[]}` for meta-edit docs; PUT merges via `mergeMetaEditDoc` (no `attachProvenance`); `previewBlueprintGates` runs the deterministic gates on meta-edit docs with `network: "meta_ads"`, synthetic `before` seeded from `action.expected`, and the new `SYNTHETIC_CAPABILITIES_META_EDIT` constant. Task 6's pages consume all three.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/command/__tests__/blueprint-preview.test.ts` (reuses `makeDeps`/`baseMetaBlueprint`; the meta-edit fixture is parameterized on the desired adset budget so tests drive compliant vs over-delta scenarios):

```ts
// Meta-EDIT doc fixture (meta-edit plan Task 5) — ABO adset with base 20.00,
// desired parameterized; plus one ad pause so status verbs are exercised too.
function metaEditDocFixture(desiredAdsetBudgetMicros: number) {
  return {
    docType: "meta_edit_v1", network: "meta_ads", accountRef: "act_123",
    loadedAt: "2026-07-08T12:00:00.000Z",
    campaign: {
      id: "111",
      base: { name: "C", status: "ENABLED", effectiveStatus: "ACTIVE",
              dailyBudgetMicros: null, lifetimeBudgetMicros: null, currency: "MXN" },
      desired: { status: "ENABLED", dailyBudgetMicros: null },
      adsets: [{
        id: "222",
        base: { name: "AS", status: "ENABLED", effectiveStatus: "ACTIVE",
                dailyBudgetMicros: 20_000_000, lifetimeBudgetMicros: null, learningPhase: "STABLE" },
        desired: { status: "ENABLED", dailyBudgetMicros: desiredAdsetBudgetMicros },
        ads: [{ id: "333", base: { name: "Ad 1", status: "ENABLED", effectiveStatus: "ACTIVE" }, desired: { status: "PAUSED" } }],
      }],
    },
  };
}

function baseMetaEditBlueprint(over: Partial<CcBlueprintRow> = {}): CcBlueprintRow {
  return baseMetaBlueprint({ doc: metaEditDocFixture(22_000_000), ...over });
}

describe("previewBlueprintGates — meta-edit docType branch", () => {
  it("compiles via the differ; every action's gates carry network meta_ads and pass under the DEFAULT allow-list (zero migrations)", async () => {
    // NOTE: settings deliberately NOT overridden — CC_SETTINGS_DEFAULTS already
    // allows budget_update|pause|enable (the zero-migration property).
    const deps = makeDeps({ blueprint: baseMetaEditBlueprint() });
    const preview = await previewBlueprintGates("bp1", ["w1"], { ...deps, settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS }) } });

    expect(preview.perAction.map((a) => a.actionType)).toEqual(["pause", "budget_update"]);
    expect(preview.summary.blockingCount).toBe(0);
    // META_LEARNING_RESET only exists as a non-"No aplica" result when the gate
    // ran with network meta_ads AND saw a real prior budget — both properties at once.
    const budgetGates = preview.perAction[1].gates;
    const mlr = budgetGates.find((g) => g.id === "META_LEARNING_RESET")!;
    expect(mlr.status).toBe("pass");
    expect(mlr.evidence).toContain("10.0%"); // 20.00 → 22.00 = 10% — computed FROM expected
  });

  it("synthetic before is seeded from action.expected: BUDGET_DELTA blocks a >30% jump (needs the prior budget)", async () => {
    const deps = makeDeps({ blueprint: baseMetaEditBlueprint({ doc: metaEditDocFixture(30_000_000) }) }); // +50%
    const preview = await previewBlueprintGates("bp1", ["w1"], { ...deps, settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS }) } });

    const budget = preview.perAction.find((a) => a.actionType === "budget_update")!;
    expect(budget.blocking.map((g) => g.id)).toContain("BUDGET_DELTA");
    // Had before been the create branches' bare UNKNOWN, BUDGET_DELTA would fail
    // with "Sin presupuesto base medible" — assert the delta evidence instead.
    expect(budget.blocking.find((g) => g.id === "BUDGET_DELTA")!.evidence).toContain("50.0%");
  });

  it("CAPABILITY: SYNTHETIC_CAPABILITIES_META_EDIT grants exactly budget_update|pause|enable (a create verb would block)", async () => {
    const deps = makeDeps({ blueprint: baseMetaEditBlueprint() });
    const preview = await previewBlueprintGates("bp1", ["w1"], { ...deps, settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS }) } });
    for (const a of preview.perAction) {
      expect(a.gates.find((g) => g.id === "CAPABILITY")!.status).toBe("pass");
      // Meta non-create verbs never require a rehearsal — VALIDATE_ONLY passes
      // ("No aplica"), unlike every google preview row.
      expect(a.gates.find((g) => g.id === "VALIDATE_ONLY")!.status).toBe("pass");
    }
  });

  it("risk #1 regression: a meta CREATE blueprint still previews through compileMeta with SYNTHETIC_CAPABILITIES_META", async () => {
    const deps = makeDeps({
      blueprint: baseMetaBlueprint(),
      settings: { allowedActionTypes: ALLOWED_WITH_ADSET },
    });
    const preview = await previewBlueprintGates("bp1", ["w1"], deps);
    expect(preview.perAction.map((a) => a.actionType)).toEqual(["create_campaign", "create_adset", "create_ad"]);
    expect(preview.summary.blockingCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/command/__tests__/blueprint-preview.test.ts`
Expected: the meta-edit tests FAIL — the doc currently falls into the meta CREATE branch and dies inside `parseMetaBlueprint` (risk #1 again, preview seam).

- [ ] **Step 3: Add the meta-edit branch to `preview.ts`**

Extend imports:

```ts
import { diffMetaEditDoc } from "../edit/meta-diff";
import { parseMetaEditDoc } from "../edit/meta-schema";
```

Add the constant next to `SYNTHETIC_CAPABILITIES_META`:

```ts
/** META-EDIT BRANCH: a DISTINCT constant (same rationale as the two above) —
 * the edit surface is exactly the v1 verb triple; sharing/widening a list
 * would let an edit doc pass CAPABILITY for create verbs it can never run,
 * and vice versa. */
const SYNTHETIC_CAPABILITIES_META_EDIT: AdapterCapabilities = {
  read: true,
  write: true,
  actionTypes: ["budget_update", "pause", "enable"],
};
```

Insert the branch immediately after the google edit-doc branch's closing `}` (i.e. before the `blueprint.network === "meta_ads"` check at :167 — dispatch order is the whole point):

```ts
  // META-EDIT BRANCH: docType-first, BEFORE the meta network branch below (a
  // meta-edit row satisfies `network === "meta_ads"` and would 500 inside
  // parseMetaBlueprint). Synthetic before is seeded from action.expected (the
  // google-edit pattern above, NOT the create branches' bare UNKNOWN) —
  // BUDGET_DELTA and META_LEARNING_RESET need the prior budget to say anything
  // true. Self-contained, same shape as its three siblings.
  if (rawDoc?.docType === "meta_edit_v1") {
    const compiled = diffMetaEditDoc(parseMetaEditDoc(blueprint.doc), blueprintId);

    const settings = await deps.settings.get(blueprint.workspaceId);
    const executedTodayForAccount = await deps.repo.countExecutedToday(blueprint.accountRef);

    const perAction: GatePreviewAction[] = compiled.map((action) => {
      const before: EntitySnapshot = {
        entityKind: action.entityKind, entityRef: action.entityRef, status: "UNKNOWN",
        ...(action.expected ?? {}),
      };
      const input: GateInput = {
        settings,
        network: "meta_ads",
        action: { actionType: action.actionType, entityKind: action.entityKind, entityRef: action.entityRef, payload: action.payload },
        capabilities: SYNTHETIC_CAPABILITIES_META_EDIT,
        before,
        expected: null,
        executedTodayForAccount,
        validateResult: null,
      };
      const gates = runGates(input);
      const blocking = blockingFailures(gates).filter((g) => g.id !== "VALIDATE_ONLY");
      return { seq: action.seq, actionType: action.actionType, entityKind: action.entityKind, gates, blocking };
    });

    const summary = {
      actions: perAction.length,
      gatesRun: perAction.reduce((sum, a) => sum + a.gates.length, 0),
      blockingCount: perAction.reduce((sum, a) => sum + a.blocking.length, 0),
    };

    return { perAction, summary, validateOnlyDeferred: true };
  }
```

Run: `bun test src/lib/command/__tests__/blueprint-preview.test.ts` → PASS.

- [ ] **Step 4: Add the GET + PUT meta-edit branches to `[id]/route.ts`**

Extend imports:

```ts
import { diffMetaEditDoc } from "@/lib/command/edit/meta-diff";
import { mergeMetaEditDoc, parseMetaEditDoc } from "@/lib/command/edit/meta-schema";
```

Add the sibling predicate under `isEditDoc`:

```ts
/** Meta edit docs are keyed by this literal docType — checked BEFORE every
 * `network === "meta_ads"` branch in this file (a meta-edit row satisfies the
 * network check and would otherwise hit parseMetaBlueprint / the smuggle guard). */
function isMetaEditDoc(doc: unknown): boolean {
  return (doc as { docType?: unknown } | null)?.docType === "meta_edit_v1";
}
```

GET — extend the compile chain (only the middle arm is new):

```ts
    const compiled = isEditDoc(blueprint.doc)
      ? diffEditDoc(parseEditDoc(blueprint.doc), id)
      : isMetaEditDoc(blueprint.doc)
        ? diffMetaEditDoc(parseMetaEditDoc(blueprint.doc), id)
        : blueprint.network === "meta_ads"
          ? compileMeta(parseMetaBlueprint(blueprint.doc), id)
          : compile(parseBlueprint(blueprint.doc), id);
```

PUT — insert between the google edit-doc branch's closing `}` and the `blueprint.network === "meta_ads"` create branch (:103). CRITICAL ordering (risk #2): the create branch's docType-smuggle guard (:107-109) would otherwise 400 every legitimate meta-edit save, whose body rightfully carries `docType: "meta_edit_v1"` — while that guard must KEEP protecting meta CREATE docs:

```ts
  // META-EDIT BRANCH: stored docType wins the dispatch, BEFORE the meta CREATE
  // branch below (see isMetaEditDoc's comment — risk #2). Applied through
  // mergeMetaEditDoc: client-owned `desired` merged onto the server-owned
  // baseline/ids, final re-parse against server truth. NO attachProvenance —
  // the meta editor never mounts CopilotoDock (spec adjudication #4), so a
  // `_prov`/`_ai` sibling has nothing legitimate to say here.
  if (isMetaEditDoc(blueprint.doc)) {
    let merged;
    try {
      merged = mergeMetaEditDoc(parseMetaEditDoc(blueprint.doc), body.doc);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "doc de edición Meta inválido" }, { status: 400 });
    }

    if (blueprint.status !== "draft") {
      return NextResponse.json({ error: `No se puede editar desde estado ${blueprint.status}` }, { status: 409 });
    }

    try {
      const updated = await saveBlueprintDoc(id, merged, access.workspaceIds);
      if (!updated) {
        return NextResponse.json({ error: "El blueprint ya no está en borrador." }, { status: 409 });
      }
      return NextResponse.json({ blueprint: updated });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
    }
  }
```

The PUT smuggle-collision matrix (risk #2) — the merge/dispatch halves are unit-pinned (Task 1's merge tests + this task's preview/repo dispatch tests); the route wiring itself follows the repo's reviewer-checklist idiom:
- [ ] PUT on a meta-EDIT blueprint with a body carrying `docType:"meta_edit_v1"` → 200, saved via merge (never reaches the create branch's smuggle guard).
- [ ] PUT on a meta-EDIT blueprint with a google/create-shaped body (wrong/missing docType) → 400 from `mergeMetaEditDoc`'s parse (Task 1 pins the throw).
- [ ] PUT on a meta-CREATE blueprint with a smuggled `docType` (any value, including `"meta_edit_v1"`) → still 400 "doc inválido: docType no permitido en un blueprint de Meta" (guard untouched; a create row's stored doc has no docType, so `isMetaEditDoc(blueprint.doc)` is false and dispatch falls through to the guard).
- [ ] GET on a meta-edit blueprint → `compiled` rows with `"me-"` recKeys (differ output — unit-pinned in Task 3).

- [ ] **Step 5: Run tests + typecheck + commit**

Run: `bun test && bunx tsc --noEmit` → all green (blueprint-preview + blueprint-repo suites cover all four dispatch arms).

```bash
git add src/app/api/command/blueprint/[id]/route.ts src/lib/command/blueprint/preview.ts src/lib/command/__tests__/blueprint-preview.test.ts
git commit -m "feat(meta-edit): [id] GET/PUT meta-edit branches before the create/smuggle seam + gate preview with expected-seeded before"
```

---

### Task 6: UI — `/command/editar-meta/[id]` workbench + revisar + cuentas entry point

**Files:**
- Create: `src/app/command/editar-meta/[id]/page.tsx`
- Create: `src/app/command/editar-meta/[id]/meta-editor-client.tsx`
- Create: `src/app/command/editar-meta/[id]/revisar/page.tsx`
- Create: `src/app/command/editar-meta/[id]/revisar/meta-revisar-client.tsx`
- Modify: `src/app/command/cuentas/cuentas-client.tsx` (`startEdit` network branch + Editar button gating)
- Test: none (no client-component test idiom in this repo — `bunx tsc --noEmit` + `bun run build` + the manual checklist below pin this task; all doc/differ/gate behavior the UI rides on is already unit-pinned in Tasks 1-5)

**Interfaces:**
- Consumes: `parseMetaEditDoc`/`MetaEditDoc`/`EDIT_BASELINE_MAX_AGE_MS` (Task 1), `diffMetaEditDoc` (Task 3), `previewBlueprintGates` (Task 5), `getBlueprint`, `buildExecutorDeps`, ui-kit components, the network-agnostic `/api/command/blueprint/[id]` PUT + `/approve` + `/execute` + `/rollback` endpoints (all unchanged).
- Produces: the two operator-facing pages. Mutual exclusion is a SECURITY property: this page `notFound()`s any non-`meta_edit_v1` doc, exactly as `editar/[id]/page.tsx:26` does for google (spec adjudication #2) — the 5 google editor files stay untouched.

- [ ] **Step 1: Create `src/app/command/editar-meta/[id]/page.tsx`**

Mirror of `editar/[id]/page.tsx` minus the Copiloto `_prov` plumbing (the meta editor never mounts CopilotoDock — spec adjudication #4):

```tsx
import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/header";
import { UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { getBlueprint } from "@/lib/command/blueprint/repo";
import { parseMetaEditDoc } from "@/lib/command/edit/meta-schema";
import MetaEditorClient from "./meta-editor-client";

// Auth + DB reads (blueprint) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Meta edit docs are keyed by this literal docType — the mutual-exclusion
 * mirror of editar/[id]/page.tsx's google guard (a load-bearing fail-closed
 * check: each editor only ever renders its own doc family). */
function isMetaEditDoc(doc: unknown): boolean {
  return (doc as { docType?: unknown } | null)?.docType === "meta_edit_v1";
}

export default async function EditarCampanaMetaPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  const { id } = await params;

  const blueprint = await getBlueprint(id, access.workspaceIds);
  if (!blueprint || !isMetaEditDoc(blueprint.doc)) notFound();

  let doc;
  try {
    doc = parseMetaEditDoc(blueprint.doc);
  } catch {
    notFound();
  }

  return (
    <div>
      <Header
        breadcrumbs={[
          { label: "Centro de Mando", href: "/command" },
          { label: "Cuentas", href: "/command/cuentas" },
          { label: "Editar campaña Meta" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <MetaEditorClient
          key={blueprint.id}
          blueprintId={blueprint.id}
          doc={doc}
          status={blueprint.status}
          accountRef={blueprint.accountRef}
        />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Create `src/app/command/editar-meta/[id]/meta-editor-client.tsx`**

Complete component. Layout is a single column (campaign card → adset cards → footer) — simpler than the google 3-column grid because slice-1 has no keyword/ad-copy panels. Styling values (paddings, font sizes, `UI.*` tokens) copy the idioms named inline; every state var, handler, fetch call and es-MX string below is normative:

```tsx
"use client";

// The Editar-Meta workbench: campaign card + adset rows + ad status toggles.
// Holds the MetaEditDoc in React state, debounced-autosaves it (PUT, whole doc
// — the server merges via mergeMetaEditDoc so client edits to base/ids are
// silently ignored), and navigates to the review screen. Never touches the
// live account — publishing happens on the revisar screen. Mirrors
// editar/[id]/editor-client.tsx minus Copiloto (never mounted here) and minus
// the SERP/keyword panels (no creative surface in slice-1).

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, ErrorCard, PageHeader, PrimaryButton, SecondaryButton, SectionLabel, UI } from "@/components/ui-kit";
import type { MetaEditDoc } from "@/lib/command/edit/meta-schema";
import { MICROS_PER_MINOR_UNIT, MICROS_PER_UNIT } from "@/lib/command/types";

const AUTOSAVE_DELAY_MS = 1200; // same cadence as editar/[id]/editor-client.tsx

interface SaveResponse { blueprint?: { id: string }; error?: string }
interface EditResponse { id?: string; error?: string }

type MetaAdset = MetaEditDoc["campaign"]["adsets"][number];

/** Pure diff counter (sibling of editor-types.ts's countEdits): one unit per
 * status flip / budget change across all 3 levels. Drives the footer button. */
function countMetaEdits(doc: MetaEditDoc): number {
  const c = doc.campaign;
  let n = 0;
  if (c.desired.status !== c.base.status) n += 1;
  if (c.desired.dailyBudgetMicros !== c.base.dailyBudgetMicros) n += 1;
  for (const as of c.adsets) {
    if (as.desired.status !== as.base.status) n += 1;
    if (as.desired.dailyBudgetMicros !== as.base.dailyBudgetMicros) n += 1;
    for (const ad of as.ads) if (ad.desired.status !== ad.base.status) n += 1;
  }
  return n;
}

/** Copy of editar/[id]/editor-panels.tsx's StatusToggle (lines 151-186) —
 * identical segmented Activa/Pausada control + "En vivo: …" hint. Duplicated
 * (not imported) so the google editor files stay untouched. */
function StatusToggle({ value, base, onChange }: {
  value: "ENABLED" | "PAUSED";
  base: "ENABLED" | "PAUSED";
  onChange: (s: "ENABLED" | "PAUSED") => void;
}) {
  const segStyle = (active: boolean): CSSProperties => ({
    border: `1px solid ${active ? UI.accent : UI.borderStrong}`,
    background: active ? UI.accentSoft : "none",
    color: active ? UI.text : UI.muted,
    borderRadius: UI.radiusSm,
    padding: "8px 16px",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" style={segStyle(value === "ENABLED")} onClick={() => onChange("ENABLED")}>
          Activa
        </button>
        <button type="button" style={segStyle(value === "PAUSED")} onClick={() => onChange("PAUSED")}>
          Pausada
        </button>
      </div>
      <span style={{ fontSize: 11.5, color: UI.faint }}>
        En vivo: <b style={{ color: UI.muted }}>{base === "ENABLED" ? "activa" : "pausada"}</b>
      </span>
    </div>
  );
}

/** "en aprendizaje" badge from base.learningPhase — display/warn only; the
 * LEARNING_PHASE gate is the enforcement (execute-time snapshot). */
function LearningBadge({ phase }: { phase: MetaAdset["base"]["learningPhase"] }) {
  if (phase === "LEARNING") return <Badge tone="warn">en aprendizaje</Badge>;
  if (phase === "LIMITED") return <Badge tone="danger">aprendizaje limitado</Badge>;
  return null;
}

/** Budget input, rendered ONLY where base.dailyBudgetMicros is non-null.
 * Local text state, committed on blur/Enter, CENT-QUANTIZED:
 * Math.round(units × 100) cents × MICROS_PER_MINOR_UNIT — so every value the
 * doc ever holds is exactly what the schema's multipleOf accepts and what the
 * adapter writes without rounding. Sub-floor input reverts with an inline hint. */
function BudgetInput({ valueMicros, baseMicros, currency, onCommit }: {
  valueMicros: number;
  baseMicros: number;
  currency: string | null;
  onCommit: (micros: number) => void;
}) {
  const [text, setText] = useState((valueMicros / 1_000_000).toFixed(2));
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => { setText((valueMicros / 1_000_000).toFixed(2)); }, [valueMicros]);

  function commit() {
    const units = Number(text.replace(",", "."));
    if (!Number.isFinite(units)) {
      setText((valueMicros / 1_000_000).toFixed(2));
      setHint(null);
      return;
    }
    const micros = Math.round(units * 100) * MICROS_PER_MINOR_UNIT;
    if (micros < MICROS_PER_UNIT) {
      setText((valueMicros / 1_000_000).toFixed(2));
      setHint("El presupuesto mínimo es 1.00");
      return;
    }
    setHint(null);
    onCommit(micros);
    setText((micros / 1_000_000).toFixed(2));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
          style={{
            width: 120, padding: "8px 10px", borderRadius: UI.radiusSm,
            border: `1px solid ${UI.borderStrong}`, background: "none",
            color: UI.text, fontFamily: UI.fontMono, fontSize: 13.5,
          }}
        />
        <span style={{ fontSize: 12, color: UI.muted }}>{currency ?? ""} / día</span>
        <span style={{ fontSize: 11.5, color: UI.faint }}>
          En vivo: <b style={{ color: UI.muted }}>{(baseMicros / 1_000_000).toFixed(2)}</b>
        </span>
      </div>
      {hint ? <span style={{ color: UI.danger, fontSize: 11.5 }}>{hint}</span> : null}
    </div>
  );
}

export default function MetaEditorClient({ blueprintId, doc: initialDoc, status, accountRef }: {
  blueprintId: string;
  doc: MetaEditDoc;
  status: string;
  accountRef: string;
}) {
  const router = useRouter();
  const [doc, setDoc] = useState<MetaEditDoc>(initialDoc);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const n = useMemo(() => countMetaEdits(doc), [doc]);

  // Every field write routes through here (single choke point, mirror of
  // editor-client.tsx's updateDoc minus the provenance diffing meta doesn't have).
  function updateDoc(fn: (d: MetaEditDoc) => MetaEditDoc) {
    setDoc(fn(doc));
  }

  function setCampaign(patch: Partial<MetaEditDoc["campaign"]["desired"]>) {
    updateDoc((d) => ({ ...d, campaign: { ...d.campaign, desired: { ...d.campaign.desired, ...patch } } }));
  }
  function setAdset(adsetId: string, patch: Partial<MetaAdset["desired"]>) {
    updateDoc((d) => ({
      ...d,
      campaign: {
        ...d.campaign,
        adsets: d.campaign.adsets.map((as) =>
          as.id === adsetId ? { ...as, desired: { ...as.desired, ...patch } } : as
        ),
      },
    }));
  }
  function setAd(adsetId: string, adId: string, statusValue: "ENABLED" | "PAUSED") {
    updateDoc((d) => ({
      ...d,
      campaign: {
        ...d.campaign,
        adsets: d.campaign.adsets.map((as) =>
          as.id !== adsetId ? as : {
            ...as,
            ads: as.ads.map((ad) => (ad.id === adId ? { ...ad, desired: { status: statusValue } } : ad)),
          }
        ),
      },
    }));
  }

  async function saveNow(current: MetaEditDoc): Promise<boolean> {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/command/blueprint/${blueprintId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: current }), // whole doc; server merges (mergeMetaEditDoc)
      });
      const data = (await res.json()) as SaveResponse;
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLastSavedAt(Date.now());
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Error guardando cambios");
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Debounced autosave — identical skip-first pattern to editor-client.tsx.
  const skipFirst = useRef(true);
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const t = setTimeout(() => { void saveNow(doc); }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Reload-recreates-session: POST /api/command/edit again → new blueprint id.
  async function handleReload() {
    if (!window.confirm("Se descartarán los cambios sin aplicar. ¿Recargar los datos en vivo de la campaña?")) {
      return;
    }
    setReloading(true);
    setReloadError(null);
    try {
      const res = await fetch("/api/command/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "meta_ads",
          account_ref: accountRef,
          campaign_id: doc.campaign.id,
        }),
      });
      const data = (await res.json()) as EditResponse;
      if (!res.ok || !data.id) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.replace(`/command/editar-meta/${data.id}`);
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : "Error recargando la campaña");
    } finally {
      setReloading(false);
    }
  }

  async function handleReview() {
    const ok = await saveNow(doc);
    if (!ok) return;
    router.push(`/command/editar-meta/${blueprintId}/revisar`);
  }

  const c = doc.campaign;

  return (
    <div>
      <PageHeader
        title={
          <>
            Editar campaña Meta — <em style={{ fontStyle: "italic", color: UI.accent }}>{c.base.name}</em>
          </>
        }
        subtitle="Los cambios se autoguardan en este borrador. Nada toca la cuenta en vivo hasta que revises y publiques en la siguiente pantalla."
      />

      {status !== "draft" ? (
        <ErrorCard message={`Este borrador ya no está en edición (estado: ${status}).`} style={{ marginBottom: 16 }} />
      ) : null}

      {c.base.status === "ENABLED" ? (
        // Same EN VIVO honesty treatment as editor-preview.tsx's ActiveBanner
        // (dashed danger border + short warning) — inline here, meta copy.
        <div style={{
          border: `1px dashed ${UI.danger}`, borderRadius: UI.radiusSm, padding: "9px 12px",
          background: `color-mix(in srgb, ${UI.danger} 8%, transparent)`,
          fontSize: 12.5, color: UI.text, marginBottom: 16,
        }}>
          <b style={{ color: UI.danger, fontSize: 11, letterSpacing: "0.06em" }}>EN VIVO</b>{" "}
          Esta campaña está activa en Meta. Los cambios se aplicarán sobre entrega real al publicar.
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <SecondaryButton disabled={reloading} onClick={() => void handleReload()}>
          {reloading ? "Recargando…" : "Recargar datos en vivo"}
        </SecondaryButton>
        <span style={{ fontSize: 12, color: UI.faint }}>
          {saving ? "Guardando…" : lastSavedAt ? `Guardado ${new Date(lastSavedAt).toLocaleTimeString("es-MX")}` : "Sin cambios guardados"}
        </span>
      </div>
      {reloadError ? <ErrorCard message={reloadError} style={{ marginBottom: 16 }} /> : null}
      {saveError ? <ErrorCard message={saveError} style={{ marginBottom: 16 }} /> : null}

      {/* ── Campaign card ── */}
      <Card style={{ marginBottom: 16 }}>
        <SectionLabel>Campaña</SectionLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 14px", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{c.base.name}</span>
          <Badge tone="muted">{c.base.effectiveStatus}</Badge>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <StatusToggle value={c.desired.status} base={c.base.status} onChange={(s) => setCampaign({ status: s })} />
          {c.base.dailyBudgetMicros !== null && c.desired.dailyBudgetMicros !== null ? (
            <BudgetInput
              valueMicros={c.desired.dailyBudgetMicros}
              baseMicros={c.base.dailyBudgetMicros}
              currency={c.base.currency}
              onCommit={(m) => setCampaign({ dailyBudgetMicros: m })}
            />
          ) : c.base.lifetimeBudgetMicros !== null ? (
            <span style={{ fontSize: 12.5, color: UI.muted }}>
              Presupuesto total (lifetime) — bloqueado en esta versión; el estado sí es editable.
            </span>
          ) : (
            <span style={{ fontSize: 12.5, color: UI.muted }}>
              El presupuesto diario vive en los conjuntos de anuncios (ABO).
            </span>
          )}
        </div>
      </Card>

      {/* ── Adset cards ── */}
      {c.adsets.map((as) => (
        <Card key={as.id} style={{ marginBottom: 16 }}>
          <SectionLabel>Conjunto de anuncios</SectionLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 14px", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 14.5 }}>{as.base.name}</span>
            <Badge tone="muted">{as.base.effectiveStatus}</Badge>
            <LearningBadge phase={as.base.learningPhase} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <StatusToggle value={as.desired.status} base={as.base.status} onChange={(s) => setAdset(as.id, { status: s })} />
            {as.base.dailyBudgetMicros !== null && as.desired.dailyBudgetMicros !== null ? (
              <BudgetInput
                valueMicros={as.desired.dailyBudgetMicros}
                baseMicros={as.base.dailyBudgetMicros}
                currency={c.base.currency}
                onCommit={(m) => setAdset(as.id, { dailyBudgetMicros: m })}
              />
            ) : as.base.lifetimeBudgetMicros !== null ? (
              <span style={{ fontSize: 12.5, color: UI.muted }}>
                Presupuesto total (lifetime) — bloqueado en esta versión; el estado sí es editable.
              </span>
            ) : (
              <span style={{ fontSize: 12.5, color: UI.muted }}>
                Presupuesto administrado por la campaña (CBO).
              </span>
            )}
          </div>

          {as.ads.length > 0 ? (
            <div style={{ marginTop: 16, borderTop: `1px solid ${UI.border}`, paddingTop: 12 }}>
              <SectionLabel>Anuncios ({as.ads.length})</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
                {as.ads.map((ad) => (
                  <div key={ad.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13.5 }}>{ad.base.name}</span>
                      <Badge tone="muted">{ad.base.effectiveStatus}</Badge>
                    </div>
                    <StatusToggle value={ad.desired.status} base={ad.base.status} onChange={(s) => setAd(as.id, ad.id, s)} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      ))}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <PrimaryButton onClick={() => void handleReview()} disabled={n === 0}>
          Revisar cambios ({n})
        </PrimaryButton>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `src/app/command/editar-meta/[id]/revisar/page.tsx`**

Mirror of `editar/[id]/revisar/page.tsx` minus provenance (`deriveAiMarkers`/`readProv`), swapping in the meta parse/diff:

```tsx
import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, ErrorCard, EmptyState, SecondaryButton, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { getBlueprint } from "@/lib/command/blueprint/repo";
import type { EditCompiledAction } from "@/lib/command/edit/diff";
import { diffMetaEditDoc } from "@/lib/command/edit/meta-diff";
import { EDIT_BASELINE_MAX_AGE_MS, parseMetaEditDoc, type MetaEditDoc } from "@/lib/command/edit/meta-schema";
import { previewBlueprintGates, type GatePreview } from "@/lib/command/blueprint/preview";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import MetaRevisarClient from "./meta-revisar-client";

// Auth + DB reads (blueprint) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isMetaEditDoc(doc: unknown): boolean {
  return (doc as { docType?: unknown } | null)?.docType === "meta_edit_v1";
}

/** One-time Date.now() read at request time (see revisar/page.tsx's ageMs for
 * the purity-lint rationale). Frozen into a prop — no hydration skew. */
function ageMs(loadedAt: string): number {
  return Date.now() - Date.parse(loadedAt);
}

export default async function RevisarMetaEditPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getCommandAccess();
  if (!access) redirect("/login");
  const { id } = await params;

  const blueprint = await getBlueprint(id, access.workspaceIds);
  if (!blueprint || !isMetaEditDoc(blueprint.doc)) notFound();

  let doc: MetaEditDoc | null = null;
  let compiled: EditCompiledAction[] = [];
  let gatePreview: GatePreview | null = null;
  let error: string | null = null;
  let noChanges = false;

  try {
    doc = parseMetaEditDoc(blueprint.doc);
    compiled = diffMetaEditDoc(doc, id);
    if (compiled.length === 0) {
      noChanges = true;
    } else {
      const execDeps = buildExecutorDeps(access.accessToken);
      gatePreview = await previewBlueprintGates(id, access.workspaceIds, {
        settings: execDeps.settings,
        repo: execDeps.repo,
      });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Error calculando los cambios del blueprint";
  }

  const baselineAgeMs = doc ? ageMs(doc.loadedAt) : 0;
  const baselineStale = !doc || !Number.isFinite(baselineAgeMs) || baselineAgeMs > EDIT_BASELINE_MAX_AGE_MS;

  return (
    <div>
      <Header
        breadcrumbs={[
          { label: "Centro de Mando", href: "/command" },
          { label: "Editar campaña Meta", href: `/command/editar-meta/${id}` },
          { label: "Revisión" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Revisar y aplicar cambios"
          subtitle="Cada acción que se enviará a Meta, agrupada por nodo de la campaña. Estos cambios se aplican a una campaña EN VIVO al publicar."
        />
        {noChanges ? (
          <EmptyState
            title="No hay cambios que aplicar"
            hint="No se detectaron diferencias entre el borrador y la campaña en vivo."
            action={<SecondaryButton href={`/command/editar-meta/${id}`}>Volver al editor</SecondaryButton>}
          />
        ) : error || !doc || !gatePreview ? (
          <ErrorCard message={error ?? "Error preparando la vista previa de compuertas."} />
        ) : (
          <MetaRevisarClient
            blueprintId={id}
            status={blueprint.status}
            accountRef={blueprint.accountRef}
            doc={doc}
            compiled={compiled}
            gatePreview={gatePreview}
            baselineAgeMs={baselineAgeMs}
            baselineStale={baselineStale}
          />
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Create `src/app/command/editar-meta/[id]/revisar/meta-revisar-client.tsx`**

Sibling of `editar/[id]/revisar/revisar-client.tsx` WITHOUT the `GoogleSearchEditDoc` coupling (no `adByResourceName`, no RSA pair-folding, no ProvBadge/aiMarkers). The publish/rollback state machine is copied semantically intact — its comments about execute/route.ts's status contract apply verbatim. Structure:

0. **File header + imports** (complete):

```tsx
"use client";

// Centro de Mando meta-edit — Review & apply. Sibling of
// editar/[id]/revisar/revisar-client.tsx, mirrored structurally: same two gate
// surfaces (proactive GatePreview + reactive 409 `blocked` panel), same
// double-submit guard, same approve → execute → rollback state machine over
// the network-agnostic blueprint endpoints. Differences: renders only the 3
// slice-1 verbs, groups by campaign/adset nodes, and carries NO provenance
// (the meta editor never mounts CopilotoDock).
import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Card, SectionLabel, Badge, DataTable, THead, Row, Cell,
  PrimaryButton, SecondaryButton, GhostDangerButton, ErrorCard, UI,
} from "@/components/ui-kit";
import type { EditCompiledAction } from "@/lib/command/edit/diff";
import type { MetaEditDoc } from "@/lib/command/edit/meta-schema";
import type { GatePreview } from "@/lib/command/blueprint/preview";
import type { GateResult, BudgetUpdatePayload } from "@/lib/command/types";
```

1. **Copy verbatim from `revisar-client.tsx`** (same names, same bodies — presentational helpers with zero google coupling): `money()` (lines 88-90), `FieldGrid`/`Field` (168-194), `GateTable` (473-493), `NextSteps` (499-530, changing only the two hrefs to `/command/editar-meta/${blueprintId}`), `HonestyBanner` (579-606), `STATUS_TONE` (80-86).
2. **Meta-specific constants** (complete):

```tsx
const ACTION_LABEL: Record<string, string> = {
  budget_update: "Actualizar presupuesto",
  pause: "Pausar",
  enable: "Habilitar",
};

const ENTITY_KIND_LABEL: Record<string, string> = {
  campaign: "Campaña",
  adset: "Conjunto de anuncios",
  ad: "Anuncio",
};
```

3. **Grouping** (complete — one campaign node + one node per adset; ad actions resolve to their parent adset via the doc):

```tsx
interface ActionGroup {
  key: string;
  title: string;
  actions: EditCompiledAction[];
}

function groupByNode(compiled: EditCompiledAction[], doc: MetaEditDoc): ActionGroup[] {
  const campaignGroup: ActionGroup = { key: "campaign", title: `Campaña — ${doc.campaign.base.name}`, actions: [] };
  const adsetNodes = new Map<string, ActionGroup>();
  const adIdToAdsetId = new Map<string, string>();
  const order: string[] = [];

  for (const as of doc.campaign.adsets) {
    adsetNodes.set(as.id, { key: as.id, title: `Conjunto de anuncios — ${as.base.name}`, actions: [] });
    for (const ad of as.ads) adIdToAdsetId.set(ad.id, as.id);
    order.push(as.id);
  }

  for (const action of compiled) {
    if (action.entityKind === "adset") {
      (adsetNodes.get(action.entityRef) ?? campaignGroup).actions.push(action);
    } else if (action.entityKind === "ad") {
      const parent = adIdToAdsetId.get(action.entityRef);
      ((parent && adsetNodes.get(parent)) || campaignGroup).actions.push(action);
    } else {
      campaignGroup.actions.push(action);
    }
  }

  return [campaignGroup, ...order.map((id) => adsetNodes.get(id)!)].filter((g) => g.actions.length > 0);
}
```

4. **PayloadView + ActionCard** (complete — only the 3 slice-1 verbs):

```tsx
function PayloadView({ action }: { action: EditCompiledAction }) {
  switch (action.actionType) {
    case "budget_update": {
      const p = action.payload as BudgetUpdatePayload;
      const before = action.expected?.dailyBudgetMicros;
      return (
        <FieldGrid>
          <Field label="Presupuesto anterior">{typeof before === "number" ? money(before) : "—"}</Field>
          <Field label="Presupuesto nuevo">{money(p.newDailyBudgetMicros)}</Field>
        </FieldGrid>
      );
    }
    case "pause":
    case "enable":
      return (
        <FieldGrid>
          <Field label="Entidad">{action.entityName ?? action.entityRef}</Field>
          <Field label="Tipo">{ENTITY_KIND_LABEL[action.entityKind] ?? action.entityKind}</Field>
        </FieldGrid>
      );
    default:
      return null;
  }
}
```

`ActionCard` = copy of revisar-client.tsx's `ActionCard` (384-412) minus the `isIa`/ProvBadge prop.

5. **GatesSummaryCard** — copy of revisar-client.tsx's (535-572) with the footnote swapped for the meta truth (Meta v1 verbs have no rehearsal — gates.ts passes VALIDATE_ONLY "No aplica"):

```tsx
        <span style={{ fontSize: 12, color: UI.muted, maxWidth: 420 }}>
          Meta no ofrece ensayo (validate_only) para estos verbos de edición —
          las compuertas deterministas de arriba son la verificación previa completa.
        </span>
```

6. **Root component** (complete — the full publish/rollback state machine; identical semantics and comments to revisar-client.tsx lines 612-760, minus `doc`-typed google props):

```tsx
export default function MetaRevisarClient({
  blueprintId, status, accountRef, doc, compiled, gatePreview, baselineAgeMs, baselineStale,
}: {
  blueprintId: string;
  status: string;
  accountRef: string;
  doc: MetaEditDoc;
  compiled: EditCompiledAction[];
  gatePreview: GatePreview;
  baselineAgeMs: number;
  baselineStale: boolean;
}) {
  const router = useRouter();
  const [publishing, setPublishing] = useState(false);
  const [blocked, setBlocked] = useState<GateResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executeFailed, setExecuteFailed] = useState(false);
  const [rollbackOffered, setRollbackOffered] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackDone, setRollbackDone] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const groups = useMemo(() => groupByNode(compiled, doc), [compiled, doc]);
  const alreadyMoved = status !== "draft";
  const gatesPass = gatePreview.summary.blockingCount === 0;
  const canPublish = !publishing && !blocked && !executeFailed && !alreadyMoved && gatesPass && !baselineStale;

  async function publish() {
    if (!canPublish) return;
    setPublishing(true);
    setError(null); setBlocked(null); setExecuteFailed(false);
    setRollbackOffered(false); setRollbackDone(false); setRollbackError(null);

    // Stage 1 — approve (leaves 'draft' untouched on failure; retry is safe).
    try {
      const approveRes = await fetch(`/api/command/blueprint/${blueprintId}/approve`, { method: "POST" });
      const approveData = await approveRes.json().catch(() => ({}) as { error?: string });
      if (!approveRes.ok) throw new Error(approveData.error ?? `No se pudo aprobar (HTTP ${approveRes.status}).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error aprobando los cambios.");
      setPublishing(false);
      return;
    }

    // Stage 2 — execute. Same 3-way failure contract as the google revisar
    // client (409+blocked → 'failed', rollback offered; bare 409 = blast-radius
    // pre-check, reverted to 'approved', NO rollback; other non-ok → 'failed',
    // rollback offered; network throw → unknown, NO rollback).
    try {
      const execRes = await fetch(`/api/command/blueprint/${blueprintId}/execute`, { method: "POST" });
      const execData = await execRes.json().catch(() => ({}) as { error?: string; blocked?: GateResult[]; ok?: boolean });

      if (execRes.status === 409 && Array.isArray(execData.blocked)) {
        setBlocked(execData.blocked);
        setExecuteFailed(true);
        setRollbackOffered(true);
        setPublishing(false);
        return;
      }
      if (execRes.status === 409) {
        setError(execData.error ?? `No se pudo ejecutar (HTTP ${execRes.status}).`);
        setExecuteFailed(true);
        setPublishing(false);
        return;
      }
      if (!execRes.ok || execData.ok === false) {
        setError(execData.error ?? `No se pudo ejecutar (HTTP ${execRes.status}).`);
        setExecuteFailed(true);
        setRollbackOffered(true);
        setPublishing(false);
        return;
      }
      router.replace("/command/bitacora"); // publishing stays true — no second-click window
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error aplicando los cambios.");
      setExecuteFailed(true);
      setPublishing(false);
    }
  }

  async function rollback() {
    setRollbackBusy(true);
    setRollbackError(null);
    try {
      const res = await fetch(`/api/command/blueprint/${blueprintId}/rollback`, { method: "POST" });
      const data = await res.json().catch(() => ({}) as { error?: string });
      if (!res.ok) throw new Error(data.error ?? `No se pudo revertir (HTTP ${res.status}).`);
      setRollbackDone(true);
      setRollbackOffered(false);
    } catch (e) {
      setRollbackError(e instanceof Error ? e.message : "Error revirtiendo los cambios.");
    } finally {
      setRollbackBusy(false);
    }
  }

  return ( /* same render tree as revisar-client.tsx lines 761-880, with:
    - GatesSummaryCard (meta footnote variant)
    - summary Card: Field "Cuenta"={accountRef} · "Campaña"={doc.campaign.base.name}
      · "Estado del blueprint" Badge · "Acciones compiladas"={compiled.length}
      · <HonestyBanner baselineAgeMs baselineStale />
    - action row: Volver al editor → /command/editar-meta/${blueprintId} +
      PrimaryButton "Aplicar cambios"/"Aplicando…" disabled={!canPublish}
    - baselineStale ErrorCard: same copy, Recargar → /command/editar-meta/${blueprintId}
    - alreadyMoved ErrorCard: same copy
    - error + NextSteps block: identical wiring
    - blocked Card + GateTable + NextSteps: identical wiring
    - groups.map: Card per group, SectionLabel {g.title}, g.actions.map ActionCard
      (no pair-folding, no ia counter) */ );
}
```

The render tree is the ONE deliberately-referenced block (pure JSX layout, zero new behavior); every branch it renders is enumerated above and every handler/prop it consumes is fully specified. Implementer: transcribe from `revisar-client.tsx`, deleting the `aiPaths`/`adByResourceName`/`toDisplayRows`/`ReplacePairCard` machinery.

- [ ] **Step 5: Wire `cuentas-client.tsx` — `startEdit` network branch + button gating**

Replace `startEdit` (cuentas-client.tsx:167-190) with:

```tsx
  // Loads a live campaign into an edit-mode draft blueprint and navigates to the
  // matching workbench. Google: v2.3 flow (connection_id required; non-SEARCH
  // campaigns 409 server-side). Meta: meta-edit flow (no connection; no-token /
  // cross-account / archived campaigns 409 server-side). Both surface inline.
  async function startEdit(campaign: CampaignRow) {
    if (!selected) return;
    const isMeta = selected.network === "meta_ads";
    if (!isMeta && !selected.connectionId) return;
    setEditingRef(campaign.entityRef);
    setEditErrors((prev) => ({ ...prev, [campaign.entityRef]: "" }));
    try {
      const res = await fetch("/api/command/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isMeta
            ? { network: "meta_ads", account_ref: selected.accountRef, campaign_id: campaign.entityRef }
            : {
                network: "google_ads",
                connection_id: selected.connectionId,
                account_ref: selected.accountRef,
                campaign_id: campaign.entityRef,
              }
        ),
      });
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.push(isMeta ? `/command/editar-meta/${data.id}` : `/command/editar/${data.id}`);
    } catch (e) {
      setEditErrors((prev) => ({ ...prev, [campaign.entityRef]: e instanceof Error ? e.message : "Error abriendo el editor" }));
    } finally {
      setEditingRef(null);
    }
  }
```

And replace the Editar button's render guard (:295-299) — meta rows get the button ONLY when `metaWritable` (the existing prop, cuentas-client.tsx:60-65; without a token the row normally can't even load, and the inline `editErrors` 409 is the backstop):

```tsx
                          {selected.network === "google_ads" || (selected.network === "meta_ads" && metaWritable) ? (
                            <SecondaryButton disabled={editingRef === c.entityRef} onClick={() => void startEdit(c)}>
                              {editingRef === c.entityRef ? "Abriendo…" : "Editar"}
                            </SecondaryButton>
                          ) : null}
```

- [ ] **Step 6: Typecheck + build + full suite**

Run: `bunx tsc --noEmit` → clean.
Run: `bun test` → all green (no test touches the new clients).
Run: `bun run build` → exit 0; `/command/editar-meta/[id]` and `/command/editar-meta/[id]/revisar` appear in the route list.

Manual checklist (playwright/dev on port 4200, mocked creds — the no-token path is the ONLY one reachable today):
- [ ] `/command/editar-meta/<uuid-of-a-google-edit-blueprint>` → 404 (mutual exclusion), and `/command/editar/<uuid-of-a-meta-edit-blueprint>` → 404 (the untouched google guard).
- [ ] Cuentas: meta rows show NO Editar button without token (`metaWritable` false) and the "Meta: META_SYSTEM_USER_TOKEN no configurado…" footnote renders.
- [ ] Google rows: Editar still opens `/command/editar/<id>` (regression).

- [ ] **Step 7: Commit**

```bash
git add "src/app/command/editar-meta/[id]/page.tsx" "src/app/command/editar-meta/[id]/meta-editor-client.tsx" "src/app/command/editar-meta/[id]/revisar/page.tsx" "src/app/command/editar-meta/[id]/revisar/meta-revisar-client.tsx" src/app/command/cuentas/cuentas-client.tsx
git commit -m "feat(meta-edit): editar-meta workbench + revisar (approve→execute→rollback) + cuentas entry gated on metaWritable"
```

---

### Task 7: Documenting tests (risks #4/#12) + deploy notes

**Files:**
- Test: `src/lib/command/__tests__/meta-edit-gates.test.ts` (new — gates.ts itself stays UNTOUCHED; these pin how the untouched gates behave against meta-edit inputs)
- Modify: `docs/superpowers/plans/DEPLOY-NOTES-command-center.md` (append a meta-edit section)

**Interfaces:** none new (docs + documenting tests only).

- [ ] **Step 1: Write the documenting tests**

Create `src/lib/command/__tests__/meta-edit-gates.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { blockingFailures, runGates, type GateInput } from "../gates";
import { CC_SETTINGS_DEFAULTS, type EntitySnapshot } from "../types";

// Documenting tests for two meta-edit properties of the UNTOUCHED gates.ts —
// they pin behavior this feature depends on, so a future gates change that
// breaks either assumption fails here with context instead of in production.

function metaEditInput(over: Partial<GateInput> = {}): GateInput {
  return {
    settings: { ...CC_SETTINGS_DEFAULTS },
    network: "meta_ads",
    action: { actionType: "budget_update", entityKind: "adset", entityRef: "222", payload: { newDailyBudgetMicros: 22_000_000 } },
    capabilities: { read: true, write: true, actionTypes: ["budget_update", "pause", "enable"] },
    before: {
      entityKind: "adset", entityRef: "222", status: "ENABLED",
      dailyBudgetMicros: 20_000_000, learningPhase: "STABLE",
      conversions30d: 5, spend30dMicros: 100_000_000,
    } as EntitySnapshot,
    expected: null,
    executedTodayForAccount: 0,
    validateResult: null,
    ...over,
  };
}

describe("meta-edit risk #4 — DRIFT compares CONFIGURED status, like-for-like", () => {
  it("passes when configured status matches expected, even while effective_status diverges (raw rides along only)", () => {
    // buildMetaEditDoc bases the doc on Graph configured `status` (Task 2) and
    // the adapter's snapshot() maps entity.status the same way — so an adset
    // configured ACTIVE inside a paused campaign (effective CAMPAIGN_PAUSED)
    // must NOT drift: both sides of the comparison speak configured status.
    const rs = runGates(metaEditInput({
      action: { actionType: "pause", entityKind: "adset", entityRef: "222", payload: {} },
      expected: { status: "ENABLED" },
      before: {
        entityKind: "adset", entityRef: "222", status: "ENABLED", // configured, mapped by snapshot()
        raw: { effective_status: "CAMPAIGN_PAUSED" },             // divergent effective — display-only
      } as EntitySnapshot,
    }));
    expect(rs.find((g) => g.id === "DRIFT")!.status).toBe("pass");
  });

  it("still blocks on a REAL configured-status change (the guard is alive, not neutered)", () => {
    const rs = runGates(metaEditInput({
      action: { actionType: "pause", entityKind: "adset", entityRef: "222", payload: {} },
      expected: { status: "ENABLED" },
      before: { entityKind: "adset", entityRef: "222", status: "PAUSED" } as EntitySnapshot,
    }));
    expect(blockingFailures(rs).map((g) => g.id)).toContain("DRIFT");
  });
});

describe("meta-edit risk #12 — LEARNING_PHASE preview-vs-execute divergence (accepted + documented)", () => {
  it("preview side: the synthetic before (seeded from expected) has NO learningPhase → gate passes", () => {
    // preview.ts's meta-edit branch builds before = {status:'UNKNOWN', ...expected};
    // a budget_update's expected carries only dailyBudgetMicros — learningPhase
    // is absent, so LEARNING_PHASE cannot fire at preview time.
    const rs = runGates(metaEditInput({
      before: {
        entityKind: "adset", entityRef: "222", status: "UNKNOWN",
        dailyBudgetMicros: 20_000_000, // ...expected spread — no learningPhase
      } as EntitySnapshot,
    }));
    expect(rs.find((g) => g.id === "LEARNING_PHASE")!.status).toBe("pass");
  });

  it("execute side: the real snapshot may reveal LEARNING and hard-block adset budget/enable", () => {
    // This is the DESIGNED divergence: "compuertas N/N" on the review screen is
    // a preview, not a guarantee — the executor re-runs gates against the live
    // snapshot (learning_stage_info included, Task 2 snapshot fields) and a
    // LEARNING adset blocks budget_update/enable at publish time (gates.ts).
    const rs = runGates(metaEditInput({
      before: {
        entityKind: "adset", entityRef: "222", status: "ENABLED",
        dailyBudgetMicros: 20_000_000, learningPhase: "LEARNING",
      } as EntitySnapshot,
    }));
    expect(blockingFailures(rs).map((g) => g.id)).toContain("LEARNING_PHASE");
  });
});
```

Run: `bun test src/lib/command/__tests__/meta-edit-gates.test.ts` → PASS immediately (documenting tests pin EXISTING behavior — a failure here means gates.ts was touched, which this plan forbids).

- [ ] **Step 2: Append the meta-edit section to `docs/superpowers/plans/DEPLOY-NOTES-command-center.md`**

Append after the v3.0 section, following the file's per-release format:

```markdown
---

# Command Center — Meta Edit Mode (última fase del full-POC)

**ZERO migrations.** `/api/migrate` and `src/lib/schema.ts` are untouched: the three edit verbs (`budget_update`, `pause`, `enable`) have been in every `cc_settings.allowed_action_types` default since 007, re-affirmed by 008/009/010 — pinned by the "zero-migration guard" test so a future default change can't silently brick meta edit. Built entirely with mocked credentials — **editing is IMPOSSIBLE in production until the Meta envs exist** (session create answers 409 with the credential reason; no blueprint row, never mocked baselines).

## Activation

Only the EXISTING Meta env vars — nothing new to provision:
- `META_SYSTEM_USER_TOKEN` (system user, ads_management) — read+write switchboard; without it, Cuentas shows "pendiente de credenciales" and POST /api/command/edit answers 409.
- `META_AD_ACCOUNT_IDS` (comma-separated `act_...` allow-list) — the edit route 400s any account_ref outside it.
- `META_APP_SECRET` — appsecret_proof on every call (required if the app enforces it).
- `META_API_VERSION=v25.0` (default).
- `META_PAGE_ID` is NOT needed for edit mode (creates only).

After setting them: Cuentas → Meta row → Ver campañas → **Editar** (button appears once `capabilities().write` is true) → `/command/editar-meta/<id>` → Revisar → Aplicar cambios.

## What's editable (slice 1)

Pause/enable at campaign + adset + ad; daily `budget_update` at campaign (CBO) or adset (ABO) — whichever level the live account exposes (base non-null). Deferred (fail-closed, spec §f): creative/copy/targeting/name edits, lifetime-budget editing (status still editable on those nodes), CBO↔ABO moves, bid changes, creating adsets/ads inside the edit doc, copiloto `meta_edit` docKind, pagination past one `paging.next`.

## Rollback semantics (verified — zero adapter rollback changes)

The chokepoint already covers slice-1: `pause` ↔ `enable` are self-inverse (configured status, exactly what snapshot() records); `budget_update` rolls back to the before-snapshot budget (minor-units × 10_000 → always cent-aligned → round-trips the adapter's write exactly). Meta v1 verbs pass VALIDATE_ONLY as "No aplica", so rollback is never stranded on the rehearsal hard-blocker. The verify sweep works unchanged (`metaBudgetRoundMicros` comparison; null actual → "unverificable", never drift). Precondition already shipped: the per-entityKind snapshot fields fix — without it, every ad-level action died in prepare() before gates.

## First-live-run checklist

The v2.2 12-item checklist above still applies (access tier, validate_only, app-secret proof, API version…). Edit-mode additions to verify on the first credentialed run:
1. `POST /<node-id> {status: PAUSED|ACTIVE}` flips configured status at all 3 levels (campaign/adset/ad) and `effective_status` follows.
2. `POST /<node-id> {daily_budget: <minor units>}` is accepted at BOTH campaign (CBO) and adset (ABO) level; confirm the account's minimum daily budget clears the schema's 1-unit floor.
3. `GET /<campaign-id>?fields=...account_id` returns bare digits (the tenant bind compares against `act_`-stripped ref).
4. A campaign with >200 adsets / >500 ads per page follows ONE `paging.next` then refuses with "Campaña demasiado grande para el editor." — confirm acceptable for the target accounts.
5. LEARNING adsets: budget/enable will hard-block at publish (gate) even when the review screen showed N/N — expected, documented divergence (risk #12).

## Deactivation / rollback of the feature

Unset `META_SYSTEM_USER_TOKEN` → capabilities read/write false → new edit sessions 409 at create; existing meta-edit drafts stay readable but can never publish (CAPABILITY gate fails closed at execute). No DB cleanup needed — draft blueprints are inert rows.
```

- [ ] **Step 3: Run everything + commit**

Run: `bun test && bunx tsc --noEmit` → all green.

```bash
git add src/lib/command/__tests__/meta-edit-gates.test.ts docs/superpowers/plans/DEPLOY-NOTES-command-center.md
git commit -m "docs(meta-edit): deploy notes (zero migrations, env-only activation) + risk #4/#12 documenting gate tests"
```

---

## Self-Review Notes

- **Spec coverage:** §a → Task 1 (schema/TTL/merge, all four merge steps + both superRefine directions); §b → Task 2 (4 GETs, tenant bind, campaign-status throw, leaf filter, ≤1-next pagination, pure mapper with injected nowIso); §c → Task 3 (A/B/E phases, "me-" recKey, defense throw, tmp: self-assert, es-MX notes); §d.1-.2 → Task 4; §d.3-.4 → Task 5; §d.5 (Copiloto: fail-closed with ZERO code changes — `patch/schema.ts`'s docKind enum + `copiloto/route.ts`'s literal check already 400 meta-edit docs; the meta editor never mounts the dock) → Global Constraints + Task 6 (no CopilotoDock import); §d.6 → Task 6; §d.7 (blueprint POST untouched) → Global Constraints; §e → Task 7 deploy notes (no code — verified-in-spec); §f → Task 7 deploy notes; §g file plan → matches 1:1 (3 new lib files + 4 new UI files + 6 modified + 4 new/2 extended test files); §h → below.
- **Risks-to-pin → named tests:** #1 → Task 4 "risk #1 regression: four-way dispatch" + Task 5 "risk #1 regression: meta CREATE blueprint still previews"; #2 → Task 1 "invalid incoming throws" (the 400 half) + Task 5 dispatch tests + the PUT reviewer checklist (route glue has no handler-test idiom in this repo — v3.0 Task 5 precedent); #3 → Task 1 "spoofing matrix" + "unknown incoming ids dropped" + "final re-parse fires against SERVER truth"; #4 → Task 2 "statuses map from CONFIGURED status" + Task 7 DRIFT documenting pair; #5 → Task 1 "rejects a non-cent-aligned desired budget" (+ Task 6's cent-quantizing BudgetInput); #6 → Task 2 snapshot('ad'/'adset'/'campaign') field tests; #7 → Task 3 ordering/no-emission/determinism/throw suite; #8 → meta-adapter.test.ts's existing no-token capabilities test + Task 2 tenant-bind throw test + Task 4 route reviewer checklist (409-no-row, allow-list 400); #9 → Task 4 "stale meta-edit baseline refuses BEFORE deleting"; #10 → Task 2 pagination-throw test; #11 → Task 4 "zero-migration guard" describe; #12 → Task 7 LEARNING_PHASE preview-vs-execute pair.
- **Type-name consistency:** `MetaEditDoc`/`MetaEditAdset`/`MetaEditAd`/`parseMetaEditDoc`/`mergeMetaEditDoc` (Task 1) consumed by Tasks 2/4/5/6; `RawMetaCampaignTree`/`readMetaCampaignTree` (Task 2, exported from `networks/meta.ts`) + `buildMetaEditDoc` (Task 2, `edit/meta-read-tree.ts`) consumed by Task 4's route; `diffMetaEditDoc(doc, blueprintId): EditCompiledAction[]` (Task 3) consumed by Tasks 4/5/6; `SYNTHETIC_CAPABILITIES_META_EDIT` stays module-private to `preview.ts` (matches its three siblings).
- **Deliberate deviations, all argued inline:** (1) route handlers are pinned by reviewer checklists + lib-level tests, not handler tests — repo has zero route-test precedent (v3.0 plan Task 5 did the same); (2) `meta-revisar-client.tsx`'s render tree is transcribe-from-source (the one referenced block) — every handler, state var, fetch call, prop and es-MX string it renders is fully specified in this plan; (3) a 4th test file (`meta-edit-gates.test.ts`) beyond the spec's three — documenting tests for risks #4/#12 don't belong in schema/diff/read-tree suites.
