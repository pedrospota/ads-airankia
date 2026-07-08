# Command Center v2.2 — Meta Create Flow (slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Create a full Meta campaign (campaign → ad set → link ads) through the existing blueprint→compile→runner→executeAction rail, born PAUSED, built entirely with mocked credentials and failing closed in production until `META_SYSTEM_USER_TOKEN`/`META_APP_SECRET`/`META_PAGE_ID` exist.

**Architecture:** ONE new action type (`create_adset`); `create_campaign`/`create_ad` reused with Meta-variant payloads (safe: `adapterFor(row.network)` dispatches per network); new `meta-schema.ts` + `meta-compile.ts` beside the Google ones; `meta.ts` gains a `buildMetaMutation` single source of truth + real `execution_options=["validate_only"]` rehearsal + DELETE rollback; cents exist ONLY inside `meta.ts` (`microsToCents` is the single cents-producing function — the rail speaks micros end-to-end); lean parallel form at `/command/crear-meta` reusing the network-agnostic review/publish pipeline.

**Tech Stack:** Next.js 16.2.2, TypeScript 5, Zod, Drizzle+pg, Meta Graph API v25.0 (ALL mocked in tests), bun test.

**Spec:** `docs/superpowers/specs/2026-07-08-command-center-v2.2-meta-create-design.md` (READ FIRST — §b vocabulary touchpoints, §d adapter contract, §g gates table are binding; the first-live-run checklist lists every mocked assumption).

## Global Constraints

- Branch `feat/command-center-v22-meta` off main (9f731a4). NEVER push. Commit per task. bun `~/.bun/bin/bun`; tests `~/.bun/bin/bun test src/lib/command`; typecheck `~/.local/bin/bunx tsc --noEmit`.
- **ONE new action type: `create_adset`.** The differ/compiler emits only `create_campaign`, `create_adset`, `create_ad` (+ internal `remove_entity` for rollback). Meta payload interfaces are DISTINCT from Google's (`MetaCreateCampaignPayload` etc.).
- **Money:** the rail (doc, payloads, gates, ledger, snapshots) is ALWAYS micros. Meta bills in account-currency CENTS. `microsToCents()` inside `meta.ts` is the ONLY cents-producing function; it THROWS on non-integer, ≤0, or non-multiple-of-`MICROS_PER_MINOR_UNIT` input. Builder produces whole-cent micros; schema enforces `.multipleOf(MICROS_PER_MINOR_UNIT)` and `.min(MICROS_PER_UNIT)`.
- **Fail-closed without credentials:** `capabilities()` → no token = `write:false` (v1 unchanged); token but missing `META_PAGE_ID`/`META_APP_SECRET` = create types WITHHELD. `VALIDATE_ONLY` gate fails closed on Meta creates lacking a rehearsal result.
- **PAUSED fail-closed:** campaign AND adset payloads carry literal `status:"PAUSED"` (gate-enforced by extended `PAUSED_ON_CREATE`); ads are `ACTIVE` (parents gate delivery — same as shipped Google `create_ad`).
- **validate() must be TOTAL** (never throws) and short-circuit `remove_entity`/v1 verbs with `{ok:true}` — a throwing validate strands every create-rollback (`rollbackAction` calls `prepare()` outside try/catch).
- Statuses at Meta: our `PAUSED`→`PAUSED`, our enable→`ACTIVE` (existing `mapStatus`). Country enum slice-1: `MX,US,AR,CO,CL,PE` (non-EU, no DSA fields). `special_ad_categories` ALWAYS sent as `"[]"`.
- All Graph API calls in tests are MOCKED fetch (mirror `google-adapter.test.ts` / metaGet/metaPost shapes). UI es-MX; routes `runtime="nodejs"`, `dynamic="force-dynamic"`, `getCommandAccess()`, `await params`. Never `git add -A` (explicit paths only).
- v1 signature facts (verified): `meta.ts` has `metaGet/metaPost` (URLSearchParams form-encoding + `appsecret_proof`), `metaAccountRefs()`, `MICROS_PER_MINOR_UNIT` imported from types; v1 execute cases budget_update/pause/enable move UNCHANGED into `buildMetaMutation`; `budget_update`'s existing `Math.round(micros / MICROS_PER_MINOR_UNIT)` stays as-is (deliberate v1 behavior). `CompiledAction` type + `tmp()`/`recKey()` live in `blueprint/compile.ts` (export them). `executor.ts:51` `CREATE_ACTION_TYPES`, `executor.ts:74-77` google-only validate condition, `gates.ts` helpers per the v2.2 spec §g table.

