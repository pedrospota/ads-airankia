# Command Center — Meta Edit Mode (última fase del full-POC)

**Fecha:** 2026-07-08 · **Base:** main @ 32519f5 (v1→v3.0 shipped)
**Objetivo:** editar campañas Meta existentes (pausar/activar campaign/adset/ad + cambiar presupuesto diario CBO/ABO) sobre la arquitectura de edición v2.3, con credenciales mock (token real dormante; sin token no hay baseline → error claro es-MX al crear la sesión, nunca datos simulados). **Cero migraciones, cero verbos nuevos.**

Diseño producido por panel de 3 lentes (architecture-reuse, meta-api-reality, ruthless-YAGNI) + síntesis adversarial verificada contra el código real (todas las citas file:line comprobadas).

---

# META EDIT MODE — FINAL MERGED DESIGN (synthesis + YAGNI verdicts, verified against /home/coder/projects/ads-airankia @ main 32519f5)

## 0. Adjudications where the three designs conflicted (each verified in code)

1. **snapshot() ad-field bug is REAL — yagni-slice overruled.** `src/lib/command/networks/meta.ts:297-301`: every non-adset entityKind (including `"ad"`) requests `fields=id,name,status,effective_status,daily_budget`. `daily_budget` is not a field on the Graph Ad node → Graph error #100 → `metaGet` throws (meta.ts:51) → `prepare()` throws before gates (executor.ts:70), killing every ad-level pause/enable, its rollback input, and its verify read. The per-kind fields fix is the ONE execute-path adapter change.
2. **Separate `/command/editar-meta/[id]` route — meta-api-reality's same-URL switch overruled.** `editar/[id]/page.tsx:16-18,26` `notFound()`s any non-`google_search_edit_v1` doc (a load-bearing fail-closed guard we keep), and `revisar/revisar-client.tsx:611-626` is typed `doc: GoogleSearchEditDoc` with `adByResourceName` mapping over `doc.campaign.adGroups` (:656-660) — both clients must be new anyway, and `cuentas-client.tsx` `startEdit` (:167-184) has the network in hand at POST time, so routing by network is trivial. Separate route leaves all 5 google editor files untouched.
3. **`edit/diff.ts` stays UNTOUCHED — meta-api-reality's export edit dropped.** `EditCompiledAction` is already exported (diff.ts:28); `recKey` (:41-49) is 8 lines and meta wants a `"me-"` prefix anyway → private local helper in meta-diff.ts.
4. **Copiloto: fail-closed with ZERO code changes — verified.** `patch/schema.ts:42` docKind enum is `["google_create","google_edit"]`; `copiloto/route.ts:279` computes `storedIsEdit` off the `google_search_edit_v1` literal, so against a meta-edit blueprint `google_edit` 400s (:280-283) and `google_create` 400s on `network !== "google_ads"` (:286-289). The meta editor simply never mounts CopilotoDock. Optional: one comment line on the enum. Third docKind deferred.
5. **No-token = clear es-MX 409 at session create, never mocked baselines — all three agree, confirmed honest.** v2.2 create drafting is client-authored; an edit doc IS its baseline, so without `META_SYSTEM_USER_TOKEN` there is nothing true to draft. `metaAdapter.capabilities()` already returns `{read:false, reason:"META_SYSTEM_USER_TOKEN no configurado (pendiente de credenciales)."}` (meta.ts:269-270); the edit route's read-gate (edit/route.ts:76-78) just needs to surface that `reason` instead of the generic "Sin acceso de lectura". No blueprint row is created. Everything still builds with mocked creds.
6. **Zero new verbs → ZERO migrations — validated hard.** `budget_update|pause|enable` are in the 008 CREATE TABLE default (`src/app/api/migrate/route.ts:584`), the ALTER defaults (:617, :624), the 010 cumulative default (:637-638), the Drizzle default (`src/lib/schema.ts:693`), and `CC_ACTION_TYPES` (`types.ts:23`). The 008/009/010 three-defaults lockstep is not touched.

---

## (a) Doc schema + TTL + merge — NEW `src/lib/command/edit/meta-schema.ts`

