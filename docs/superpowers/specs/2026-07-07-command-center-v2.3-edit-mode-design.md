# Command Center v2.3 — Edit Mode (slice 1) — Design Spec

Date: 2026-07-07 · Status: approved-for-planning (autonomous continuation, user: "continue with all")
Produced by: 3-lens adversarial design workflow (diff-correctness, YAGNI, operator-UX) + opus synthesis+critique.
Builds on: docs/superpowers/specs/2026-07-07-command-center-v2-design.md (§roadmap v2.3 sketch).

## Command Center v2.3 — Edit mode (slice 1) — FINAL MERGED DESIGN

**Thesis (from all three lenses, verified against code):** edit mode is a *second compiler* in front of the shipped machinery. It emits only existing verbs into `cc_actions` and rides the existing plan-runner loop above the single `executeAction` chokepoint. **Zero new action types. Zero DB migration. Zero edits to `gates.ts`, `executor.ts`, `plan-runner.ts`, or `types.ts`.** The rail is untouched; the differ/apply is a loop above it.

**YAGNI cuts I made against all three lenses:** (1) **Cut new-ad-group subtree creation** to v2.3.1 — see §h. This is the single biggest simplification: it removes ALL `tmp:` ref resolution from edit slice-1 (every create in the slice targets a REAL parent), so there is no intra-plan ref ordering to get right. (2) **Cut Lens-1's intra-plan `expected` projection engine** — replaced by field-scoped stamping (§c), which is simpler AND avoids a self-inflicted DRIFT block. (3) **Cut Lens-1's `/resume` endpoint and Lens-3's `kind` migration + non-SEARCH budget/status editing** — recovery is rollback-or-leave; discriminate in-doc; refuse non-SEARCH at load.

---

### (a) Edit surface for slice 1 (7 editable things)

| # | Edit | Verb emitted | Why in slice |
|---|------|--------------|--------------|
| 1 | Campaign daily budget | `budget_update` | #1 weekly op. **Read-only (fail-closed) if `campaign_budget.explicitly_shared=true`** — mutating a shared budget silently changes sibling campaigns. |
| 2 | Campaign status ENABLED↔PAUSED | `pause`/`enable` | Weekly. |
| 3 | Ad-group status ENABLED↔PAUSED | `pause`/`enable` (ad_group) | Weekly. Adapter+snapshot already cover ad_group (google.ts:150-152, 328-334). |
| 4 | Add campaign negatives (add-only) | `add_negatives` | Weekly hygiene. |
| 5 | Add keywords/negatives to an existing ad group (add-only) | `create_keywords`, **real** `adGroupRef` | Weekly, from search-term reports. Runner passes real refs through untouched. |
| 6 | Add a new RSA to an existing ad group | `create_ad`, **real** `adGroupRef` | Weekly-ish ad testing. |
| 7 | Refresh an existing RSA (RSAs are API-immutable) | `create_ad`(new, real `adGroupRef`) **then** `pause`(old ad); if old already PAUSED → create only | The headline reason v2.3 exists ("ad edits are new-ad-and-pause-old, kept out until here"). Needs the ONE adapter extension. |