---

### Task 1: Vocabulary + executor + migration 009

**Files:**
- Modify: `src/lib/command/types.ts`, `src/lib/command/executor.ts`, `src/app/api/migrate/route.ts`
- Test: `src/lib/command/__tests__/settings.test.ts` + `executor.test.ts` (extend)

**Interfaces:**
- Produces: `CcCreateActionType` += `"create_adset"`; `CC_SETTINGS_ACTION_TYPES` += `"create_adset"`; payload interfaces `MetaCreateCampaignPayload`/`MetaCreateAdsetPayload`/`MetaCreateAdPayload` (spec §b, copy verbatim) added to `CcPayload` union; executor `CREATE_ACTION_TYPES` += `"create_adset"`; executor validate condition drops the google-only guard (`row.network === "google_ads" && adapter.validate` → `adapter.validate`); migration block `009_command_center_v2_2`.

- [ ] **Step 1: Failing tests.** In `settings.test.ts`: `rowToSettings({allowedActionTypes:[...v1, ...googleCreates, "create_adset"]})` keeps `create_adset`; `rowToSettings(null)` defaults include it; `runGates` `ACTION_ALLOWED` passes a `create_adset` action under default settings (mirror the existing create_campaign end-to-end assertion). In `executor.test.ts`: a `create_adset` action with `entityRef:"tmp:as:1"` uses a synthetic before (snapshot NOT called) and executes ok (mirror the existing create-budget synthetic-before test).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** types.ts: extend `CcCreateActionType` union; add the 3 interfaces after the Google payloads (spec §b block verbatim — note `dailyBudgetMicros: number` on the adset, refs are `CcRef`); extend `CcPayload`; `CC_SETTINGS_ACTION_TYPES` gains `"create_adset"` (defaults flow automatically). executor.ts: add `"create_adset"` to `CREATE_ACTION_TYPES`; change the validate condition at ~74-77 from `row.network === "google_ads" && adapter.validate && capabilities.write` to `adapter.validate && capabilities.write` (dispatch is already per-adapter). migrate route: append the 009 block after 008's INSERT, inside the array:
```ts
    // 009_command_center_v2_2 — Meta create flow: create_adset joins the allow-list.
    sql`UPDATE cc_settings SET allowed_action_types = allowed_action_types || '["create_adset"]'::jsonb
      WHERE NOT (allowed_action_types ? 'create_adset')`,
    sql`ALTER TABLE cc_settings ALTER COLUMN allowed_action_types SET DEFAULT
      '["budget_update","pause","enable","add_negatives","create_budget","create_campaign","create_ad_group","create_keywords","create_ad","create_adset"]'::jsonb`,
    sql`INSERT INTO schema_migrations (version) VALUES ('009_command_center_v2_2') ON CONFLICT (version) DO NOTHING`,
```
Also update the `cc_settings` CREATE TABLE column default in the same file AND `src/lib/schema.ts`'s `allowedActionTypes` `.default([...])` to include `create_adset` (the v2 final-review lesson: stale column defaults re-introduce the blocked-creates bug class).
- [ ] **Step 4: Run → pass** (`~/.bun/bin/bun test src/lib/command`); `~/.local/bin/bunx tsc --noEmit` exit 0. NOTE: dropping the google-only validate guard means Meta actions now call `adapter.validate` IF the meta adapter has one — it does NOT yet (Task 5 adds it); `adapter.validate &&` short-circuits on undefined, so v1 Meta behavior is unchanged this task. Confirm the existing meta/executor tests stay green.
- [ ] **Step 5: Commit** `git add src/lib/command/types.ts src/lib/command/executor.ts src/app/api/migrate/route.ts src/lib/schema.ts src/lib/command/__tests__/settings.test.ts src/lib/command/__tests__/executor.test.ts && git commit -m "feat(v2.2): create_adset vocabulary + executor coverage + migration 009"`