```
docType: z.literal("meta_edit_v1")        // docType-first dispatch, sibling of google_search_edit_v1
network: z.literal("meta_ads")
accountRef: z.string()                    // "act_<id>", server-owned, ∈ metaAccountRefs() at route
loadedAt: z.string().datetime()           // TOP-LEVEL (same slot as google doc → repo.ts TTL guard reads it via one shared code path)
campaign: {
  id: z.string(),                                              // numeric Graph node id — server-owned
  base:    { name, status: entityStatusSchema,                 // ENABLED|PAUSED, mapped from Graph CONFIGURED `status`
             effectiveStatus: z.string(),                      // raw Graph effective_status — server-owned, DISPLAY-ONLY, never diffed
             dailyBudgetMicros: int|null, lifetimeBudgetMicros: int|null,  // CBO ⇒ campaign daily non-null; ABO ⇒ null here, set on adsets
             currency: z.string().nullable() },
  desired: { status: entityStatusSchema, dailyBudgetMicros: int|null },   // the ONLY client-writable family
  adsets: [{ id, base { name, status, effectiveStatus, dailyBudgetMicros|null, lifetimeBudgetMicros|null,
                        learningPhase: "LEARNING"|"STABLE"|"LIMITED"|"UNKNOWN" },   // display/warn only (mapLearning convention, meta.ts:109-115)
             desired { status, dailyBudgetMicros|null },
             ads: [{ id, base { name, status, effectiveStatus }, desired { status } }] }]   // uniform base/desired at all 3 levels
}
```

superRefine (fail-closed, both directions): at campaign AND adset level, `desired.dailyBudgetMicros` must be null **iff** `base.dailyBudgetMicros` is null (no introducing a budget where Meta doesn't own one at that level; lifetime-budget nodes have daily null → budget-locked, the analog of the `budgetShared` throw at diff.ts:146-148). When non-null: `int`, `min(MICROS_PER_UNIT)` (matches CURRENCY_SANITY floor, gates.ts:142-147), and `% MICROS_PER_MINOR_UNIT === 0` (cent-aligned, so the adapter's `Math.round(micros / MICROS_PER_MINOR_UNIT)` write at meta.ts:180 is exact and `metaBudgetRoundMicros` (meta.ts:162-164) is an identity — DRIFT/verify can never see rounding skew).

**status source (adjudicated):** `base.status`/`desired.status` map from Graph configured `status` — the mutation writes configured status (meta.ts:185) and `snapshot()` maps `entity.status` (meta.ts:311), so DRIFT (`gates.ts:76-78`) compares like-for-like. Diffing on `effective_status` (values like `CAMPAIGN_PAUSED`, `WITH_ISSUES`) would emit unsatisfiable actions and false-block DRIFT. `effectiveStatus` rides along for UI badges only.

**TTL:** import `EDIT_BASELINE_MAX_AGE_MS` from `edit/schema.ts:5` (60 min) — never re-declared. **No `EDIT_BATCH_MAX` analog:** meta slice-1 has no batched verbs; every status flip / budget change is its own cc_action row, so BLAST_RADIUS's per-action daily counting (gates.ts:128-130) already bounds blast radius — the reason EDIT_BATCH_MAX exists (schema.ts:7-13, per-batch keyword arrays) does not apply.

**`mergeMetaEditDoc(stored: MetaEditDoc, incoming: unknown): MetaEditDoc`** — same two-layer pattern as `mergeEditDoc` (edit/schema.ts:144-229), ~60 lines because only one field family is lifted: (1) `metaEditDocSchema.parse(incoming)` (throw → 400); (2) rebuild FROM stored — docType/network/accountRef/loadedAt/all ids/all `base.*` from STORED; (3) lift only `desired` per row, matched by id, iterating STORED rows (unknown incoming ids structurally dropped; stored rows missing from incoming preserved as-is); (4) final `metaEditDocSchema.parse(result)` so the base-null⇔desired-null superRefine fires against **server truth**, not client-claimed base (the exact blast-bound pattern of schema.ts:224-229). Do NOT genericize `mergeEditDoc` — google lifts 8 field families, meta lifts 1; the shared thing is the pattern, not code.

## (b) Read tree + no-token behavior

**NEW export in `src/lib/command/networks/meta.ts`:** `readMetaCampaignTree(auth: AdapterAuth, accountRef: string, campaignId: string): Promise<RawMetaCampaignTree>` — the IO half (mirrors google.ts:571 `readCampaignTree`), reusing `metaGet`/`metaGetUrl` (appsecret_proof free, meta.ts:44-88). Four GETs:

1. `GET /{campaignId}?fields=id,name,status,effective_status,daily_budget,lifetime_budget,account_id` — **tenant bind:** `account_id` (bare digits) must equal `accountRef.replace(/^act_/,"")`, else throw es-MX "La campaña no pertenece a la cuenta seleccionada." (the meta analog of the google connection-tenant check at edit/route.ts:66-70 — campaign_id is client-supplied). Campaign status must map ENABLED|PAUSED; ARCHIVED/DELETED → throw "Campaña archivada/eliminada: no editable." (mirrors `requireEditableStatus`, edit/read-tree.ts:36).
2. `GET /{campaignId}/adsets?fields=id,name,status,effective_status,daily_budget,lifetime_budget,learning_stage_info&limit=200`
3. `GET /{campaignId}/ads?fields=id,name,status,effective_status,adset_id&limit=500` — grouped by `adset_id` in the mapper.
4. `GET /{accountRef}?fields=currency` — one field for `base.currency` (google-doc parity, edit/schema.ts:114).

Pagination: follow `paging.next` AT MOST once each via `metaGetUrl` (the listCampaignMetrics precedent, meta.ts:366-371); if a second `next` remains → throw es-MX "Campaña demasiado grande para el editor." Fail-closed beats a silently truncated baseline whose un-loaded ads drift invisibly. Adset/ad rows with status ∉ {ACTIVE, PAUSED} are FILTERED (leaves; mirrors the GAQL REMOVED exclusion); only the campaign throws.

**NEW pure mapper `src/lib/command/edit/meta-read-tree.ts`:** `buildMetaEditDoc(tree: RawMetaCampaignTree, accountRef: string, nowIso: string): MetaEditDoc` — no Date.now, nowIso injected (read-tree.ts:4 purity rule); budgets `Number(minorUnits) * MICROS_PER_MINOR_UNIT` (the listCampaigns conversion, meta.ts:291); statuses fail-closed mapped from configured `status`; `desired` seeded = `base`.

**No-token:** POST `/api/command/edit` meta branch checks `adapter.capabilities(auth).read` FIRST (route pattern at edit/route.ts:76-78) and 409s with `capabilities.reason` in the body — session create fails clearly, nothing drafted, no blueprint row. Cuentas UI can't normally reach it anyway (meta campaign rows require a successful `listCampaigns`, which needs the token; `metaWritable`/`metaReason` props already exist, cuentas-client.tsx:60-65, :223-224); the inline `editErrors` pattern (:78, :301-302) is the backstop. Execute-time CAPABILITY gate (gates.ts:48-53) remains the final net.

## (c) Differ — NEW `src/lib/command/edit/meta-diff.ts`

`diffMetaEditDoc(doc: MetaEditDoc, blueprintId: string): EditCompiledAction[]` — imports the `EditCompiledAction` **type** from `edit/diff.ts:28` (already exported); own private recKey helper: `"me-" + sha256(`${blueprintId}|${seq}`).slice(0,14)` (never collides with `"ed-"`). Pure: no Date/random/IO. ~120 lines.

