# Command Center v2 — Guided Campaign Builder — Design Spec

Date: 2026-07-07 · Status: draft-for-review · Owner: Pedro (hello@airankia.com)
Branch: `feat/command-center-beta` · Builds on v1 (committed, `09864ac`).

Design derived from a 4-lens parallel design exploration + an adversarial YAGNI critique
(workflow `wf_b79733bc-682`). The critique's discipline — "v1 is a well-made 900-line rail,
not a platform; don't design v2 as a framework" — is the governing constraint of this spec.

## 1. What this is (and what it deliberately is not)

**Vision (the target, over several slices):** a *hybrid workbench* where an operator
creates and edits full campaigns across Google + Meta on connected client accounts —
structure tree + step editor with a per-step **Manual / ✨ AI** switch + a docked copilot —
all executed through the v1 gate → ledger → rollback engine. AI proposes, the human
accepts, the deterministic gates always run. This is the platform's "deterministic floor +
AI judgment / `dato·ia·auto`" philosophy turned into a UI.

**THIS SPEC scopes only the first shippable slice** (the vision is decomposed; later slices
get their own specs):

> **Slice 1 — One Google Search create flow, manual with per-field AI, on the untouched rail.**

Everything is created **PAUSED**; enabling stays the existing v1 `enable` action. Roughly
800–1,200 new lines, almost entirely additive to v1.

**Explicitly OUT of slice 1** (roadmap §13, each its own later spec): all of Meta; edit
mode (readTree/differ/liveSnapshot/`update_*`); the docked copilot + `propose_blueprint_patch`
+ patch-op machinery; chat as an entry mode; any `NetworkBlueprintSchema` field-def registry /
widget union / form engine; a separate `gates-create.ts`; sitelinks/assets/audiences.

## 2. Sacred invariants

Unchanged from v1: read-only gads-sentinel + Copiloto candado; campaign-creation *wizards*
(`/brands/.../new/*`, own-account) untouched; `/api/command/actions/[id]/execute` +
`executeAction` remain the single mutation chokepoint; tenancy = Supabase RLS; per-workspace
connected tokens (never `GOOGLE_ADS_REFRESH_TOKEN`).

New for creation:
- **PAUSED-on-create.** Every created campaign carries `status:'PAUSED'` explicitly; a
  missing status **fails closed**. (a6-activator invariant.)
- **AI proposes, human accepts, gates enforce.** No AI surface calls `executeAction`. AI
  output is a *proposal*; only a human accept mutates the draft; compiled actions still need
  two-step approval + `runGates` at execute.
- **The runner may only substitute `tmp:` placeholders** in an approved action's payload —
  asserted deep-equal-except-resolved-paths, written under the same optimistic status guard
  as `transitionAction`. It may never otherwise alter an approved payload. *(Critique §4a —
  the single biggest hole; this invariant closes it.)*

## 3. Architecture — Blueprint on the rail

```
 Operator (workbench: tree + step editor + per-field ✨)
        │  edits a draft
        ▼
 cc_blueprints.doc  (one Zod-validated JSONB campaign tree; the editable draft)
        │  compile(doc)  — PURE, no IO
        ▼
 ordered cc_actions  (create_budget → create_campaign → create_ad_group →
        │             create_keywords → create_ad), each tagged
        │             {blueprint_id, seq, local_ref, payload with tmp:<ref>}
        │  "Approve blueprint" → bulk proposed→approved (approvedBy per row)
        ▼
 plan-runner  — sequential, resolves tmp: refs from earlier siblings' result_ref,
        │       persists resolved payload (placeholders-only invariant), then calls…
        ▼
 v1 executeAction  (UNCHANGED chokepoint: runGates → ledger pending → adapter.execute
        │           → ledger done + resourceNames → status executed)
        ▼
 cc_executions ledger (before/after, rollback recipe = remove_entity{resourceNames})
        │
        ▼
 rollbackBlueprint = reverse-seq loop over v1 rollbackAction  (children before parents)
```

Creation and (future) editing are two faces of "blueprint → gated actions → ledger →
rollback." The runner is a **loop above** `executeAction`, never beside it.

## 4. Data model (additive migration `008_command_center_v2`)