---

### Task 2: Gate extensions — adset budget caps, PAUSED_ON_CREATE, VALIDATE_ONLY meta branch

**Files:**
- Modify: `src/lib/command/gates.ts`
- Test: `src/lib/command/__tests__/gates.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `create_adset` + `MetaCreateAdsetPayload`.
- Produces: `budgetMicros()` reads `create_adset.dailyBudgetMicros`; `CURRENCY_SANITY`/`ABS_BUDGET_CAP` `isBudget` includes `create_adset`; `PAUSED_ON_CREATE` covers `create_campaign` AND `create_adset`; `VALIDATE_ONLY` requires a rehearsal for meta creates (`network==="meta_ads" && CREATE_FAMILY.has(actionType)`) and passes "No aplica" for meta v1 verbs + `remove_entity`; google branch byte-identical.

- [ ] **Step 1: Failing tests** (extend gates.test.ts with a meta `baseInput` variant `network:"meta_ads"`):
```ts
  it("ABS_BUDGET_CAP + CURRENCY_SANITY apply to create_adset.dailyBudgetMicros", () => {
    const over = runGates(metaInput({ settings: { ...defaults, maxDailyBudgetMicros: 50_000_000 },
      action: { actionType: "create_adset", entityKind: "adset", entityRef: "tmp:as:1",
        payload: { name: "A", status: "PAUSED", campaignRef: "tmp:c:1", dailyBudgetMicros: 60_000_000,
          optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", bidStrategy: "LOWEST_COST_WITHOUT_CAP",
          targeting: { countryCodes: ["MX"], ageMin: 18, ageMax: 65 } } as never } }));
    expect(blockingFailures(over).map(r => r.id)).toContain("ABS_BUDGET_CAP");
  });
  it("THE 100x TRIPWIRE: a cents value smuggled as micros (3500) fails CURRENCY_SANITY", () => {
    const rs = runGates(metaInput({ action: { actionType: "create_adset", entityKind: "adset", entityRef: "tmp:as:1",
      payload: { /* …same shape… */ dailyBudgetMicros: 3500 } as never } }));
    expect(blockingFailures(rs).map(r => r.id)).toContain("CURRENCY_SANITY");
  });
  it("PAUSED_ON_CREATE blocks a non-PAUSED create_adset and passes PAUSED", () => { /* mirror create_campaign tests */ });
  it("VALIDATE_ONLY: meta create without validateResult fails closed; meta v1 pause passes No-aplica; meta remove_entity passes", () => { /* three asserts */ });
  it("VALIDATE_ONLY: google behavior byte-identical (existing tests still green)", () => { /* keep existing */ });
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** per spec §g: `budgetMicros()` adds `actionType==="create_adset" → (payload as {dailyBudgetMicros?:unknown}).dailyBudgetMicros`; the two budget gates' `isBudget` adds `create_adset`; `pausedOnCreate` condition becomes `actionType === "create_campaign" || actionType === "create_adset"` (same fail-closed status check); `validateOnly` becomes:
```ts
const CREATE_FAMILY = new Set(["create_campaign", "create_adset", "create_ad"]);
const validateOnly: Gate = (i) => {
  const requires = i.network === "google_ads" || (i.network === "meta_ads" && CREATE_FAMILY.has(i.action.actionType));
  if (!requires) return gate("VALIDATE_ONLY", "blocking", true, "No aplica.");
  if (!i.validateResult) return gate("VALIDATE_ONLY", "blocking", false, "Sin ensayo validate; requerido.");
  return gate("VALIDATE_ONLY", "blocking", i.validateResult.ok, i.validateResult.detail ?? (i.validateResult.ok ? "Ensayo OK." : "Ensayo falló."));
};
```
ADAPT to the real current `validateOnly` body (read it first — keep its exact google semantics; only ADD the meta-create requirement and keep the no-aplica fallthrough for everything else).
- [ ] **Step 4: Run → pass**; whole suite green; tsc exit 0.
- [ ] **Step 5: Commit** `git add src/lib/command/gates.ts src/lib/command/__tests__/gates.test.ts && git commit -m "feat(v2.2): gates — adset budget caps + PAUSED_ON_CREATE(adset) + VALIDATE_ONLY meta rehearsal"`

