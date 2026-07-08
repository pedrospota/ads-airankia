# Command Center v2.2 — Meta Create Flow (slice 1) — Design Spec

Date: 2026-07-08 · Status: approved-for-planning (autonomous continuation; built with mocked credentials, fails closed until META_SYSTEM_USER_TOKEN exists)
Produced by: 3-lens adversarial design workflow (rail-fit, YAGNI, Meta-API-reality) + opus synthesis+critique.
Builds on: v2 create rail + v2.3 patterns. Repo main @ 3f63e7c.

# Command Center v2.2 — Meta create flow (final merged, minimal slice-1)

Repo `/home/coder/projects/ads-airankia` @ main. Verified against source: `adapterFor(network)` dispatches per-network (`networks/index.ts:10`); `cc_actions` rows carry `blueprint.network` (`repo.ts:205-221`); Meta auth is env-based (`executor-deps.ts:25` returns `{}` for non-google); the single chokepoint is `executor.ts::executeAction`; plan-runner `resolvePayload` is network-agnostic string substitution (`plan-runner.ts:46`). Meta creates ride the EXISTING `cc_blueprints → compile → cc_actions(tmp:) → plan-runner → executeAction → buildRollback` machinery unchanged. **Exactly one new action type (`create_adset`).** The rail speaks micros end-to-end; cents exist only inside `meta.ts`.

## a) Slice-1 scope + why (weekly-operator-value)