**New table `cc_blueprints`** (ADS DB, Drizzle + `/api/migrate`):
`{ id uuid pk, workspace_id uuid, created_by text, network text ('google_ads'),
account_ref text, connection_id uuid, doc jsonb NOT NULL (CcBlueprintDoc),
status text default 'draft' ('draft'|'approved'|'executing'|'executed'|'failed'),
error text, created_at, updated_at }` + index on `workspace_id`.
*(5 statuses only — `compiled`/`rolled_back`/`archived` are YAGNI, critique §1#3.)*

**`cc_actions` — 4 additive nullable columns** (v1 rows leave them null → zero behavior
change): `blueprint_id uuid`, `seq int`, `local_ref text` (the tempId this action creates),
`result_ref text` (resourceName after execute) + index `(blueprint_id, seq)`.

**NOT added:** `cc_executions.resourceNames` column (redundant — `buildRollback` already
persists `exec.resourceNames` in `rollback_recipe`; instead make `ExecOutcome` surface
`resourceNames` from `executeAction`). No `cc_plans` table, no `mode`/`liveSnapshot` columns
(edit mode deferred). Migration backfills the create action types into
`cc_settings.allowed_action_types` default (small internal team; KILL_SWITCH + two-step +
PAUSED already gate — critique §2#10).

**`CcBlueprintDoc`** (hand-written Zod, `src/lib/command/blueprint/schema.ts`, Google Search
shape only) — nodes carry a stable `nodeId` (for provenance/AI addressing) and a `tempId`:
```ts
{ network:'google_ads',
  campaign:{ nodeId; tempId; name; channel:'SEARCH'; status: z.literal('PAUSED');
    budget:{ nodeId; tempId; dailyMicros:int };
    bidding:{ strategy:BiddingStrategy; targetCpaMicros?; targetRoas? };
    geo:{ countryCodes:string[] /* fail-closed: ≥1 */; presenceOnly:boolean }; languageCode?;
    adGroups: Array<{ nodeId; tempId; name; cpcMicros?;
      keywords: Array<{ text; match:'EXACT'|'PHRASE'|'BROAD' }>;
      negatives: Array<{ text; match }>;
      ads: Array<{ nodeId; tempId; finalUrl;
        headlines:{text; pinnedField?}[] /* 3–15, ≤30 */;
        descriptions:{text}[] /* 2–4, ≤90 */; path1?; path2? /* ≤15 */ }> }> } }
```

## 5. Action families + adapter changes (`types.ts`, `networks/google.ts`)

**New `CcInternalActionType` members:** `create_budget`, `create_campaign`, `create_ad_group`,
`create_keywords`, `create_ad` (user-proposable via blueprint), and `remove_entity`
(**internal-only**, rollback of any create — exact clone of `remove_negatives`). One
cc_action per created entity (not one mega-action) → each gets its own gate run, ledger row,
rollback recipe. **Frozen vocabulary** (critique §2#6): these exact names; ref convention
`tmp:<localRef>` where `localRef = "<kind>:<seq>"` (e.g. `tmp:budget:1`).

`CcEntityKind` widened with `"ad"` only (keywords ride the `ad_group` ref — do NOT give
keywords their own entityKind; every new kind must be covered by the synthetic-before guard
or `snapshot()` throws at runtime — critique §5#4).

**`networks/google.ts`:**
- `buildMutation` gains create cases: `campaignBudgets:mutate` (create), `campaigns:mutate`
  (create, `status:PAUSED`, `advertisingChannelType:SEARCH`), `adGroups:mutate`,
  `adGroupCriteria:mutate` (keywords + negatives), `adGroupAds:mutate` (RSA) — mirroring the
  proven a6-activator bodies. Plus the `remove_entity` case (`:mutate` remove by resourceName).
- **`validate()` MUST handle `create_*` AND `remove_entity`.** *(Critique §5#1 — the stealth
  bug: `rollbackAction`'s hard-blocker list includes `VALIDATE_ONLY`, and Google's gate
  fails closed when `validateResult` is null; if `buildMutation` gains creates but `validate`
  throws on `remove_entity`, every create-rollback is permanently blocked. Dedicated test
  required.)*
- `buildRollback`: every `create_*` → `remove_entity{ resourceNames: exec.resourceNames }`;
  **must never return null** for a create (Meta has no validateOnly safety net later, and a
  null recipe strands a real entity — critique risk).
- `capabilities().actionTypes` adds the create family + `remove_entity`.

## 6. Gate changes — three small edits to `gates.ts`, NO new module

The critique settled the P1/P2-vs-P3 fight: run the **existing** `runGates` on creates. With a
synthetic `before` and `expected=null`, DRIFT passes by design, and BUDGET_DELTA /
CURRENCY_SANITY / ABS_BUDGET_CAP are `budget_update`-scoped no-ops — safe-but-vacuous, and the
vacuum is filled by validateOnly + PAUSED + one budget-cap extension. So:

1. **`remove_entity`** added to the internal carve-out at `ACTION_ALLOWED` (the hardcoded
   `=== "remove_negatives"` equality becomes a small set — note this is an edit to a live
   blocking gate v1 rollbacks depend on, not "free reuse," critique §5#2).
2. **`CURRENCY_SANITY` + `ABS_BUDGET_CAP` extended** to also read `create_budget.amountMicros`
   (today they only fire on `budget_update`, so a `create_budget` sails past both caps —
   critique's genuinely important catch, §2#2). ~10 lines.
3. **`PAUSED_ON_CREATE`** (new, blocking): a `create_campaign` payload must carry
   `status:'PAUSED'` explicitly; absent = fail. ~10 lines.

**Blast-radius** is handled by a **runner pre-check** (refuse to start if compiled-plan size +
`countExecutedToday` > `maxActionsPerAccountDay`), surfaced at Review — no new gate, no new
settings field, no `countCreatesToday` (critique §2#7, §1#2). RSA/creative limits live in a
new `RSA_SPEC` const in `knowledge.ts` (extracted from a4's prose), consumed by the **one Zod
schema** — validation, not an execution gate; Google `validateOnly` is the authoritative
backstop (critique §1#2, §2#8). `TRACKING_READY`, `BUDGET_SUFFICIENCY`, `RSA_CONTENT`-as-gate,
`runBlueprintGates`, `PARENT_RESOLVED`-as-gate — all cut.

## 7. Executor change — one edit (`executor.ts prepare()`)

Create-family action types (keyed on **actionType**, never on a `temp:` string prefix — a
data-driven trigger is reachable by any row and would skip the snapshot for a `pause` carrying
a temp ref, critique §2#3/§5#3) get a synthetic snapshot:
`before = { entityKind, entityRef, status:'UNKNOWN' }` instead of `adapter.snapshot()`.
Reject `temp:` refs on non-create action types. Google `validateOnly` still runs (buildMutation
for creates needs no `before`), keeping VALIDATE_ONLY meaningful. Note: `performWrite`'s
post-execute verification snapshots by the temp `entityRef` and will throw→swallow, leaving
`after=null` on create ledger rows (benign; the ledger's `resourceNames` + `rollback_recipe`
carry the truth — critique §5#6). `ExecOutcome` gains `resourceNames` so the runner threads
refs without a new column.

## 8. The runner (`src/lib/command/blueprint/{compile,plan-runner}.ts`)

- `compile(doc): CompiledAction[]` — **pure**, ~150 lines. Order: budget → campaign →
  ad_group → keywords/negatives → ad. Payloads use `tmp:<localRef>` for parent refs.
  `recKey = bp-<hash(blueprintId|seq)>` via the existing `recKeyFor` pattern.
- `executeBlueprint(blueprintId, actor, workspaceIds, deps)` — load actions by `seq`;
  **pre-check** plan size vs remaining daily quota; skip `status='executed'` (resume, a6
  pattern); for each: substitute `tmp:` refs from earlier siblings' `result_ref`
  (**placeholders-only invariant**, §2), persist resolved payload under the optimistic status
  guard, call v1 `executeAction`, stamp `result_ref = outcome.resourceNames[0]`; **stop on
  first failure** (resumable). Blueprint status tracks aggregate.
- `rollbackBlueprint(blueprintId, …)` — reverse-`seq` loop over v1 `rollbackAction`
  (children removed before parents so no rollback targets an already-cascade-removed resource).

## 9. AI layer — slice 1 = per-field ✨ only

- One route (`/api/command/blueprint/suggest`) using the **existing `callStructured()`**
  (`src/lib/llm/index.ts`) — a single forced structured call per field, no tool loop. Actions:
  **Sugerir** (name), **Generar** (keywords), **Escribir/Mejorar** (headlines/description).
- Field schemas derived from `RSA_SPEC` so an AI headline obeys the same ≤30 as a typed one.
- **Provenance, minimal:** an accepted AI value is flagged in the doc; on compile, any action
  whose payload contains an AI-accepted field gets `cc_actions.source = 'copiloto'` (existing
  `CcSource`; the Acciones "Origen" column renders it for free). No `ProvenanceMap` sidecar,
  no `applyBlueprintPatch` chokepoint yet (those arrive with the docked copilot, roadmap).
- Grounding: a shared advisory lint reusing `knowledge.ts` returns `GateResult`-shaped
  warnings shown as chips on both AI and manual values — **advisory only; enforcement stays in
  gates.ts** (lint chips must never render as "gates passed", critique §4d/§4e).
- Accept is **server-side re-validated** against the field schema under `getCommandAccess`
  (never trust client-supplied ops — critique §4b).

## 10. UI — the workbench, scoped to slice 1

New routes under `src/app/command/crear/` (inherit `/command/layout.tsx`, beta+admin gated):
- **The builder** (the mockup, approved): left **structure tree** (campaign → budget → ad
  group → ad → review, with checkmarks); **center** one plain-language step at a time
  (objetivo / presupuesto+puja / grupo+palabras clave / anuncio) with per-field **✨** buttons
  and live validators; **right** live SERP ad preview + running summary + "EN PAUSA" note.
- **Revisar y publicar**: renders **every compiled action's full payload grouped by tree
  node** (this per-node review is the *price* of one-click bulk approve and is a slice-1
  requirement, not optional — critique §4c), gates 12/12 + validateOnly, then "Publicar en
  pausa" → bulk-approve endpoint → runner. Bitácora shows the created tree + per-action rollback.
- Manual is the default; ✨ is always optional; the per-step Manual/AI *switch* and docked
  copilot are the next slice (the shell is built to accept them without rework).

## 11. Testing

`bun test src/lib/command`: `compile()` (ordering, tmp-ref wiring, recKey), the
placeholders-only resolution invariant (deep-equal-except-resolved), `buildRollback` for every
create → `remove_entity`, **`validate()` handles `remove_entity`** (the §5#1 stealth bug — its
own test), the three gate edits (PAUSED_ON_CREATE fail-closed; create_budget hits the caps),
the synthetic-before guard + `temp:`-ref rejection on non-create types, `rollbackBlueprint`
reverse order, the Zod schema rejecting a known-bad fixture, per-field suggest schema
conformance. Then `tsc`, production build, runtime smoke.

## 12. Reconciled decisions (frozen, from the critique)

One JSONB `doc` (typed tree, `nodeId`+`tempId` per node, integer version for future
stale-accept guard). Ref bookkeeping = `cc_actions.local_ref/result_ref` columns (not a map).
One executor guard keyed on actionType. One gate path (three edits). `create_budget` is its own
action (dissolves the two-calls-in-one-execute orphan risk, critique §2#5/§5#5). RSA limits live
once in `RSA_SPEC`. Frozen action names + `tmp:` convention.

## 13. Roadmap (each its own spec)

- **v2.2 — Meta Search/Leads create** on the identical compile/run/rollback machinery (new
  Zod shape + adapter create cases; note Meta has no validateOnly — PAUSED + rollback are the
  only net, so `buildRollback` never-null is doubly critical).
- **v2.3 — Edit mode**: `readTree()` loads a live snapshot into the same shell; a differ emits
  existing v1 types (`budget_update`/`pause`/`enable`/`add_negatives`) for changed fields +
  `create_*` for added children. (Do NOT claim DRIFT gives free concurrency safety — it
  compares only status + budget; ad edits are new-ad-and-pause-old, kept out until here.)
- **v2.4 — Docked copilot**: `propose_blueprint_patch` (propose-only, node-pinned) + the
  `applyBlueprintPatch` chokepoint + `ProvenanceMap` (`dato/ia/auto`) + per-step Manual/AI
  switch. Extract the copiloto tool-loop only when this second consumer exists.
- **v2.5 — Chat entry mode**; then assets/audiences, cross-account templates, policy pre-check.

## 14. Risks (carried from the critique, must-honor)

`validate()` must handle `remove_entity` or all create-rollbacks block (test it). The runner's
payload-resolution must be placeholders-only under the optimistic guard (the biggest hole).
Bulk-approve + AI-filled fields hollow out two-step unless the per-node review screen ships.
Google create needs budget-then-campaign as two actions (not two calls in one execute). RSA
`.length` ≤30 is approximate — validateOnly is the real check; say so in evidence strings.
Over-abstraction gravity: 7 widgets / fixed steps / one repeatable level (ad groups) for slice
1 — if Google Search fits in these limits the abstraction is *earned when Meta ships*, not
pre-built.