---

### Task 3: META_LINK_AD_SPEC + Meta blueprint schema

**Files:**
- Modify: `src/lib/command/knowledge.ts` (append `META_LINK_AD_SPEC`)
- Create: `src/lib/command/blueprint/meta-schema.ts`
- Test: `src/lib/command/__tests__/meta-schema.test.ts`

**Interfaces:**
- Produces: `META_LINK_AD_SPEC = { message: { maxLen: 125 }, headline: { maxLen: 40 }, description: { maxLen: 30 } } as const` (Meta link-ad recommended display limits — knowledge.ts style, mirrors RSA_SPEC); `metaBlueprintDocSchema`, `CcMetaBlueprintDoc`, `parseMetaBlueprint(doc)` (Zod `.parse`, throws). Schema per spec §c (READ the spec block at `docs/superpowers/specs/2026-07-08-command-center-v2.2-meta-create-design.md` lines 60-102 and implement verbatim): `network: z.literal("meta_ads")`, campaign `{nodeId,tempId,name,objective:z.literal("OUTCOME_TRAFFIC"),status:z.literal("PAUSED")}`, `adsets: z.array(...).length(1)` with `{nodeId,tempId,name,status:z.literal("PAUSED"), dailyBudgetMicros: z.number().int().min(MICROS_PER_UNIT).multipleOf(MICROS_PER_MINOR_UNIT), targeting:{countryCodes: z.array(z.enum(["MX","US","AR","CO","CL","PE"])).min(1), ageMin: z.number().int().min(18).max(65), ageMax: ...}.refine(ageMin<=ageMax)}`, `ads: z.array({nodeId,tempId,name,link:z.string().url(),message(≤125),headline?(≤40),description?(≤30),callToActionType? enum,imageUrl? https url}).min(1)`.

- [ ] **Step 1: Failing tests** — valid doc parses; wrong network literal rejects; non-PAUSED campaign/adset rejects; cents-as-micros budget (3500) rejects (min); non-whole-cent micros (35_000_001) rejects (multipleOf); EU country ("ES") rejects; ageMin>ageMax rejects; message > 125 rejects; http (non-https) imageUrl rejects; zero ads rejects; two adsets rejects (length 1).
- [ ] **Step 2: Run → fail.** **Step 3: Implement** (knowledge constant + schema). **Step 4: Run → pass**; tsc 0.
- [ ] **Step 5: Commit** `git add src/lib/command/knowledge.ts src/lib/command/blueprint/meta-schema.ts src/lib/command/__tests__/meta-schema.test.ts && git commit -m "feat(v2.2): META_LINK_AD_SPEC + Meta blueprint Zod schema (micros-only, PAUSED literals)"`

---

### Task 4: compileMeta — pure compiler

**Files:**
- Modify: `src/lib/command/blueprint/compile.ts` (EXPORT the existing `tmp` and `recKey` helpers — no behavior change)
- Create: `src/lib/command/blueprint/meta-compile.ts`
- Test: `src/lib/command/__tests__/meta-compile.test.ts`