Phases (safety property preserved: enabled delivery surface never grows before its container is ready; with the runner's stop-on-first-failure, a failed run never leaves more enabled than before):
- **A — pauses, broadest-first:** campaign → adsets → ads, when `desired.status===PAUSED && base.status===ENABLED`; `expected: {status:"ENABLED"}`.
- **B — budget_update:** campaign (CBO) then per-adset, when both non-null and `desired !== base`; `payload: {newDailyBudgetMicros}`, `expected: {dailyBudgetMicros: base}`; defense-in-depth throw if desired non-null while base null (schema already forbids; differ re-asserts, mirroring diff.ts:146). Note es-MX `«name»: antes → después` (fmtMicros convention, diff.ts:52-54).
- **E — enables, narrowest-first, LAST:** ads → adsets → campaign; `expected: {status:"PAUSED"}`.

Keep the 4-line tmp:-ref self-assert (diff.ts:358-363) even though edit emits no creates. `entityRef` = bare numeric Graph node id at every level — exactly what `buildMetaMutation` POSTs to (`/${action.entityRef}`, meta.ts:181,186) and `snapshot()` GETs. Level discriminator = `entityKind` ∈ campaign|adset|ad — all already in `CcEntityKind` (types.ts:5). `localRef` always null.

**Adapter verb audit (verified, meta.ts read end-to-end):**
- `buildMetaMutation` budget_update/pause/enable branches (meta.ts:178-186) are node-id-generic — one branch covers all three levels. **Zero new mutation branches.**
- `validate()` short-circuits v1 verbs `{ok:true, "sin ensayo"}` (meta.ts:325-327) — load-bearing for the rollback path (rollback hard-blockers include VALIDATE_ONLY, executor.ts:200-202); consistent with the gate's meta-non-create "No aplica" pass (gates.ts:170-172). Keep.
- `capabilities()` grants the three verbs on token alone (meta.ts:272). No change.
- Gates already meta-aware with zero changes: LEARNING_PHASE hard-blocks LEARNING-adset budget/enable (gates.ts:154-156); META_LEARNING_RESET warns >20% delta (gates.ts:198-209); BUDGET_DELTA/ABS_BUDGET_CAP/CURRENCY_SANITY are verb-keyed, network-agnostic.
- **The ONE adapter gap: per-entityKind snapshot fields** (meta.ts:297-301): `ad` → `id,name,status,effective_status` (no budget fields); `adset`/`campaign` unchanged. Minimal edit.

## (d) Dispatch seams — complete enumeration (meta-edit branch keyed `docType === "meta_edit_v1"`, and at every seam it must run BEFORE the `network === "meta_ads"` create branch, because a meta edit row satisfies the network check and would otherwise hit `parseMetaBlueprint` or the smuggle guard)

1. **`src/app/api/command/edit/route.ts`** — accept `network:"meta_ads"`: no `connection_id` (auth is the workspace env token; `auth.resolve` returns `{}` for non-google, executor-deps.ts:25); require `account_ref ∈ metaAccountRefs()` → 400 "Cuenta Meta no permitida (META_AD_ACCOUNT_IDS)."; `campaign_id` stays `CAMPAIGN_ID_RE` (:31); `capabilities.read` → 409 carrying `capabilities.reason`; `readMetaCampaignTree` domain throws → 409 (the :80-87 pattern); `buildMetaEditDoc` → `createBlueprint({network:"meta_ads", connectionId:null, accountRef, doc, status:"draft"})`.
2. **`src/lib/command/blueprint/repo.ts` `compileBlueprintToActions`** — widen the edit predicate (:161) to both docType literals; the TTL guard (:163-166) reads top-level `loadedAt` and is SHARED unchanged, preserving TTL-before-delete ordering (:169-175); inside the edit block dispatch by literal: meta → `parseMetaEditDoc` + `diffMetaEditDoc`, rows `connectionId: null`, `source: "manual"` always (no `_ai` for meta, matching the :211-230 meta-create convention), throw "No hay cambios que aplicar." on empty. Runs before the `network === "meta_ads"` branch (:211) structurally (early return).
3. **`src/app/api/command/blueprint/[id]/route.ts`** — GET: meta-edit docType branch (`diffMetaEditDoc(parseMetaEditDoc(doc), id)`) before the meta network branch (:35). PUT: meta-edit branch (`mergeMetaEditDoc` + draft-status check + save merged, NO `attachProvenance`) BEFORE the meta-create branch (:103) — **critical**: that branch's docType-smuggle guard (:107-109) would otherwise 400 every legitimate meta-edit save (whose body rightfully carries `docType:"meta_edit_v1"`), while the guard must keep protecting meta CREATE docs.
4. **`src/lib/command/blueprint/preview.ts` `previewBlueprintGates`** — meta-edit docType branch before :167: `diffMetaEditDoc`; every GateInput gets `network:"meta_ads"`; synthetic before seeded from `action.expected` (the google-edit pattern at :132-135, NOT the create branches' bare UNKNOWN — BUDGET_DELTA/META_LEARNING_RESET need the prior budget); new `SYNTHETIC_CAPABILITIES_META_EDIT = { read:true, write:true, actionTypes:["budget_update","pause","enable"] }` (distinct constant, same rationale as :77-97).
5. **Copiloto / WRITABLE_FIELDS — NO code change** (adjudication #4). Meta editor never mounts CopilotoDock; optional comment on `patch/schema.ts:42`.
6. **UI — NEW `/command/editar-meta/[id]/{page.tsx, meta-editor-client.tsx}` + `/revisar/{page.tsx, meta-revisar-client.tsx}`** (adjudication #2). Page guards `docType === "meta_edit_v1"` else `notFound()` (mirror of editar page :26 — mutual exclusion between editors is a security property). Editor client ~300 lines: campaign card + adset rows + ad status toggles; budget input rendered only where `base.dailyBudgetMicros` non-null (cent-quantized); "en aprendizaje" badge from `base.learningPhase`; debounced PUT-whole-doc autosave (server merges); reload-recreates-session pattern. Revisar: server page parse → diff → `previewBlueprintGates` → `baselineStale`; slim client reusing the network-agnostic approve/execute/rollback endpoints and copying revisar-client's publish/rollback state machine without the GoogleSearchEditDoc coupling. **`cuentas-client.tsx`**: `startEdit` (:167-184) branches — meta: POST `{network:"meta_ads", account_ref, campaign_id}` (no connection_id) → `router.push(`/command/editar-meta/${id}`)`; button rendered/enabled for meta rows only when `metaWritable`.
7. **`/api/command/blueprint` POST — UNTOUCHED:** its docType rejection (route.ts:51-53) already forces all edit sessions (google and meta) through `/api/command/edit`.

## (e) Rollback semantics — verified, zero adapter rollback changes

The chokepoint already does it: `prepare()` takes a real before-snapshot for non-create verbs (executor.ts:66-71); `performWrite` persists `buildRollback`'s recipe on the done ledger row (executor.ts:112-116). `metaAdapter.buildRollback` (meta.ts:381-391) covers slice-1: `budget_update` → budget_update back to `beforeSnap.dailyBudgetMicros` (null before → null recipe, same degrade as google); `pause` ↔ `enable` (self-inverse; snapshot's status is configured status — exactly what the inverse verb restores). Before-budgets come back minor-units × MICROS_PER_MINOR_UNIT so the restore is cent-aligned and round-trips exactly through the Math.round division. Rollback's hard-blocker filter (executor.ts:200-202: KILL_SWITCH/CAPABILITY/CURRENCY_SANITY/VALIDATE_ONLY) lets these run even if un-allow-listed; VALIDATE_ONLY passes for meta v1 verbs ("No aplica"). **Precondition:** the per-kind snapshot fix (gap #1) — without it, ad-level actions die in `prepare()` before any of this. v2.6 verify sweep works unchanged: meta budgets compare via `metaBudgetRoundMicros` (verify.ts:113-115) and null actual → "unverifiable", never drift (verify.ts:118-122).

## (f) Slice-1 vs deferred

**Slice-1:** pause/enable at campaign + adset + ad (ad level rides the identical verb/snapshot/rollback path — ~15 differ lines + one toggle); daily `budget_update` at campaign (CBO) or adset (ABO), whichever level the live account exposes.

**Deferred:** creative/copy edits (object_story_spec surface, META_PAGE_ID-gated); targeting edits; name renames; lifetime-budget editing (locked, status still editable); introducing a budget where base is null (CBO↔ABO moves) — superRefine fail-closes; bid_amount/bid_strategy; creating adsets/ads inside the edit doc (no tmp: machinery); copiloto `meta_edit` docKind (fail-closed via existing enum, zero code); EDIT_BATCH_MAX analog (per-action BLAST_RADIUS suffices); pagination beyond one `paging.next` (fail-closed throw); validate_only rehearsal for meta update verbs (keeps the rollback-safe short-circuit); adset-level budget drift enrichment in the verify sweep.

## (g) File plan

**NEW:** `src/lib/command/edit/meta-schema.ts` (schema + `parseMetaEditDoc` + `mergeMetaEditDoc`) · `src/lib/command/edit/meta-read-tree.ts` (`buildMetaEditDoc`) · `src/lib/command/edit/meta-diff.ts` (`diffMetaEditDoc`) · `src/app/command/editar-meta/[id]/page.tsx` + `meta-editor-client.tsx` · `src/app/command/editar-meta/[id]/revisar/page.tsx` + `meta-revisar-client.tsx` · tests `src/lib/command/__tests__/{meta-edit-schema,meta-edit-diff,meta-read-tree}.test.ts`.

**MODIFIED:** `src/lib/command/networks/meta.ts` (per-kind snapshot fields :297-301 + `readMetaCampaignTree`) · `src/app/api/command/edit/route.ts` · `src/lib/command/blueprint/repo.ts` · `src/app/api/command/blueprint/[id]/route.ts` · `src/lib/command/blueprint/preview.ts` · `src/app/command/cuentas/cuentas-client.tsx`.

**UNTOUCHED (load-bearing):** `src/app/api/migrate/route.ts` + `src/lib/schema.ts` (**zero migrations**) · `types.ts` · `gates.ts` · `executor.ts` · `executor-deps.ts` · `verify.ts` · `settings.ts` · `patch/*` + `copiloto/route.ts` · `edit/schema.ts` (imports its exported TTL const only) · `edit/diff.ts` (imports `EditCompiledAction` type only) · `edit/read-tree.ts` · `blueprint/meta-schema.ts` + `meta-compile.ts` · `networks/google.ts` · all `/command/editar/[id]/*` google pages · `/api/command/blueprint` POST.

## (h) Risks-to-pin-with-tests

1. **Dispatch ordering:** a `meta_edit_v1` blueprint has `network="meta_ads"` — in repo.ts/preview.ts/[id]-GET the docType check must precede the meta-create branch or the doc hits `parseMetaBlueprint` and 500s. Pin: compile/preview/GET tests on a meta-edit doc asserting differ rows, plus regression tests that a google edit doc and a meta CREATE doc still route exactly as before.
2. **PUT smuggle-guard collision:** meta-edit save with `docType:"meta_edit_v1"` succeeds (branch before :103); meta CREATE save with a smuggled docType still 400s (:107).
3. **Merge spoofing / blast-radius:** client flipping `base.*`, ids, `loadedAt`, `accountRef`, or injecting unknown adset/ad ids → all preserved-from-stored/dropped; final re-parse rejects a lifted desired budget on a base-null node (server-truth superRefine, schema.ts:224-229 pattern). The doc can never mutate an entity the server didn't load.
4. **status vs effective_status:** `buildMetaEditDoc` bases on configured `status` (adset ACTIVE with effective CAMPAIGN_PAUSED diffs as ENABLED); gate test that DRIFT passes when configured status matches while effective diverges.
5. **Cent alignment:** schema rejects `micros % MICROS_PER_MINOR_UNIT !== 0`, so the adapter's Math.round write (meta.ts:180) is exact and equals `metaBudgetRoundMicros` — no editor-introduced verify drift.
6. **Ad-kind snapshot regression:** fetch-mocked test that `snapshot("ad", ...)` requests NO budget fields and `snapshot("adset", ...)` still returns dailyBudgetMicros + learningPhase.
7. **Differ safety:** pauses broadest-first → budgets → enables narrowest-first LAST; no emission when desired===base, base budget null, or lifetime-budget node; deterministic `"me-"` recKeys; throw on budget-where-base-null.
8. **No-token honesty:** POST edit `{network:"meta_ads"}` without token → 409 carrying the credential reason, NO blueprint row persisted; `account_ref ∉ metaAccountRefs()` → 400; cross-account campaign (`account_id ≠ accountRef`) → 409 tenant-bind throw.
9. **TTL:** stale `loadedAt` (>60 min) refuses meta-edit compile BEFORE deleting existing proposed actions (repo.ts:163-175 ordering invariant).
10. **Truncated baseline:** paged-fetch mock — a tree exceeding one `paging.next` follow throws at read time, never yields a partial doc.
11. **Zero-migration guard:** assert `budget_update|pause|enable ∈` the cc_settings defaults (migrate route.ts:584/:637-638, schema.ts:693) so a future default change can't silently brick meta edit.
12. **LEARNING_PHASE preview-vs-execute divergence:** preview's synthetic before has no learningPhase (passes); execute-time snapshot may reveal LEARNING and hard-block adset budget/enable (gates.ts:154-156) — acceptable, pin with a documenting test so "gates N/N" on the review screen isn't read as a guarantee.