| Axis | Decision | Why (minimal + mock-verifiable now) |
|---|---|---|
| Objective | `OUTCOME_TRAFFIC` (`optimization_goal=LINK_CLICKS`, `billing_event=IMPRESSIONS`, `bid_strategy=LOWEST_COST_WITHOUT_CAP`, `buying_type=AUCTION`) | The ONLY objective with zero external-asset deps: no `promoted_object`, no pixel, no lead form. "Put a traffic test live-but-paused at a landing page" is the repeated weekly Meta setup. Leads/Sales are one added `promoted_object` field later — machinery transfers 1:1. |
| Budget mode | **ABO** — `daily_budget` on the ad set; nothing on the campaign | No standalone budget entity ⇒ no `create_budget` analog (3-action plan). v1 `budget_update`/snapshot already read `daily_budget` off adsets (`meta.ts:114,135`). CBO would fork the money field onto `create_campaign` and the gate helpers. |
| Structure | exactly 1 campaign → 1 adset → N ads (`adsets .length==1`, `ads .min(1)`) | Honest lean form; compiler/runner are array-agnostic (widening later, not a rewrite). |
| Targeting | `{geo_locations:{countries:[ISO2]}, age_min, age_max, targeting_automation:{advantage_audience:0}}` | Meta takes ISO codes natively (no geo-constant table, unlike Google's `COUNTRY_GEO`). `advantage_audience:0` makes the reviewed geo/age exactly what runs. Countries restricted to a **fixed non-EU enum** `{MX,US,AR,CO,CL,PE}` (Google list minus ES) to avoid EU DSA (`dsa_beneficiary/dsa_payor`) required fields. No placements (Advantage+ default), no interests/audiences/languages/gender. |
| Creative | single link ad, **inline** creative on `POST /ads` (`creative={object_story_spec:{page_id,link_data:{link,message,name?,description?,call_to_action?,picture?}}}`) | Inline creative creates the AdCreative implicitly in ONE call — no `create_ad_creative` action, no second tmp: ref, no two-step, no compensation block. `imageUrl → link_data.picture` is **optional** (Meta fetches the URL / scrapes og:image); a rejected imageless combo is caught by the `validate_only` rehearsal before any write. **No `/adimages` binary upload / `image_hash`** in slice 1. |
| Page | env `META_PAGE_ID`, injected in the adapter (see e) | |
| special_ad_categories | hardcoded `[]` (Graph requires the param) | Declaration picker deferred; documented policy risk. |
| Child status | campaign `PAUSED` (gated), **adset `PAUSED` (gated)**, ad `ACTIVE` | See (b) PAUSED_ON_CREATE. |

## b) Action vocabulary

**Exactly ONE new action type: `create_adset`.** `create_campaign` + `create_ad` are REUSED with Meta-variant payloads; `remove_entity` is REUSED for rollback.

**Reuse is safe (verified):** the adapter is selected by `deps.adapters.for(row.network)` (`executor.ts:54`), and rows carry `network:"meta_ads"` (`repo.ts:215`), so a Meta-shaped `create_campaign`/`create_ad` payload can never reach the Google adapter. One `actionType` string, per-network payload interpretation — this keeps `ACTION_ALLOWED`, `PAUSED_ON_CREATE`, settings allow-list, migration 008, and UI labels stable.

**Why `create_adset` cannot fold into `create_ad_group`:** zero shared payload fields; `entityKind` would read `"adset"` while `actionType` read `"ad_group"` (corrupts ledger/review legibility); the adset is the ABO money carrier and needs its own budget-gate + PAUSED_ON_CREATE coverage. `CcEntityKind` already includes `"adset"` (`types.ts:5`).

**Payload interfaces (`types.ts`, after line 60):**
```ts
export interface MetaCreateCampaignPayload {
  name: string; status: "PAUSED";
  objective: "OUTCOME_TRAFFIC"; buyingType: "AUCTION";
  specialAdCategories: string[];               // slice 1: always []
}
export interface MetaCreateAdsetPayload {
  name: string; status: "PAUSED"; campaignRef: CcRef;   // tmp:<campaign tempId>
  dailyBudgetMicros: number;                             // RAIL MICROS — adapter converts to cents
  optimizationGoal: "LINK_CLICKS"; billingEvent: "IMPRESSIONS";
  bidStrategy: "LOWEST_COST_WITHOUT_CAP";
  targeting: { countryCodes: string[]; ageMin: number; ageMax: number };
}
export interface MetaCreateAdPayload {
  name: string; status: "ACTIVE"; adsetRef: CcRef;       // tmp:<adset tempId>
  creative: { link: string; message: string; headline?: string; description?: string;
    callToActionType?: "LEARN_MORE"|"CONTACT_US"|"SHOP_NOW"|"SIGN_UP"|"GET_QUOTE";
    imageUrl?: string };                                 // → link_data.picture (optional)
}
```
`CcPayload` union (`types.ts:62`) gains all three (distinct interfaces from Google's `CreateCampaignPayload`/`CreateAdPayload`; the adapter casts to the network's own type).

**Every vocabulary touchpoint:**
1. `types.ts:11-12` — `CcCreateActionType` += `"create_adset"`.
2. `types.ts:25-28` — `CC_SETTINGS_ACTION_TYPES` += `"create_adset"` (flows into `CC_SETTINGS_DEFAULTS.allowedActionTypes` at line 158 automatically).
3. `types.ts:62-66` — `CcPayload` += the 3 interfaces.
4. `executor.ts:51` — `CREATE_ACTION_TYPES` set += `"create_adset"` (**CRITICAL**: else the tmp:-guard at line 58 throws on every compiled adset and `snapshot()` is attempted on a `tmp:` ref). `create_campaign`/`create_ad` are already in this set.
5. `gates.ts` — `budgetMicros()` + `CURRENCY_SANITY`/`ABS_BUDGET_CAP` `isBudget` + `PAUSED_ON_CREATE` + `VALIDATE_ONLY` (see g).
6. Migration **`009_command_center_v2_2`** in `src/app/api/migrate/route.ts` (append after line 619, mirror of 008): `UPDATE cc_settings SET allowed_action_types = allowed_action_types || '["create_adset"]'::jsonb WHERE NOT (allowed_action_types ? 'create_adset')` + `ALTER COLUMN ... SET DEFAULT '[…008 list…,"create_adset"]'::jsonb` + `INSERT INTO schema_migrations ('009_command_center_v2_2') ON CONFLICT DO NOTHING`. No table/column changes (`cc_blueprints.network` is already TEXT; `cc_actions` already threads blueprint_id/seq/local_ref/result_ref). Without 009, ACTION_ALLOWED blocks every `create_adset` on existing workspaces.
7. `settings.ts` / settings route — no code change (validate against `CC_SETTINGS_ACTION_TYPES`).
8. `meta.ts capabilities()` — see (d).
9. `blueprint/preview.ts` — new `SYNTHETIC_CAPABILITIES_META` (see g/c).
10. `revisar-client.tsx` — additive label `create_adset: "Crear conjunto de anuncios"` + Meta payload summary renderers.

**PAUSED_ON_CREATE extension — campaign AND adset born PAUSED, ad ACTIVE.** Under ABO the adset is the spend carrier, so making it PAUSED (and gate-enforcing it) is a second, independent guarantee that a single accidental campaign-enable cannot start spend — this serves the "everything born PAUSED fail-closed" invariant WITHOUT depending on the uncertain assumption that a PAUSED campaign alone gates all Meta delivery (that assumption is on the first-live-run checklist). The ad stays `ACTIVE` (mirrors shipped Google `create_ad`, `google.ts:267`: an ad cannot spend with paused parents), avoiding a third enable step + gate carve-out. Operator later enables campaign then adset via v1 `enable`, each individually gated.

## c) Meta blueprint doc + compiler

**Discriminator: the `blueprint.network` ROW column — no new docType.** The v2.3 edit branch needed `docType` only because edit and create docs share one network (`google_ads`). For Meta the network column alone disambiguates `meta_ads` vs `google_ads`. Dispatch rule at every site (repo compile, preview, `[id]` GET compile, `[id]` PUT validate): edit-docType branch FIRST (unchanged) → `blueprint.network === "meta_ads"` → Meta pair → else Google. The Google schema/compiler files stay byte-for-byte untouched.

**NEW `src/lib/command/blueprint/meta-schema.ts`:**
```ts
export const metaBlueprintDocSchema = z.object({
  network: z.literal("meta_ads"),
  campaign: z.object({
    nodeId: z.string(), tempId: z.string(), name: z.string().min(1),
    status: z.literal("PAUSED"), objective: z.literal("OUTCOME_TRAFFIC"),
    adsets: z.array(z.object({
      nodeId: z.string(), tempId: z.string(), name: z.string().min(1),
      dailyBudgetMicros: z.number().int().min(MICROS_PER_UNIT)
        .multipleOf(MICROS_PER_MINOR_UNIT),          // whole-cent guard — schema-level 100x/sub-cent catch
      targeting: z.object({
        countryCodes: z.array(z.enum(["MX","US","AR","CO","CL","PE"])).min(1),  // fixed non-EU (no DSA)
        ageMin: z.number().int().min(18).max(65).default(18),
        ageMax: z.number().int().min(18).max(65).default(65),
      }).refine(t => t.ageMin <= t.ageMax, { message: "ageMin ≤ ageMax" }),
      ads: z.array(z.object({
        nodeId: z.string(), tempId: z.string(), name: z.string().min(1),
        link: z.string().url(), message: z.string().min(1).max(META_LINK_AD_SPEC.message.maxLen),
        headline: z.string().max(META_LINK_AD_SPEC.headline.maxLen).optional(),
        description: z.string().max(META_LINK_AD_SPEC.description.maxLen).optional(),
        callToActionType: z.enum(["LEARN_MORE","CONTACT_US","SHOP_NOW","SIGN_UP","GET_QUOTE"]).optional(),
        imageUrl: z.string().url().startsWith("https://").optional(),
      })).min(1),
    })).length(1),                                   // slice 1: exactly one adset
  }),
});
export type CcMetaBlueprintDoc = z.infer<typeof metaBlueprintDocSchema>;
export function parseMetaBlueprint(doc: unknown): CcMetaBlueprintDoc { return metaBlueprintDocSchema.parse(doc); }
```
`META_LINK_AD_SPEC` (message/headline/description maxLens) added to `knowledge.ts` alongside `RSA_SPEC`. Doc carries **micros**; the builder produces whole-cent micros (see f).

**NEW `src/lib/command/blueprint/meta-compile.ts`** — pure, reuses the exported `CompiledAction` type and `tmp`/`recKey` helpers (export `tmp` and `recKey` from `compile.ts` so `recKey` is a single source of truth):
```
seq 0: create_campaign  entityKind "campaign"  localRef c.tempId       MetaCreateCampaignPayload{status:"PAUSED", specialAdCategories:[]}
seq 1: create_adset     entityKind "adset"     localRef adset.tempId   MetaCreateAdsetPayload{status:"PAUSED", campaignRef: tmp(c.tempId), dailyBudgetMicros: adset.dailyBudgetMicros, ...}
seq 2+: create_ad       entityKind "ad"        localRef ad.tempId      MetaCreateAdPayload{status:"ACTIVE", adsetRef: tmp(adset.tempId), ...}
```
`resolvePayload` (`plan-runner.ts:46`) substitutes `campaignRef`/`adsetRef` tmp: refs from prior siblings' `result_ref` (Meta numeric ids resolve identically to Google resourceNames). **Zero plan-runner changes.**

## d) Adapter extension (`src/lib/command/networks/meta.ts`)

**buildMutation-style single source of truth** used by `validate()` and `execute()`, mirroring `google.ts:130`:
```ts
interface MetaMutation { path: string; method: "POST"|"DELETE"; form: Record<string,string> }
function buildMetaMutation(accountRef: string, action: CcActionInput): MetaMutation
```
(`accountRef` is already `act_123…` per `META_AD_ACCOUNT_IDS` / `meta.ts:105` — do not double-prefix.) Existing v1 cases move in unchanged. New cases (Graph v25.0, all mocked):
- `create_campaign` → `POST /${accountRef}/campaigns` form `{name, objective:"OUTCOME_TRAFFIC", status:"PAUSED"(from payload; throw if ≠PAUSED), buying_type:"AUCTION", special_ad_categories: JSON.stringify(payload.specialAdCategories)}` (always sent, `"[]"` for none).
- `create_adset` → `POST /${accountRef}/adsets` form `{name, campaign_id: payload.campaignRef, status:"PAUSED", daily_budget: microsToCents(payload.dailyBudgetMicros), optimization_goal:"LINK_CLICKS", billing_event:"IMPRESSIONS", bid_strategy:"LOWEST_COST_WITHOUT_CAP", targeting: JSON.stringify({geo_locations:{countries: payload.targeting.countryCodes}, age_min, age_max, targeting_automation:{advantage_audience:0}})}`.
- `create_ad` → `POST /${accountRef}/ads` form `{name, adset_id: payload.adsetRef, status:"ACTIVE", creative: JSON.stringify({object_story_spec:{page_id: requirePageId(), link_data:{link, message, ...(headline?{name:headline}:{}), ...(description?{description}:{}), ...(imageUrl?{picture:imageUrl}:{}), ...(callToActionType?{call_to_action:{type:callToActionType, value:{link}}}:{})}}})}`. Inline creative — no `create_creative` action, no two-step.
- `remove_entity` → `DELETE /${payload.resourceNames[0]}` via new `metaDelete(path)` helper (token + `appsecret_proof`, same as `metaPost`).

**`execute()`:** `metaPost`/`metaDelete` the mutation; for creates `resourceNames = [String(response.id)]` (Meta returns `{id}`) so the plan-runner stamps `result_ref` for tmp: resolution.

**`validate()` — real validate_only analog, TOTAL (never throws):**
```ts
async validate(_auth, accountRef, action) {
  const CREATE = new Set(["create_campaign","create_adset","create_ad"]);
  if (!CREATE.has(action.actionType)) return { ok: true, detail: "sin ensayo (verbo v1 / eliminación)" }; // remove_entity + v1: no network call, no throw
  try {
    const m = buildMetaMutation(accountRef, action);
    await metaPost(m.path, { ...m.form, execution_options: '["validate_only"]' });
    return { ok: true };
  } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : "error de validación" }; }
}
```
The `remove_entity` (and v1) short-circuit is **mandatory** (spec §14): `rollbackAction` (`executor.ts:197`) calls `prepare()` OUTSIDE any try/catch, and its hard-blockers include `VALIDATE_ONLY` — a throwing validate would strand every create-rollback. v1 Meta verbs get **no** live rehearsal (byte-identical v1 behavior).

**`buildRollback` (never-null for creates):**
```ts
case "create_campaign": case "create_adset": case "create_ad":
  if (!exec.resourceNames?.length) return null;   // only when the create itself failed
  return { action: { entityKind: action.entityKind, entityRef: exec.resourceNames[0],
                     actionType: "remove_entity", payload: { resourceNames: [exec.resourceNames[0]] } },
           note: "Eliminar recurso creado en Meta." };
```
`entityRef` = real created id, never `action.entityRef` (a create's entityRef is the tmp: placeholder — same rule as `google.ts:437-443`). `rollbackBlueprint` reverse-seq (`plan-runner.ts:147`) deletes ad → adset → campaign (children before parents; also sidesteps Meta's parent-delete cascade).

**CENTS↔MICROS boundary — the one place:**
```ts
// THE ONLY cents-producing function. Rail (doc, payloads, gates, ledger, snapshot) is ALWAYS micros.
function microsToCents(micros: number): string {
  if (!Number.isInteger(micros) || micros <= 0 || micros % MICROS_PER_MINOR_UNIT !== 0)
    throw new Error(`Presupuesto no convertible a centavos: ${micros} micros`);
  return String(micros / MICROS_PER_MINOR_UNIT);
}
```
Called at exactly ONE new write site: `create_adset`. **The existing `budget_update` conversion (`meta.ts:147`, `Math.round(… / MICROS_PER_MINOR_UNIT)`) is left UNTOUCHED** — deliberate scope boundary: a v1 budget_update may legitimately carry non-whole-cent micros (engine suggestions) that today round; upgrading that to a throw would change shipped v1 behavior. Both conversions live inside `meta.ts`, so the invariant "only meta.ts speaks cents" holds. The read path (cents→micros at `meta.ts:114,135`) is unchanged.

**`capabilities()` — fail-closed switchboard (creation impossible until credentials):**
```ts
capabilities() {
  if (!token()) return { read:false, write:false, actionTypes:[], reason:"META_SYSTEM_USER_TOKEN no configurado (pendiente de credenciales)." };
  const base = ["budget_update","pause","enable"];                      // v1 UNCHANGED
  const canCreate = pageId() && appSecret();                            // creates need page + app-secret proof
  return { read:true, write:true,
           actionTypes: canCreate ? [...base,"create_campaign","create_adset","create_ad","remove_entity"] : base,
           ...(canCreate ? {} : { reason: "Creación Meta deshabilitada: falta META_PAGE_ID o META_APP_SECRET." }) };
}
```
Without token → `write:false` → CAPABILITY gate blocks everything (v1 unchanged). Without page/app-secret → create types withheld → CAPABILITY blocks creates. This strictly honors "fail closed until `META_SYSTEM_USER_TOKEN` + `META_APP_SECRET` are set" (gating creates on app-secret is intentionally strict for the pre-live beta; relax via checklist if the app doesn't enforce proof).

**Executor validate condition (`executor.ts:74-77`):** `row.network === "google_ads" && adapter.validate && capabilities.write` → `adapter.validate && capabilities.write` (dispatch stays per-adapter; Meta's total validate() now runs).

## e) Auth / page (YAGNI hard)

**env `META_PAGE_ID`. Full stop.** Joins the existing env auth model (`META_SYSTEM_USER_TOKEN`/`META_APP_SECRET`/`META_AD_ACCOUNT_IDS`). Injected inside `buildMetaMutation`'s `create_ad` case via `requirePageId()` (throws if unset — unreachable because `capabilities()` already withheld the create types). NOT a `/me/accounts` picker (needs the very token that doesn't exist; unbuildable/untestable now), NOT a per-workspace setting (migration + UI for one string), NOT env-global-wrong-across-clients — but the internal beta is one operator, one page. `AdapterAuth` untouched (`executor-deps.ts:25` already returns `{}` for Meta). **Known limitation:** the page is a fixed install identity, not part of the approved payload; the review screen shows a static "Página: (META_PAGE_ID)" note. Deferred: per-ad `pageId` doc field + picker when a second page exists.

## f) UI — parallel lean route `/command/crear-meta` (NOT a toggle in the Google builder)

The downstream — autosave `POST/PUT /api/command/blueprint`, the review screen `/command/crear/[id]/revisar`, gate preview, publish-PAUSED, blueprint list — is fully network-agnostic (keyed on the blueprint's id/network columns) and is REUSED untouched. Only the FORM differs, and the Google builder is large and RSA/keyword-shaped (`BuilderState` has 12 Google-only fields; `builder-steps.tsx` is RSA-shaped). Threading a network discriminator through it forks `buildDoc`/`missingSteps`/every step behind conditionals to share ~100 lines of account/money chrome — higher conditional-complexity than a small parallel form. The Meta slice-1 form is ~9 fields.

- **NEW `src/app/command/crear-meta/page.tsx`** (server): accounts from `metaAccountRefs()` (`meta.ts:16`). If empty/no token, render the existing "pendiente de credenciales" card and disable the form (still demos with mock env in dev).
- **NEW `src/app/command/crear-meta/meta-form-client.tsx`** (single screen, no step machine): client-side `metaBlueprintDocSchema.safeParse` for inline validation; a `metaUnitsToMicros(raw) = Math.round(parseFloat(raw) * 100) * MICROS_PER_MINOR_UNIT` helper guarantees whole-cent micros (so `.multipleOf(MICROS_PER_MINOR_UNIT)` never trips); POST to the SAME `/api/command/blueprint` with `network:"meta_ads"`, `connection_id` omitted; then `router.push('/command/crear/${id}/revisar')`.
- **`revisar-client.tsx` (MODIFIED, small):** `create_adset` label + Meta payload summary renderers + grouping "Campaña → Conjunto → Anuncio". Gate-preview panel works as-is via (g).
- Entry: one "Nueva campaña Meta — beta" card on `/command/page.tsx`. Deferred: merged builder with a network switch.

## g) Gates

| Gate | Meta creates | Change |
|---|---|---|
| KILL_SWITCH, CAPABILITY, ACTION_ALLOWED (post-009), DRIFT (no `expected`→pass), BLAST_RADIUS, LEARNING_PHASE/TRACKING_SIGNAL (synthetic before), BUDGET_DELTA/META_LEARNING_RESET (budget_update-only) | apply as-is | none |
| **CURRENCY_SANITY** (`gates.ts:87`) | must cover the adset budget | `isBudget` += `create_adset`; `budgetMicros()` (`gates.ts:26`) += `actionType==="create_adset" → payload.dailyBudgetMicros`. Enforces integer ≥ `MICROS_PER_UNIT` **in micros** — the 100x tripwire: a cents-value smuggled as micros (e.g. `3500`) fails (< 1M). |
| **ABS_BUDGET_CAP** (`gates.ts:121`) | the catastrophe gate | same `isBudget` + `budgetMicros()` extension; compares micros ≤ `maxDailyBudgetMicros` (micros). Payload is micros by construction (builder rounds to whole-cent micros → schema `multipleOf` → no conversion before the adapter). |
| **PAUSED_ON_CREATE** (`gates.ts:149`) | extend | `actionType === "create_campaign" || actionType === "create_adset"`; both payloads carry `status` and must equal `"PAUSED"` (fails closed on absent status). |
| **VALIDATE_ONLY** (`gates.ts:114`) | real rehearsal for Meta creates | `const requires = network==="google_ads" || (network==="meta_ads" && CREATE_FAMILY.has(actionType))` where `CREATE_FAMILY={create_campaign,create_adset,create_ad}`. If `!requires` → pass "No aplica" (Meta v1 verbs + remove_entity unchanged); else require `validateResult` (fail closed if absent) and mirror `.ok`. Google branch identical to today. |

`preview.ts` Meta branch (dispatch on `blueprint.network === "meta_ads"`): parse via `parseMetaBlueprint`, compile via `compileMeta`, pass `network:"meta_ads"` to `GateInput` (the existing branches hardcode `"google_ads"` at 126/158 — the Meta branch must NOT), `SYNTHETIC_CAPABILITIES_META = { read:true, write:true, actionTypes:["create_campaign","create_adset","create_ad","remove_entity"] }` (distinct constant, same reasoning as `SYNTHETIC_CAPABILITIES_EDIT`), and exclude `VALIDATE_ONLY` from `blocking` with `validateOnlyDeferred:true` (it genuinely runs at publish for Meta creates too). Preview works with NO credentials (synthetic caps), so drafting/previewing Meta blueprints is possible during the mocked-build phase; execution stays impossible via CAPABILITY + VALIDATE_ONLY.

## h) API / route deltas

- **`POST /api/command/blueprint`** (`route.ts:44-61`): `network = body.network==="google_ads" ? "google_ads" : body.network==="meta_ads" ? "meta_ads" : null`. For meta: skip the google `connection_id` requirement; validate `accountRef ∈ metaAccountRefs()` (import from `networks/meta.ts`) → else 400 "Cuenta de Meta no permitida (META_AD_ACCOUNT_IDS)."; `connectionId:null`. **Do NOT require the token at create time** — drafting/compiling/previewing is safe and execution is gate-blocked; this keeps the mocked-build model working.
- **`/api/command/blueprint/[id]` GET/PUT** (`[id]/route.ts:27-29, 78-86`): add the `blueprint.network === "meta_ads"` branch after the existing `isEditDoc` branch — GET compiles via `compileMeta(parseMetaBlueprint(...))`; PUT validates via `parseMetaBlueprint(body.doc)` (saves raw). Mirror the exact inline-branch pattern v2.3 already uses in each site (no shared dispatcher — matches established convention; a `compileBlueprintDoc()` helper is a deferred optional refactor).
- **`repo.ts compileBlueprintToActions`** (`repo.ts:190`): Meta branch as a sibling of the google-create `else` — `parseMetaBlueprint` + `compileMeta`; row mapping identical; `source:"manual"` (no `_ai` copiloto tagging for Meta); `connectionId:null`.
- **approve / execute / rollback routes, plan-runner.ts, compile.ts, schema.ts, edit/*, google.ts, actions-repo.ts, settings.ts, suggest.ts** — UNTOUCHED (network-agnostic or google-only).

## i) File-level plan

**NEW:** `src/lib/command/blueprint/meta-schema.ts` · `src/lib/command/blueprint/meta-compile.ts` · `src/app/command/crear-meta/page.tsx` · `src/app/command/crear-meta/meta-form-client.tsx` · tests: `__tests__/meta-schema.test.ts`, `meta-compile.test.ts`, `meta-adapter-create.test.ts` (mocked fetch: form encodings incl. `daily_budget` cents string + `special_ad_categories="[]"` + `execution_options` param; inline creative; DELETE rollback; `remove_entity`/v1 validate non-throw; capabilities matrix ±token ±page ±secret), `meta-gates.test.ts` (cap extensions, PAUSED_ON_CREATE on adset, VALIDATE_ONLY meta branch, cents-as-micros 100x catch).

**MODIFIED:** `src/lib/command/types.ts` · `gates.ts` · `executor.ts` (2 lines) · `networks/meta.ts` (buildMetaMutation, metaDelete, validate, create/remove execute, buildRollback creates, capabilities) · `blueprint/compile.ts` (export `tmp`/`recKey`) · `blueprint/repo.ts` + `preview.ts` (network branch) · `knowledge.ts` (META_LINK_AD_SPEC) · `app/api/migrate/route.ts` (009) · `app/api/command/blueprint/route.ts` + `[id]/route.ts` (meta branch) · `app/command/crear-meta` (new) + `command/page.tsx` (entry card) + `revisar-client.tsx` (labels/renderers) · DEPLOY-NOTES (META_PAGE_ID + checklist).

**UNTOUCHED:** `plan-runner.ts` · `blueprint/schema.ts` · `edit/*` · `networks/google.ts` · `actions-repo.ts` · `settings.ts` · `blueprint/suggest.ts` · `executor-deps.ts`.

## Adversarial self-critique (results)
1. **Cents reaching the micros rail (or vice versa):** the ONLY numeric budget is `dailyBudgetMicros` on the adset. Path is micros end-to-end (builder `metaUnitsToMicros` → schema `.multipleOf(10_000)` → compile passthrough → gates compare micros↔micros) and converts to cents ONLY at `microsToCents()` in the adapter. Reverse (read) path converts cents→micros only at `meta.ts:114,135`. Triple guard against a 100x slip: schema `multipleOf`, CURRENCY_SANITY ≥1-unit floor, adapter `microsToCents` throw. No uncaught crossing. `budget_update`'s existing rounding is deliberately left in place (scope) and is also inside meta.ts (invariant holds).
2. **Rail invariants:** PAUSED — campaign+adset gate-enforced PAUSED, ad ACTIVE (parents gate). Two-step — same compile→approve→executeBlueprint. Single chokepoint — plan-runner still loops over `executeAction`; no new `adapter.execute()` callers. Fail-closed-without-credentials — `capabilities()` withholds writes without token and creates without page+secret; VALIDATE_ONLY additionally fails-closed on Meta creates lacking a rehearsal. None bent.
3. **Hidden complexity avoided:** no `/adimages` upload (imageUrl optional → `link_data.picture`), no CBO (ABO single budget field), no page picker (env), no two-step ad create / compensation (inline creative), no geo-constant table (ISO codes), no new docType (network-column dispatch), no shared compile dispatcher (inline branches). The only new type is `create_adset`.
4. **Uncertain Meta-API claims moved to the checklist (below), not asserted:** picture-URL vs image_hash requirement; validate_only honored on all three creates; DELETE vs status=DELETED; PAUSED-campaign-gates-all-delivery; advantage_audience flag; non-EU-needs-no-DSA; app-secret-proof enforcement; per-currency daily_budget floor.

## First-live-run checklist for Pedro (mocked assumptions to verify on the first credentialed run)
1. **Access tier:** the app needs Ads Management **Standard Access** (`ads_management`); Development tier throttles hard and only reaches admin-owned ad accounts.
2. **Creative image:** confirm `object_story_spec.link_data.picture` accepts a raw https URL for `OUTCOME_TRAFFIC` link ads AND that an imageless link ad (og:image scrape) is accepted — else make `imageUrl` required in the schema.
3. **validate_only:** confirm `execution_options=["validate_only"]` is honored on `POST /campaigns`, `/adsets`, `/ads` and returns actionable errors (not a silent pass).
4. **Delete:** confirm `DELETE /<id>` works for campaign/adset/ad — else switch rollback to `POST status=DELETED`.
5. **Delivery gate:** confirm a PAUSED campaign delivers nothing, and that enabling the campaign while the adset is PAUSED does NOT deliver; confirm the intended enable order (campaign → adset).
6. **special_ad_categories:** confirm `[]` is correct for the target campaigns (none are HOUSING/EMPLOYMENT/CREDIT/FINANCIAL) — else a policy violation.
7. **targeting_automation.advantage_audience:0** is accepted and disables audience expansion (reviewed geo/age is exactly what runs).
8. **app-secret-proof:** if the Meta app enforces "Require app secret proof for server API calls", `META_APP_SECRET` MUST be set or every call 401s. This design gates create capability on `META_APP_SECRET`; relax that gate if proof is not enforced.
9. **Non-EU / DSA:** confirm targeting the slice-1 countries `{MX,US,AR,CO,CL,PE}` needs no `dsa_beneficiary`/`dsa_payor` fields.
10. **Budget floor:** confirm the ≥1-unit (`MICROS_PER_UNIT` = 100 cents) schema floor clears Meta's per-currency/per-account `daily_budget` minimum for the target account.
11. **Inline creatives** created via `object_story_spec` are NOT deleted on rollback (inert, account-level) — confirm acceptable / no clutter accrual.
12. **API version:** `META_API_VERSION=v25.0` is still GA (do not go below).

## New action types required
- create_adset — the Meta ad set is a distinct CcEntityKind ('adset', already in types.ts:5) and, under ABO, the daily-budget carrier; it shares zero payload fields with Google's CreateAdGroupPayload and needs its own budget-gate carve-outs (CURRENCY_SANITY/ABS_BUDGET_CAP) plus PAUSED_ON_CREATE coverage. Overloading create_ad_group would hide a discriminated union inside one actionType and make actionType ('ad_group') disagree with entityKind ('adset'), corrupting ledger/review legibility. This is the ONLY new type — create_campaign and create_ad are reused with Meta-variant payloads (safe because adapterFor(row.network) dispatches per-network), and remove_entity is reused for rollback.

## Slice-1 scope decisions
- Objective: OUTCOME_TRAFFIC only (optimization_goal=LINK_CLICKS, billing_event=IMPRESSIONS, bid_strategy=LOWEST_COST_WITHOUT_CAP, buying_type=AUCTION) — the only objective needing no promoted_object/pixel/lead-form.
- Budget mode: ABO (daily_budget on the ad set; nothing on the campaign) — no create_budget analog, one cents/micros boundary.
- Creative: single link ad with INLINE creative on POST /ads (object_story_spec.link_data); imageUrl OPTIONAL → link_data.picture (Meta fetches URL / scrapes og:image); NO /adimages binary upload / image_hash; no create_creative action.
- Targeting: geo countries (fixed non-EU enum MX/US/AR/CO/CL/PE, no DSA) + age_min/age_max + targeting_automation.advantage_audience:0; no placements/interests/audiences/languages.
- Structure: exactly 1 campaign → 1 adset (schema .length(1)) → N ads (.min(1)).
- Status: campaign PAUSED (gated), adset PAUSED (gated), ad ACTIVE — two gate-enforced delivery gates so a single accidental campaign-enable cannot start spend.
- Page: env META_PAGE_ID injected in the adapter; not in the doc/payload; picker deferred.
- special_ad_categories: hardcoded [] (Graph requires the param); declaration picker deferred.

## Explicitly deferred
- OUTCOME_LEADS / OUTCOME_SALES + promoted_object (pixel_id/custom_event_type, lead forms) and their pickers
- CBO (campaign-level daily_budget / campaign_budget_optimization)
- /adimages binary image upload + image_hash creatives
- Multiple adsets and multiple campaigns per blueprint (slice-1 schema pins one adset)
- Detailed targeting: interests, custom/lookalike audiences, placements, languages, gender
- EU targeting + DSA fields (dsa_beneficiary/dsa_payor) — slice-1 country enum is non-EU only
- Per-workspace Meta connections/OAuth + page picker via /me/accounts; per-ad pageId doc field (env META_PAGE_ID for now)
- special_ad_categories declaration UI (hardcoded [] in slice 1)
- bid_amount / bid caps (LOWEST_COST_WITHOUT_CAP only)
- AI copiloto suggest for Meta (suggest.ts stays google-only)
- Merged builder with a network switch + Meta 3-pane workbench (parallel lean /command/crear-meta for now)
- Explicit deletion of inline-created AdCreatives on rollback (inert; left orphaned)
- Shared compileBlueprintDoc() dispatcher refactor (inline network branches for now)
- Unifying budget_update onto the strict microsToCents (kept as-is to preserve v1 rounding)

## Top risks (design-acknowledged)
- 100x cents/micros slip: Meta daily_budget is account CENTS, the rail is MICROS. Contained to microsToCents() in meta.ts (only cents-producing fn), guarded three ways for creates (builder whole-cent rounding → schema .multipleOf(MICROS_PER_MINOR_UNIT) → CURRENCY_SANITY ≥ MICROS_PER_UNIT floor + adapter throw). A cents value smuggled as micros (e.g. 3500) fails CURRENCY_SANITY (< 1,000,000). Requires tests: 35_000_000 micros → daily_budget "3500"; 3500-as-micros → gate fail; non-multiple-of-10_000 → schema reject + microsToCents throw.
- validate() must be TOTAL and short-circuit remove_entity/v1 without throwing: rollbackAction (executor.ts:197) calls prepare() outside try/catch and hard-blocks on VALIDATE_ONLY, so a throwing validate strands every create-rollback (spec §14). Dedicated test.
- Missing create_adset in executor CREATE_ACTION_TYPES (executor.ts:51) → the tmp: guard (line 58) throws on every compiled adset and snapshot() runs on a tmp: ref. Must be added.
- capabilities() must withhold create types without META_PAGE_ID/META_APP_SECRET (not just the token) so creation is impossible until all credentials exist; VALIDATE_ONLY also fails-closed on Meta creates lacking a rehearsal (defence in depth).
- Uncertain Meta-API shapes asserted only in mocks (picture-URL vs image_hash; validate_only support; DELETE vs status=DELETED; PAUSED-campaign gating; DSA-free non-EU; app-secret-proof enforcement) — all on the first-live-run checklist, not asserted as fact.
- Migration 009 must run before any Meta create on existing workspaces or ACTION_ALLOWED blocks create_adset (allowed_action_types lacks it).