**Interfaces:**
- Consumes: `CcMetaBlueprintDoc` (Task 3), `CompiledAction` type + exported `tmp`/`recKey` from `compile.ts`, Meta payload interfaces (Task 1).
- Produces: `compileMeta(doc: CcMetaBlueprintDoc, blueprintId: string): CompiledAction[]` — pure/deterministic (no Date/random/IO). Emission order per spec §c: seq 0 `create_campaign` (entityKind "campaign", entityRef `tmp(campaign.tempId)`, localRef campaign.tempId, `MetaCreateCampaignPayload{name,status:"PAUSED",objective:"OUTCOME_TRAFFIC",buyingType:"AUCTION",specialAdCategories:[]}`); seq 1 `create_adset` (entityKind "adset", `MetaCreateAdsetPayload{...,campaignRef: tmp(campaign.tempId), dailyBudgetMicros, optimizationGoal:"LINK_CLICKS", billingEvent:"IMPRESSIONS", bidStrategy:"LOWEST_COST_WITHOUT_CAP", targeting:{countryCodes,ageMin,ageMax}}`); seq 2+ one `create_ad` per ad (entityKind "ad", `MetaCreateAdPayload{...,status:"ACTIVE", adsetRef: tmp(adset.tempId), creative:{link,message,headline?,description?,callToActionType?,imageUrl?}}`). recKey via the SAME exported `recKey(blueprintId, seq)` ("bp-" prefix — same dedup namespace, distinct blueprintIds make collisions impossible).