**Read-only in slice 1 (greyed + locked with a Spanish reason), and WHY:**
- **Campaign/ad-group/ad names, bidding strategy, geo, language, ad-group CPC** — no `update_*` verb exists; each needs a new verb + its own gate story. Not weekly. A wrong geo edit is the worst failure mode in the system (google.ts:52-58).
- **Removing/pausing existing keywords/negatives, removing an ad without replacement** — the only delete verbs are `remove_entity`/`remove_negatives`, which are **internal-only** and deliberately bypass `ACTION_ALLOWED` (gates.ts:43-49, types.ts:7-13). Exposing them as user-proposable would let user deletions skip the settings allow-list. Documented operator workaround shown in-UI: to suppress a keyword, add it as an EXACT negative (#4/#5).
- **Shared budgets** — locked (see #1).
- **Non-RSA ads** (ETA/DSA) — shown flagged `unsupported`, never editable; still count toward "≥1 enabled ad".
- **Non-SEARCH campaigns** — `readTree()` throws at entry (fail-closed).
- **Standalone ad pause/enable** — `pause` on an ad exists ONLY as the system-emitted second half of an RSA replacement, so the differ can prove an ad-group's enabled-ad count never *decreases* from an edit.

### (b) `readTree()` + the edit doc

**Storage: reuse `cc_blueprints` rows, NO migration.** Discriminated by an in-doc field `docType: "google_search_edit_v1"`. One row per edit session, identical status lifecycle (`draft→approved→executing→executed|failed`), so the double-compile guard (repo.ts:142-154), bulk approve, and the execute/rollback routes are reused. `cc_actions.expected`/`blueprint_id`/`seq`/`local_ref`/`result_ref` already exist (schema.ts:633,644-647).

**New `GoogleSearchEditDoc` (NOT `CcBlueprintDoc`).** The create schema hard-codes `status: z.literal("PAUSED")`, `tempId` on every node, and min-counts a live campaign violates (schema.ts:29). Edit needs per-node `resourceName` + a frozen server-owned `base` + operator-owned `desired`/`new*`. **Reuse the workbench components, not the doc.** The shape *structurally encodes the edit surface* — you cannot express a removal, so removal is fail-closed by construction and the differ needs no list-diffing.

`src/lib/command/edit/schema.ts`:
```ts
export const EDIT_BASELINE_MAX_AGE_MS = 60 * 60_000; // 60 min
const match = z.enum(["EXACT","PHRASE","BROAD"]);
const kw = z.object({ text: z.string().min(1), match });
const newAd = z.object({ tempId: z.string(), finalUrl: z.string().url(),
  headlines: z.array(headline).min(RSA_SPEC.headline.min).max(RSA_SPEC.headline.max),
  descriptions: z.array(description).min(RSA_SPEC.description.min).max(RSA_SPEC.description.max),
  path1: z.string().optional(), path2: z.string().optional() }); // same RSA_SPEC as create

const existingAd = z.object({
  resourceName: z.string(),                     // customers/x/adGroupAds/g~a — FULL, used as pause entityRef
  unsupported: z.boolean().default(false),      // non-RSA → never editable
  base: z.object({ status: z.enum(["ENABLED","PAUSED"]), finalUrl: z.string().optional(),
    headlines: z.array(headline), descriptions: z.array(description), path1: z.string().optional(), path2: z.string().optional() }),
  replacement: newAd.nullable().default(null),  // set ⇒ RSA refresh (create new + pause old)
});
const existingAdGroup = z.object({
  resourceName: z.string(), id: z.string(),
  base: z.object({ name: z.string(), status: z.enum(["ENABLED","PAUSED"]) }),
  desired: z.object({ status: z.enum(["ENABLED","PAUSED"]) }),
  baseKeywords: z.array(kw.extend({ resourceName: z.string(), negative: z.boolean() })), // display-only
  newKeywords: z.array(kw.extend({ negative: z.boolean().default(false) })).default([]),
  ads: z.array(existingAd), newAds: z.array(newAd).default([]),
});
export const editDocSchema = z.object({
  docType: z.literal("google_search_edit_v1"), network: z.literal("google_ads"),
  accountRef: z.string(), loadedAt: z.string().datetime(),   // staleness stamp, SERVER-OWNED
  campaign: z.object({
    resourceName: z.string(), id: z.string(),
    base: z.object({ name: z.string(), status: z.enum(["ENABLED","PAUSED"]),
      dailyBudgetMicros: z.number().int(), budgetResourceName: z.string(),
      budgetShared: z.boolean(), currency: z.string().nullable() }),
    desired: z.object({ status: z.enum(["ENABLED","PAUSED"]),
      dailyBudgetMicros: z.number().int().min(MICROS_PER_UNIT) }),
    newNegatives: z.array(kw).default([]),
    adGroups: z.array(existingAdGroup),
  }),
});
export type GoogleSearchEditDoc = z.infer<typeof editDocSchema>;
export function mergeEditDoc(stored: GoogleSearchEditDoc, incoming: unknown): GoogleSearchEditDoc; // see below
```

**Server-owned baseline invariant (load-bearing for the DRIFT honesty guarantee):** `base`, `resourceName`s, `baseKeywords`, `unsupported`, `budgetShared`, `loadedAt` are written ONLY by `readTree()`. On doc-save, the route calls `mergeEditDoc(stored, incoming)` which copies ONLY `desired`/`replacement`/`new*` fields from the client, keyed by `resourceName`/`tempId`, and drops any client edit referencing a node absent from the stored doc. A client therefore can never rewrite the load-time baseline (which would silently refresh what `expected` is stamped against — the concurrency lie in §d).

**`readTree` — standalone export from the adapter (NOT added to `NetworkAdapter`; Meta edit is a later spec, and types.ts stays frozen).** 4 GAQL reads via the existing `gaql()` helper (google.ts:31-43):
1. `campaign.id, resource_name, name, status, advertising_channel_type, campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared, customer.currency_code WHERE campaign.id=X` — **throws if channel≠SEARCH or status=REMOVED**.
2. ad_groups (`status != REMOVED`).
3. ad_group_criterion keywords (`type=KEYWORD AND status != REMOVED`).
4. ad_group_ad + `ad.type` + RSA fields (`status != REMOVED`) — non-RSA rows become `unsupported:true`.

`src/lib/command/edit/read-tree.ts` maps the tree → `GoogleSearchEditDoc` with `desired = base`, all `new*` empty, `loadedAt = now`.

### (c) The differ — `src/lib/command/edit/diff.ts`, PURE, mirror of `compile()`

```ts
export interface EditCompiledAction {
  seq: number; localRef: string | null;             // only creates get a localRef
  actionType: CcInternalActionType;                 // v1 verbs + create_keywords/create_ad; NEVER remove_entity
  entityKind: CcEntityKind;
  entityRef: string;                                // numeric id (campaign/ad_group) · FULL adGroupAds resourceName (ad pause) · tmp:<localRef> (creates)
  payload: CcPayload;
  expected: Partial<EntitySnapshot> | null;         // field-scoped DRIFT baseline — see below
  entityName: string | null;                        // Bitácora label
  recKey: string;                                   // "ed-" + sha256(`${blueprintId}|${seq}`).slice(0,14)
  note: string;                                     // es-MX antes→después summary for review cards
}
export function diffEditDoc(doc: GoogleSearchEditDoc, blueprintId: string): EditCompiledAction[]; // no IO; throws on ambiguity
```

**Exact mapping table (NEW ACTION TYPES: NONE):**

| Edit detected | Emitted | entityKind / entityRef | payload | `expected` (field-scoped) |
|---|---|---|---|---|
| campaign `desired.status ≠ base.status` | `pause`/`enable` | campaign / `campaign.id` | `{}` | `{ status: base.status }` |
| campaign `desired.dailyBudgetMicros ≠ base` (and `!budgetShared`) | `budget_update` | campaign / `campaign.id` | `{ newDailyBudgetMicros }` | `{ dailyBudgetMicros: base.dailyBudgetMicros }` |
| `newNegatives.length > 0` | `add_negatives` | campaign / `campaign.id` | `{ negatives }` | `null` |
| ad-group `desired.status ≠ base.status` | `pause`/`enable` | ad_group / `group.id` | `{}` | `{ status: base.status }` |
| `group.newKeywords.length > 0` | `create_keywords` | ad_group / `tmp:kw:<group.id>` | `{ adGroupRef: group.resourceName /*REAL*/, keywords }` | `null` |
| `group.newAds[i]` (add RSA) | `create_ad` | ad / `tmp:<tempId>` | `{ adGroupRef: group.resourceName /*REAL*/, ...rsa }` | `null` |
| `ad.replacement` set, old `base.status=ENABLED` | `create_ad` **then** `pause` | create: ad/`tmp:<tempId>`; pause: ad/`ad.resourceName` (FULL) | create: real `adGroupRef`; pause: `{}` | create `null`; pause `{ status: "ENABLED" }` |
| `ad.replacement` set, old `base.status=PAUSED` | `create_ad` only | ad / `tmp:<tempId>` | real `adGroupRef` | `null` |
| **throws:** `desired.budget ≠ base` while `budgetShared`; `replacement` on an `unsupported` ad; duplicate tempId | — | — | — | — |

**Field-scoped `expected` (replaces Lens-1's projection engine).** Each v1 action stamps `expected` with ONLY the field it mutates: `budget_update`→`{dailyBudgetMicros}`, `pause`/`enable`→`{status}`, `add_negatives`/all creates→`null`. DRIFT compares only present fields (gates.ts:58,61), so a budget change and a status flip in the same plan never trip each other (the budget action ignores status; the status action ignores budget; an entity gets at most one status flip). This kills the intra-plan self-block Lens 1 solved with a projection engine, and adds no false negatives: `BUDGET_DELTA`/`ABS_BUDGET_CAP` still recompute against the LIVE `before` at execute (gates.ts:75,126).

**Ordering (deterministic, safety-motivated).** A. `pause` intents (campaign, then ad groups) — stop spend before restructuring. B. `budget_update`. C. `add_negatives`. D. per existing ad group in doc order: `create_keywords` → for each replacement `create_ad`(new) **immediately followed by** its paired `pause`(old) → plain `newAds`. E. `enable` intents LAST (ad groups, then campaign). Combined with the runner's stop-on-first-failure (plan-runner.ts:122-125): a failed `create_ad` means its paired `pause` never runs → **an ad-group's enabled-ad count can never decrease** from a failed replace; zero-enabled is unreachable unless the operator explicitly paused the group/campaign (phases A/E).

**Ref mixing / `tmp:`.** Because new-ad-group is deferred, **every create in slice-1 targets a REAL parent resourceName** (passed through by the runner untouched — plan-runner.ts:50-58). Creates still carry `entityRef = tmp:<localRef>` (so `prepare()` uses a synthetic before, executor.ts:57), but **nothing else consumes their `result_ref`** — there is no `tmp:` *resolution* dependency anywhere in the plan. The differ still asserts no non-create action carries a `tmp:` ref.

**recKey / idempotency.** `"ed-"+sha256(blueprintId|seq).slice(0,14)` (create uses `"bp-"`). Deterministic over the doc. Recompile-while-draft reuses the double-compile guard verbatim (repo.ts:142-154). Double-execute guarded by `executeAction`'s `status!=="approved"` check (executor.ts:131) + the blueprint `approved→executing` flip.

**Wiring.** `compileBlueprintToActions` (repo.ts:142) branches: if `doc.docType==="google_search_edit_v1"` → TTL check (`Date.now()-Date.parse(doc.loadedAt) > EDIT_BASELINE_MAX_AGE_MS` throws "Baseline caducado; recarga el árbol") → `editDocSchema.parse` → `diffEditDoc` → build rows that **also carry `expected` and `entityName`**. Everything else (guard, delete-first, workspace scoping, batch insert, approve) is shared; the create branch is byte-for-byte unchanged. Bulk `approveProposedActions` never touches `expected` (repo.ts:87-96), so **the differ-stamped load-time baseline survives approval** — deliberately unlike the v1 single-action approve route which re-snapshots (actions/[id]/approve/route.ts:27-28); for edit plans the baseline must be *what the operator reviewed at load*, not a silently refreshed approve-time value.

**The ONE adapter extension (NOT a new verb): `pause`/`enable`/`snapshot` for `entityKind:"ad"`, in google.ts only (~40 lines):**
1. `buildMutation` pause/enable (google.ts:147-154): `if (action.entityKind==="ad")` → `{ endpoint:"adGroupAds:mutate", body:{ operations:[{ updateMask:"status", update:{ resourceName: action.entityRef /*FULL customers/x/adGroupAds/g~a*/, status } }] } }`.
2. `snapshot()` (google.ts:327): `if (entityKind==="ad")` → `SELECT ad_group_ad.status FROM ad_group_ad WHERE ad_group_ad.resource_name='<entityRef>'` (today an ad ref falls into the campaign branch → `Number()`→NaN→GAQL error). Returns `{status}` so `prepare()` gives DRIFT a real `before.status`.
3. `buildRollback` pause↔enable (google.ts:412-415) is already kind-generic — works for ads free. `capabilities()` already lists `pause`/`enable` without a kind restriction and `CAPABILITY` checks type only (gates.ts:37) — no capability change. **These two branches get dedicated tests** (the §14 `remove_entity` lesson): an incomplete ad branch fails the pause-old half AFTER the new ad is live.

### (d) Staleness / concurrency, per edit kind (honest — no DRIFT lies)

DRIFT compares ONLY `status` + `dailyBudgetMicros` of the single entity each action targets (gates.ts:55-70) and **returns PASS when `expected` is null** (line 56). It is never general concurrency safety.

| Edit kind | DRIFT covers? | What actually protects it / residual gap |
|---|---|---|
| budget_update | **Yes** (`{dailyBudgetMicros}`) — blocks if the budget moved since load. | none for budget; a concurrent status flip is intentionally ignored |
| pause/enable (campaign, ad_group, ad) | **Yes** (`{status}`) — blocks if someone already flipped it (fail-closed → reload). | none for status |
| add_negatives | **NO** — `expected:null`; DRIFT sees campaign status/budget, not the criteria list. | `partialFailure:true` (google.ts:160) tolerates exact dupes; validateOnly backstops; semantic near-dupes land silently — stated in review UI |
| create_keywords / create_ad into existing parent | **NO** — `expected:null`, DRIFT auto-passes. | validateOnly rehearses each mutate; parent removed concurrently → mutate fails → plan stops (resumable via rollback/leave); duplicate keyword → Google error → blocked. NO structural drift detection |
| RSA replace — pause(old) | **Yes** (`{status:"ENABLED"}`) via the new ad-snapshot branch. Old ad removed concurrently → snapshot throws → pause fails, plan stops (new ad already live). | RSAs are immutable so content can't drift; transient pause failure = brief double-serving until rollback |

**Explicit non-claims (per roadmap §L249):** DRIFT does NOT protect keyword lists, ad lists, negatives, names, bidding, geo, or CPC, and gives creates ZERO staleness protection. The design relies on it for exactly `status`+`budget` and nothing else.

**TTL (the explicit belt to DRIFT's suspenders):** `compileBlueprintToActions`'s edit branch throws if the baseline is >60 min old. The workbench shows "Cargado hace N min" + a **Recargar** button that re-runs `readTree` (discards pending edits with a confirm dialog — merge-preserving reload is deferred).

### (e) Rollback, per edit kind (all existing recipes; `rollbackBlueprint` reverse-seq loop reused unchanged, plan-runner.ts:138-159)

| Forward | Rollback recipe (google.ts buildRollback) |
|---|---|
| budget_update | `budget_update` → `before.dailyBudgetMicros` (real snapshot exists; non-create path) |
| pause/enable (campaign, ad_group, ad) | inverse verb (google.ts:412-415, generic) |
| add_negatives | `remove_negatives(exec.resourceNames)` |
| create_keywords / create_ad | `remove_entity(exec.resourceNames)` — routes by segment (adGroupCriteria/adGroupAds), removes exactly what was created |
| RSA replace pair | reverse order = `enable`(old ad) then `remove_entity`(new ad): old restored, new gone; brief double-serving during the window, never zero enabled |

Honest caveats surfaced in Bitácora: rollback bypasses DRIFT by design (executor.ts:198-203) so it can clobber a third party's *later* change; and unlike create mode, edit rollback restores only the baseline of what this plan touched (action-by-action), never a cascade delete.

### (f) UI entry + flow (es-MX, `COMMAND_CENTER_BETA` + admin via existing `getCommandAccess`)

1. **Entry — `/command/cuentas`** (fed by `GET /api/command/campaigns`): each Google SEARCH row gains **"Editar"** → `POST /api/command/edit` → `router.push('/command/editar/<id>')`. Meta/non-SEARCH rows: no Editar.
2. **Workbench — `/command/editar/[id]/{page.tsx,editor-client.tsx}`**: same 3-pane shell as `crear` (reuse `builder-steps.tsx` field editors + `SerpPreview`). Left: LIVE tree with badges `en vivo`/`editado`/`nuevo`, "Cargado hace N min" + Recargar. Center: per-node editor — only §a-editable fields active, `base` values greyed; shared-budget and non-RSA nodes locked with the reason. Right: SERP preview + running diff counter ("3 cambios") + when the campaign is ENABLED an honesty badge "Editando una campaña ACTIVA — los cambios aplican de inmediato al publicar" (contrast with create's "todo nace en pausa"). Autosave PUTs `desired`/`new*` only.
3. **Review — `/command/editar/[id]/revisar`**: compile-in-memory (`diffEditDoc`) → per-node **Antes → Después** cards (one per emitted action, with its Spanish `note`) + the deterministic gate preview + blast-radius readout. RSA refresh labeled explicitly: "Google no permite editar anuncios publicados: se creará uno nuevo y se pausará el anterior." **"Aplicar cambios"** → existing `POST .../approve` then `.../execute`. Two-step preserved: every payload reviewed before approval.
4. Partial failure / DRIFT 409 render with plain-Spanish copy + "Recargar datos en vivo"; recovery choices = **Revertir lo aplicado** (rollback) or **Dejarlo así**. No resume in slice 1.

### (g) API surface

- **NEW `POST /api/command/edit`** `{network:'google_ads', connection_id, account_ref, campaign_id}` → resolve auth (as campaigns/route.ts:26-30) → `readCampaignTree` → `createBlueprint({doc: EditDoc, status:'draft', network, accountRef, connectionId, ...})` → `{id}`. Fail-closed 409s: non-SEARCH, removed, no read capability.
- **EXTEND `PUT /api/command/blueprint/[id]`** (doc-save): if incoming doc is an edit doc → validate with `editDocSchema` + apply `mergeEditDoc(stored, incoming)` before the existing `saveBlueprintDoc` (which is doc-agnostic, draft-only). GET compile-preview branch for the review screen.
- **EXTEND `compileBlueprintToActions`** (repo.ts): docType branch (TTL + `diffEditDoc` + rows carry `expected`/`entityName`).
- **EXTEND `blueprint/preview.ts`**: edit-doc branch (build `before` from `expected` so DRIFT preview reads correctly; keep VALIDATE_ONLY excluded as today).
- **REUSED VERBATIM:** `POST /api/command/blueprint/[id]/{approve,execute,rollback}` (doc-agnostic), bitácora reads, `GET /api/command/campaigns`.

### (h) Explicitly DEFERRED
- **New ad-group subtrees** (`create_ad_group` + children) — v2.3.1. Not weekly; heaviest UI (StepGrupo/StepAnuncio min-1-kw/min-1-ad); reintroduces `tmp:` ref resolution. "create_* for added children" is already delivered by #5/#6.
- Removing/pausing existing keywords, removing negatives, removing an ad without replacement — needs a user-facing remove verb (`remove_entity`/`remove_negatives` must stay internal-only). Workaround: exact-match negative.
- Editing existing keyword text/match, ad-group CPC, name/rename, bidding strategy, geo/language — needs an `update_*` verb family + new gates.
- Shared-budget editing; non-SEARCH structural (or budget/status) editing (refused at load in slice 1).
- Retry/resume of a partially-failed plan (recovery = rollback or leave); merge-preserving reload; multi-campaign bulk edit; copilot/AI patch in edit; sitelinks/assets/audiences; Meta edit mode.

### File-level plan
**NEW:** `src/lib/command/edit/schema.ts` (editDocSchema, mergeEditDoc, EDIT_BASELINE_MAX_AGE_MS) · `src/lib/command/edit/read-tree.ts` (tree→EditDoc) · `src/lib/command/edit/diff.ts` (diffEditDoc pure) · `src/app/api/command/edit/route.ts` · `src/app/command/editar/[id]/{page.tsx,editor-client.tsx,revisar/*}`.
**MODIFIED:** `src/lib/command/networks/google.ts` (export readCampaignTree; snapshot `ad` branch; buildMutation pause/enable `ad` branch) · `src/lib/command/blueprint/repo.ts` (compileBlueprintToActions docType branch + rows carry expected/entityName) · `src/app/api/command/blueprint/[id]/route.ts` (PUT edit-doc validation + mergeEditDoc; GET compile-preview branch) · `src/lib/command/blueprint/preview.ts` (edit branch) · `src/app/command/cuentas/cuentas-client.tsx` (Editar button).
**UNTOUCHED:** `types.ts`, `gates.ts`, `executor.ts`, `plan-runner.ts`, blueprint approve/execute/rollback routes. **No migration.**

### Tests (`bun test src/lib/command`)
Every diff mapping row incl. no-op→[] and the throw rows; field-scoped `expected` (budget+status in one plan don't cross-block); phase ordering + create-before-pause pairing; enabled-ad-count-never-decreases property; no non-create carries a tmp: ref; recKey determinism; **snapshot('ad') + buildMutation pause-ad + validate() pause-ad + buildRollback pause-ad→enable** (the stealth suite); mergeEditDoc rejects base tampering; shared-budget throw; TTL throw; `rollbackBlueprint` reverse order over a mixed edit plan. Then tsc + build + a runtime smoke.

### Adversarial self-critique (the four hunts)
**(1) Corruption / half-edit with no recovery.** Sharpest edge: RSA replace where `create_ad`(new) succeeds and `pause`(old) then fails — leaves BOTH ads enabled (double-serving), not corruption; recoverable by rollback (removes new, old stays) or leave. Partial-plan failure leaves a legitimately half-applied campaign (e.g. budget landed, ad swap blocked) — recovered by rollback-or-leave; runner stops on first failure so nothing cascades; no zero-enabled-ads state is reachable from a failed replace (create-fails ⇒ pause-never-runs). No path deletes a pre-existing entity (no user remove verb; rollback removes only `exec.resourceNames`). **(2) Rail invariants.** Every mutation still flows through `executeAction` + all 13 gates; the ad pause/enable wiring lives BELOW the chokepoint inside the adapter; two-step and fail-closed preserved; no new action type; types.ts/gates.ts/executor.ts/plan-runner.ts untouched. The one honest bend: the edit compile path stamps `expected` itself and bypasses the v1 approve-time re-snapshot — deliberate, so the baseline is load-time truth, and guarded by mergeEditDoc so the client can't launder it. **(3) Hidden complexity a smaller slice avoids.** Deferring new-ad-group removes ALL tmp: ref resolution and intra-plan ordering dependencies from slice-1; field-scoped `expected` removes the projection engine; in-doc discriminator removes a migration; rollback-or-leave removes a resume endpoint; refusing non-SEARCH removes conditional editability branching. **(4) Concurrency lies rejected:** "DRIFT protects the campaign" (it protects only one entity's status+budget), "creates are staleness-protected" (expected=null ⇒ DRIFT auto-passes; validateOnly is the only backstop), "add_negatives is DRIFT-covered because it targets the campaign" (the criteria list is invisible to DRIFT), and "reusing the execute route gives resume" (a failed blueprint can't re-execute — status must be 'approved'). All stated honestly in §d and the UI.

## New action types required
- (none — pure composition over existing verbs)

## Edit surface (slice 1)
- Campaign daily budget -> budget_update (read-only/locked when campaign_budget.explicitly_shared=true)
- Campaign status ENABLED<->PAUSED -> pause/enable (campaign)
- Ad-group status ENABLED<->PAUSED -> pause/enable (ad_group)
- Add campaign-level negative keywords, add-only -> add_negatives
- Add keywords/negatives to an existing ad group, add-only -> create_keywords with a REAL adGroupRef
- Add a new RSA to an existing ad group -> create_ad with a REAL adGroupRef
- Refresh an existing RSA (immutable in Google) -> create_ad(new, real adGroupRef) then pause(old ad by full resourceName); create-only if the old ad is already PAUSED

## Explicitly deferred
- New ad-group subtree creation (create_ad_group + create_keywords + create_ad) — v2.3.1; removing it eliminates ALL tmp: ref resolution from slice-1
- Removing or pausing existing keywords; removing existing negatives; removing/pausing an ad without a replacement (would require a user-facing remove verb — remove_entity/remove_negatives must stay internal-only because they bypass ACTION_ALLOWED; workaround: add an EXACT negative)
- Editing existing keyword text/match type
- Ad-group CPC bid edits; ad-group/campaign/ad rename
- Campaign bidding strategy, geo, language edits (need an update_* verb family + new gate story)
- Shared-budget editing (locked read-only with explanation)
- Non-SEARCH campaign editing (PMax/Display) — readTree refuses non-SEARCH in slice 1
- Retry/resume of a partially-failed edit plan (recovery = rollback or leave; no failed->approved resume endpoint)
- Merge-preserving reload after a baseline refresh (slice-1 reload discards pending edits with a confirm)
- Meta edit mode; multi-campaign bulk edit; copilot/AI patch ops in edit; sitelinks/assets/audiences editing

## Top risks (design-acknowledged)
- Incomplete/incorrect adapter 'ad' branch (snapshot/buildMutation pause-ad): the pause-old half runs AFTER the new ad is already created, so a broken branch leaves a double-serving half-edit; must have dedicated tests (the remove_entity/spec-§14 lesson) — this is the sharpest edge in the slice.
- Creates in edit mode carry expected=null, so DRIFT gives them ZERO staleness protection (gates.ts:56 returns pass). Structural concurrency (concurrent keyword/ad/negative changes by others) is caught ONLY by Google validateOnly + stop-on-first-failure, never by DRIFT — must be stated in the review UI, not implied away.
- RSA replace has a create-succeeds/pause-fails window = transient double-serving until rollback/retry; and any partial-plan failure leaves a legitimately half-applied LIVE campaign whose only recoveries are rollback-applied or leave-as-is (the shared execute route cannot re-execute a 'failed' blueprint — status must be 'approved').
- The load-time DRIFT baseline is only honest if base/loadedAt stay server-owned: mergeEditDoc must reject any client attempt to rewrite base/resourceName/loadedAt/budgetShared, otherwise the expected baseline is silently refreshed/laundered and the operator approves against something they never reviewed.
- Reusing cc_blueprints with an in-doc docType discriminator (no migration) means the blueprint list/other consumers must tolerate an unfamiliar doc shape; and compileBlueprintToActions now has a docType branch that, if it ever mis-detects, would run the wrong compiler — the branch must be an exact-literal check with the create path left byte-for-byte unchanged.