- [ ] **Step 1: Failing tests** — order `["create_campaign","create_adset","create_ad"]` with contiguous seq; adset's `campaignRef === "tmp:"+campaign.tempId` and ad's `adsetRef === "tmp:"+adset.tempId`; campaign+adset payload status literal PAUSED and ad ACTIVE; `specialAdCategories` `[]` always; recKey deterministic across two calls + "bp-" prefix; two ads → two create_ad rows each with own tempId localRef; duplicate tempIds across nodes → throw.
- [ ] **Step 2: Run → fail.** **Step 3: Implement** (export tmp/recKey from compile.ts — verify no test breaks; write compileMeta ~60 lines mirroring compile.ts's style incl. the duplicate-tempId guard seeded like the v2.3 differ). **Step 4: Run → pass**; tsc 0.
- [ ] **Step 5: Commit** `git add src/lib/command/blueprint/compile.ts src/lib/command/blueprint/meta-compile.ts src/lib/command/__tests__/meta-compile.test.ts && git commit -m "feat(v2.2): pure compileMeta — campaign→adset→ads with tmp refs over the shared recKey"`

---

### Task 5: Meta adapter — buildMetaMutation, validate_only rehearsal, creates, DELETE rollback, capabilities switchboard

**Files:**
- Modify: `src/lib/command/networks/meta.ts`
- Test: `src/lib/command/__tests__/meta-adapter-create.test.ts` (new; mirror the fetch-mock pattern of the existing meta/google adapter tests — READ them first)

**Interfaces:**
- Consumes: Meta payloads (Task 1). The spec §d is the binding contract — READ `docs/superpowers/specs/2026-07-08-command-center-v2.2-meta-create-design.md` lines 113-176 and implement its code blocks verbatim (buildMetaMutation cases, metaDelete, microsToCents, validate, buildRollback, capabilities).
- Produces: `buildMetaMutation(accountRef, action): MetaMutation` (v1 cases budget_update/pause/enable MOVED IN UNCHANGED — including budget_update's existing rounding division — plus create_campaign/create_adset/create_ad/remove_entity); `metaDelete(path)` helper (token + appsecret_proof like metaPost); `microsToCents(micros)` THE ONLY cents-producing function (throws on non-integer/≤0/non-multiple-of-MICROS_PER_MINOR_UNIT); `validate()` TOTAL (creates → metaPost with `execution_options:'["validate_only"]'`; everything else `{ok:true,"sin ensayo"}`; catch → `{ok:false,detail}`); `execute()` routes through buildMetaMutation, creates return `resourceNames:[String(response.id)]`; `buildRollback` create cases → `remove_entity` with `entityRef = exec.resourceNames[0]` (REAL id, never the tmp: — the v2.3 lesson) never-null when resourceNames exist; `capabilities()` switchboard (no token → write:false; token without META_PAGE_ID/META_APP_SECRET → v1 verbs only; all creds → + create family + remove_entity); `requirePageId()` throws if unset; `pageId()`/`appSecret()` env readers.

- [ ] **Step 1: Failing tests** (mocked fetch; set env vars per-test via `process.env.X = ...` + restore):
```
- capabilities matrix: no token → write:false; token only → actionTypes exactly v1 3; token+page+secret → + create_campaign/create_adset/create_ad/remove_entity.
- create_campaign execute → POST /act_1/campaigns, form-encoded body contains name, objective=OUTCOME_TRAFFIC, status=PAUSED, buying_type=AUCTION, special_ad_categories=[] (JSON string); resourceNames=["<id from mocked {id} response>"].
- create_campaign with payload status !== "PAUSED" → buildMetaMutation THROWS (fail-closed belt behind the gate).
- create_adset → POST /act_1/adsets; daily_budget === "3500" for dailyBudgetMicros 35_000_000 (THE conversion assert); campaign_id from (resolved) payload.campaignRef; targeting JSON has geo_locations.countries, age_min/max, targeting_automation.advantage_audience:0.
- microsToCents throws on 3500-as-micros? No — 3500 is not multiple of 10_000 → throws; on 35_000_001 → throws; on 0/-1 → throws. (Direct unit asserts via a create_adset buildMutation.)
- create_ad → POST /act_1/ads; creative JSON has object_story_spec.page_id === env META_PAGE_ID, link_data.{link,message}, name from headline, picture only when imageUrl set, call_to_action only when set; status ACTIVE.
- validate(create_adset) → metaPost called WITH execution_options='["validate_only"]' and ok:true on 200; API 400 → {ok:false, detail contains message}; validate(pause) → ok:true "sin ensayo" with ZERO fetch calls; validate(remove_entity) → ok:true, ZERO fetch calls (the strand-rollback guard).
- remove_entity execute → DELETE /<id> via metaDelete (method DELETE, appsecret_proof present when secret set).
- buildRollback(create_adset, exec.resourceNames ["123"]) → remove_entity, entityRef "123", payload.resourceNames ["123"]; empty resourceNames → null.
- v1 regression: budget_update/pause/enable still produce byte-identical requests (move-in unchanged).
```
- [ ] **Step 2: Run → fail.** **Step 3: Implement** per spec §d verbatim. **Step 4: Run → pass** (whole suite); tsc 0.
- [ ] **Step 5: Commit** `git add src/lib/command/networks/meta.ts src/lib/command/__tests__/meta-adapter-create.test.ts && git commit -m "feat(v2.2): Meta adapter — creates via buildMetaMutation, validate_only rehearsal, DELETE rollback, credential switchboard"`

---

### Task 6: Repo + preview + route branches (network dispatch)

**Files:**
- Modify: `src/lib/command/blueprint/repo.ts` (compileBlueprintToActions meta branch), `src/lib/command/blueprint/preview.ts` (meta branch + `SYNTHETIC_CAPABILITIES_META`), `src/app/api/command/blueprint/route.ts` (accept meta), `src/app/api/command/blueprint/[id]/route.ts` (GET/PUT meta branches)
- Test: `src/lib/command/__tests__/blueprint-repo.test.ts` + `blueprint-preview.test.ts` (extend)

**Interfaces:**
- Consumes: `parseMetaBlueprint` (Task 3), `compileMeta` (Task 4), `metaAccountRefs` from `networks/meta.ts`.
- Produces: dispatch on `blueprint.network === "meta_ads"` (the ROW column, not a docType): repo compiles via `compileMeta`, rows `connectionId:null`, `source:"manual"` (no `_ai`); preview parses/compiles meta docs, passes `network:"meta_ads"` into `GateInput` (the existing branches hardcode `"google_ads"` — the meta branch must NOT), uses a NEW `SYNTHETIC_CAPABILITIES_META = { read:true, write:true, actionTypes:["create_campaign","create_adset","create_ad","remove_entity"] }`, keeps VALIDATE_ONLY excluded from blocking + `validateOnlyDeferred:true`; POST /api/command/blueprint accepts `network:"meta_ads"` (skip the google connection_id requirement; validate `body.account_ref ∈ metaAccountRefs()` else 400 `"Cuenta de Meta no permitida (META_AD_ACCOUNT_IDS)."`; `connectionId:null`; do NOT require the token at create time — drafting/preview is safe, execution is gate-blocked); GET/PUT `[id]` branch AFTER the isEditDoc branch, keyed on `blueprint.network === "meta_ads"` (GET compiled via compileMeta; PUT validates with parseMetaBlueprint, 400 on ZodError).

- [ ] **Step 1: Failing tests.** repo: a meta blueprint (network:"meta_ads", valid Task-3 doc) compiles to 3 rows in order with `recKey` "bp-" and `connectionId` null; a google create doc still compiles via the google path; an edit doc still routes to the differ (three-way dispatch regression). preview: meta blueprint preview → `summary.blockingCount === 0` for a compliant doc under `ALLOWED_WITH_ADSET` settings; over-cap adset budget → `ABS_BUDGET_CAP` blocking; the per-action `gates` include `PAUSED_ON_CREATE` pass rows (proves network:"meta_ads" reached GateInput — ACTION_ALLOWED would fail if capabilities were google-shaped).
- [ ] **Step 2: Run → fail.** **Step 3: Implement** (order the dispatch: isEditDoc branch FIRST (docType), then `blueprint.network === "meta_ads"`, then the google create path — mirror the v2.3 inline-branch convention). Routes: mirror the exact existing google branches; read `blueprint/route.ts:44-61` before editing. **Step 4: Run → pass**; tsc 0.
- [ ] **Step 5: Commit** `git add src/lib/command/blueprint/repo.ts src/lib/command/blueprint/preview.ts src/app/api/command/blueprint/route.ts "src/app/api/command/blueprint/[id]/route.ts" src/lib/command/__tests__/blueprint-repo.test.ts src/lib/command/__tests__/blueprint-preview.test.ts && git commit -m "feat(v2.2): meta network dispatch — repo/preview/blueprint routes"`

---

### Task 7: UI — /command/crear-meta lean form + review labels + entry card

**Files:**
- Create: `src/app/command/crear-meta/page.tsx`, `src/app/command/crear-meta/meta-form-client.tsx`
- Modify: `src/app/command/crear/[id]/revisar/revisar-client.tsx` (additive: `create_adset` label + Meta payload renderers + Campaña→Conjunto→Anuncio grouping), `src/app/command/page.tsx` (entry card "Nueva campaña Meta — beta")

**Interfaces:**
- Consumes: `POST /api/command/blueprint {network:"meta_ads", account_ref, doc}` → `{blueprint}`; navigates to the EXISTING `/command/crear/[id]/revisar` (network-agnostic review reused); `metaAccountRefs()` server-side; `metaBlueprintDocSchema.safeParse` client-side for inline validation; `META_LINK_AD_SPEC` counters.
- Produces: a single-screen es-MX form (~9 fields, no step machine): account select (from metaAccountRefs; if empty → the "pendiente de credenciales" card, form disabled), campaign name, adset name, daily budget (currency input → `metaUnitsToMicros(raw) = Math.round(parseFloat(raw)*100) * MICROS_PER_MINOR_UNIT` so micros are ALWAYS whole-cent), countries multi-select (the 6-country enum), age range, ads list (link, message ≤125 with live counter, headline ≤40, description ≤30, CTA select, imageUrl optional) with añadir/quitar (min 1), «EN PAUSA» badge, «Continuar a revisión» → POST then `router.push('/command/crear/'+id+'/revisar')`. Mirror server-gate/page conventions from `crear/page.tsx`; ui-kit primitives; breadcrumbs Centro de Mando → Crear (Meta).

- [ ] **Steps:** build page+form; extend revisar-client additively (labels/renderers only — verify google/edit rendering untouched); add the entry card. Verify `~/.local/bin/bunx tsc --noEmit` exit 0; suite green; `~/.local/bin/bunx eslint src/app/command/crear-meta/ "src/app/command/crear/[id]/revisar/"` clean. Commit `git add src/app/command/crear-meta src/app/command/page.tsx "src/app/command/crear/[id]/revisar/revisar-client.tsx" && git commit -m "feat(v2.2): Meta lean create form + review renderers + entry card"`

---

### Task 8: Verification + deploy notes (incl. first-live-run checklist)

**Files:**
- Modify: `docs/superpowers/plans/DEPLOY-NOTES-command-center.md`

- [ ] **Step 1:** `~/.bun/bin/bun test src/lib/command` → all green (expect ≥200; report count).
- [ ] **Step 2:** `~/.local/bin/bunx tsc --noEmit` → exit 0.
- [ ] **Step 3:** `~/.bun/bin/bun run build` → exit 0; `/command/crear-meta` present.
- [ ] **Step 4:** Runtime smoke (prod build, :4402, `COMMAND_CENTER_BETA=true` + public Supabase envs, NO Meta envs): `/command/crear-meta` → 404 (gated), and with beta on it renders the pendiente-de-credenciales state for admins (can't verify logged-in here — assert the 404-gating chain doesn't crash).
- [ ] **Step 5:** Append to DEPLOY-NOTES a "v2.2 Meta create" section: migration 009 required; env activation checklist (`META_SYSTEM_USER_TOKEN`, `META_APP_SECRET`, `META_PAGE_ID`, `META_AD_ACCOUNT_IDS`); COPY THE FULL first-live-run checklist from the spec (12 items) verbatim — it is the list of mocked assumptions Pedro must verify on the first credentialed run; note that creation is IMPOSSIBLE until all three env vars exist (capabilities switchboard + VALIDATE_ONLY fail-closed).
- [ ] **Step 6:** Commit and report `git log --oneline main..HEAD`.

---

## Plan self-review

- Spec coverage: §a scope → Tasks 3/7 (schema+form encode every decision); §b vocabulary (10 touchpoints) → Task 1 (types/executor/migration/schema-default) + Task 2 (gates) + Task 5 (capabilities) + Task 6 (preview) + Task 7 (labels); §c doc+compiler → Tasks 3/4; §d adapter → Task 5; §e page env → Task 5 (requirePageId) + Task 7 (static note lives in review renderers); §f UI → Task 7; §g gates table → Task 2 + Task 6 (preview); §h routes → Task 6; first-live-run checklist → Task 8 deploy notes.
- Type consistency: `MetaCreate*Payload` (Task 1) consumed by Tasks 2/4/5/7; `parseMetaBlueprint`/`CcMetaBlueprintDoc` (Task 3) by 4/6/7; `compileMeta` (4) by 6; exported `tmp`/`recKey` (4) shared with the google compiler.
- Placeholder scan: code steps carry real code or a named spec-section to implement verbatim + the exact deltas; no TBDs.
- Sequencing: Task 1's executor validate-condition change is safe before Task 5 (short-circuits on missing adapter.validate); Task 6's dispatch order (edit → meta → google) prevents cross-compiler misrouting; Task 7 reuses the review screen only after Task 6's GET branch exists.
