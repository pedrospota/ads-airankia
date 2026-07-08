# Command Center v2.7 — Weekly Loop Completo — Design Spec

Date: 2026-07-08 · Status: approved-for-planning (autonomous continuation; Fase 1 of the full-POC build)
Produced by: 3-lens design workflow (verb-discipline, YAGNI, operator-UX) + opus synthesis. Repo main @ 149770c.

All claims verified against the live code. `settings.ts` is fully constant-driven (validates against `CC_SETTINGS_ACTION_TYPES`, line 16 — no logic change needed to permit new verbs). `listExecutions` returns the full `CcActionRow` (which carries `rationale`), so the report needs no repo change — just a DTO mapping. I have everything needed to synthesize.

---

# Command Center v2.7 — Weekly Loop Completo — MERGED DESIGN (Synthesis + YAGNI)

All paths relative to `/home/coder/projects/ads-airankia`. Verified against main @ 149770c.

## 0. Headline verdict (the minimal slice)

Ship **3 vocabulary additions** — 2 genuinely new user verbs + 1 promotion:

1. **`update_keyword_status`** (NEW) — batched, self-inverse pause/reactivate of positive ad-group keyword criteria.
2. **`update_cpc`** (NEW) — ad-group `cpcBidMicros` change.
3. **`remove_negatives`** (PROMOTED internal→user) — remove live campaign negatives.

**Cut / defer:** keyword hard-delete (`remove_keywords`), campaign bidding-strategy/target (`update_bidding`), and **scheduling (`run_at`) entirely**. Report = client-side CSV + an auth-gated print-view page.

Net footprint: **10 code touchpoints + 1 settings-only migration** (010). **Zero structural DB change. `executor.ts`, `state.ts`, `plan-runner.ts`, `meta.ts`, `request-hash.ts`, `access.ts`, `settings.ts` all byte-identical.** This lands closest to the yagni-slice design, which is the correct YAGNI outcome; I diverge from all three where the evidence demanded it (below).

## 1. Adjudications where the three designs disagreed (with cited evidence)

**A. Pause vs. remove keywords → PAUSE only (self-inverse verb).** `remove_keywords` (in verb-discipline + operator-ux) is CUT: pausing a positive criterion stops it serving = 100% of the hygiene outcome and is fully reversible with quality history intact; removal's rollback is lossy (`create_keywords` mints NEW resourceNames, quality history gone — verb-discipline admits this). Bias is "pause-over-remove where reversibility wins" — it wins decisively for positives. I adopt yagni's **one self-inverse verb** `update_keyword_status {status, keywords}` rather than the `pause_keywords`+`enable_keywords` pair (verb-discipline/operator-ux): rollback is the same verb with inverted status, so pruning introduces **zero new internal-only verbs** and one fewer allow-list toggle.

**B. `remove_negatives` promotion is SAFE — verified.** yagni's pivotal claim is confirmed in code: `rollbackAction` (executor.ts:200-202) filters blocking gates to `["KILL_SWITCH","CAPABILITY","CURRENCY_SANITY","VALIDATE_ONLY"]` — **ACTION_ALLOWED is not a hard blocker on the rollback path.** Therefore promoting `remove_negatives` out of `INTERNAL_ACTION_TYPES` does not break its internal use as the rollback of `add_negatives`: that rollback still executes even when the operator hasn't allow-listed `remove_negatives`. This lets me PROMOTE (reuse the existing verb string, existing `buildMutation` case at google.ts:171-173, and existing `capabilities.actionTypes` entry at google.ts:317) instead of minting verb-discipline's parallel `remove_negative_keywords` — one fewer verb, one fewer wire body. `remove_entity` stays the **sole** `INTERNAL_ACTION_TYPES` member (it is the entity-demolisher; keeping it internal is defense-in-depth so it can never be allow-listed).

**C. Bidding → CPC only.** `update_bidding` (verb-discipline) is CUT. Google target/strategy changes reset the smart-bidding learning phase; verb-discipline itself has to invent a 15th gate (`GOOGLE_LEARNING_RESET`) to cover it. Bias: "CPC-only bidding if strategy changes need a new gate story." They do. Defer.

**D. Scheduling → DEFER ENTIRELY (siding with yagni over operator-ux).** This is the hardest call, adjudicated honestly:
- The verify sweep's READ-only invariant is load-bearing and boot-asserted (verify.ts:1-7, 184-185; `assertTransition` at :25; no `adapter.execute` anywhere). Page-load execution is rejected.
- External cron stays rejected for the v2.6 RLS reason — unchanged.
- The only invariant-clean trigger — the semi-automatic "N programadas vencidas → Ejecutar ahora" one-click (operator-ux) — **cannot deliver the feature's actual value.** Every GOAL use case is time-critical ("raise Friday 18:00, lower Monday 08:00, enable on launch date"). A one-click that only fires when the operator next opens `/command` runs the Friday raise whenever they happen to visit — possibly Monday. A schedule that fires late while *presenting itself as scheduled* is worse than no schedule, because it corrupts the operator's mental model. The existing approved-actions queue in Acciones already IS the "approved, fires on my click" surface; `run_at` + a "vencidas" nudge duplicates it.
- Deferring avoids the **first structural `cc_actions` ALTER since 009**, and avoids the `run_at`↔`CC_APPROVAL_TTL_HOURS` conflict that forces operator-ux to rewrite `expireStaleApproved`'s predicate (a change that would touch the sweep's repo layer).

Verdict: DEFER, escape hatch named — revisit when a **service-role background executor** (pg_cron/edge function with its own auth story) exists; *that* is when `run_at` earns its migration. The bias permits semi-auto but explicitly invites DEFER "if no clean answer" — there is none that delivers dayparting this slice.

## (a) New verbs, payloads, and the vocabulary-touchpoint checklist

### Verbs

| Verb | Kind | entityKind / entityRef | Payload | Mutation |
|---|---|---|---|---|
| `update_keyword_status` | NEW user | `ad_group` / ad-group numeric id | `UpdateKeywordStatusPayload { status: "PAUSED"\|"ENABLED"; keywords: Array<{ resourceName: string; text: string }> }` (`text` rides along for ledger/Bitácora legibility only) | `adGroupCriteria:mutate`, ops = `keywords.map(k => ({ updateMask:"status", update:{ resourceName:k.resourceName, status } }))` |
| `update_cpc` | NEW user | `ad_group` / ad-group numeric id | `UpdateCpcPayload { newCpcBidMicros: number }` (int micros) | `adGroups:mutate`, `{ updateMask:"cpcBidMicros", update:{ resourceName:customers/x/adGroups/id, cpcBidMicros:String(v) } }` |
| `remove_negatives` | PROMOTED | `campaign` / campaign numeric id | `RemoveNegativesPayload { resourceNames: string[]; removed?: Array<{ text:string; match:"EXACT"\|"PHRASE"\|"BROAD" }> }` (`removed` is what makes rollback possible) | UNCHANGED — `campaignCriteria:mutate` remove ops (google.ts:171-173) |

`update_keyword_status` `buildMutation` fail-closed guard: every `resourceName` must contain `/adGroupCriteria/` and start with `customers/${accountRef}/`, else throw (belt-and-braces even though resourceNames come from the server-owned baseline). Google `validateOnly` (google.ts:362-370) turns any throw into a `VALIDATE_ONLY` block before a live mutation.

### Vocabulary-touchpoint checklist (v2.2 style — **10 code + 1 migration**)

1. **`src/lib/command/types.ts`** — new `CcMaintenanceActionType = "update_keyword_status" | "update_cpc"`; `CcInternalActionType` adds the two (`remove_negatives` already present); update the doc-comment at lines 7-9/17-24 (**`remove_negatives` is no longer internal-only — only `remove_entity` is**); `CC_SETTINGS_ACTION_TYPES` += `"update_keyword_status","update_cpc","remove_negatives"` and widen its element type; new `UpdateKeywordStatusPayload`/`UpdateCpcPayload`; `RemoveNegativesPayload` += `removed?`; `CcPayload` union += the two; `EntitySnapshot` += `cpcBidMicros?: number | null`; widen `CcSettingsValues.allowedActionTypes` element type.
2. **`src/lib/command/gates.ts`** — `INTERNAL_ACTION_TYPES = new Set(["remove_entity"])`; new blocking gate **`CPC_DELTA`** (13→14 gates); `CURRENCY_SANITY` gains an `update_cpc` clause (integer micros, floor `10_000` = US$0.01); `DRIFT` gains a `cpcBidMicros` both-present clause; update the `actionAllowed` comment.
3. **`src/lib/command/verify.ts`** — `VERIFIABLE_ACTION_TYPES` += `"update_cpc"`; `VerificationCheck.checkedField` union += `"cpcBidMicros"`; `computeCheck` gains an `update_cpc` branch **before** the `pause|enable` fallback (the fallback assumes pause/enable).
4. **`src/lib/command/networks/google.ts`** — `capabilities.actionTypes` += `"update_keyword_status","update_cpc"` (`remove_negatives` already at :317); `buildMutation` += 2 cases (`remove_negatives` unchanged); `buildRollback` += 3 cases (below); `snapshot()` ad_group branch (:341-347) GAQL += `ad_group.cpc_bid_micros` → `cpcBidMicros`; `readCampaignTree` (:494-517): ad_group GAQL += `ad_group.cpc_bid_micros`, keyword GAQL += `ad_group_criterion.status`, NEW 5th GAQL for campaign negatives, `RawCampaignTree` += `campaignNegatives`.
5. **`src/lib/command/edit/schema.ts`** — schema deltas + `mergeEditDoc` rules (§b).
6. **`src/lib/command/edit/read-tree.ts`** — map keyword `status`, ad-group `cpcBidMicros` (base+desired seed), campaign `baseNegatives`.
7. **`src/lib/command/edit/diff.ts`** — `EditCompiledAction.actionType` comment update; 4 new emission blocks (§c); 2 fail-closed throws.
8. **`src/app/api/migrate/route.ts`** — migration `010_command_center_v2_7` (settings-only, §migration).
9. **UI cluster** — `editar/{editor-panels,editor-preview,editor-types,editor-client}.tsx` + `editar/revisar/*`; `acciones/acciones-client.tsx` label map (:31); Ajustes settings client (3 checkbox labels, auto-picked from `CC_SETTINGS_ACTION_TYPES`); `bitacora/bitacora-client.tsx` (CSV button, verified column, Resumen link); `bitacora/page.tsx` (map `rationale` into DTO).
10. **`__tests__`** — gates (CPC_DELTA / CURRENCY_SANITY-cpc / DRIFT-cpc), diff (4 phases + 2 throws), verify (update_cpc `computeCheck`), rollback (`remove_negatives→add_negatives`; **the promotion-safety pin**: rollback of `add_negatives` still executes when `remove_negatives` is NOT allow-listed), csv serializer.

**NOT touched (verified): `settings.ts`** validates against `CC_SETTINGS_ACTION_TYPES` (line 16), so the 3 verbs are permitted automatically. **`actions-repo.ts`** — `listExecutions` (:114) already returns the full `CcActionRow` (carries `rationale` from cc_actions:542), so the report needs only a DTO map, no repo change.

## (b) Edit-doc / schema deltas + `mergeEditDoc` rules

- **`baseKeywords[i]`** (schema.ts:48) += server-owned `status: z.enum(["ENABLED","PAUSED"])` and client-writable `desiredStatus: z.enum(["ENABLED","PAUSED"]).optional()`. `mergeEditDoc` changes the wholesale copy at :119 to a **per-row merge**: keep all stored fields server-owned; lift `desiredStatus` from the incoming row **matched by `resourceName` within the stored set**; **drop unknown incoming resourceNames** (structurally impossible to prune a keyword the server didn't load — the load-bearing v2.3 property).
- **`campaign`** += server-owned `baseNegatives: z.array(z.object({ resourceName, text, match })).default([])` (loaded by the new 5th GAQL: `campaign_criterion WHERE campaign.id=X AND campaign_criterion.type='KEYWORD' AND campaign_criterion.negative=true AND campaign_criterion.status != 'REMOVED'`) and client-writable `removeNegatives: z.array(z.string()).default([])`. `mergeEditDoc`: `baseNegatives` from stored; `removeNegatives` from incoming **filtered to ⊆ stored `baseNegatives` resourceNames**; the differ re-validates fail-closed (throws on an unknown resourceName). Two-layer guard.
- **`existingAdGroup.base`** += `cpcBidMicros: z.number().int().nullable()`; **`existingAdGroup.desired`** += `cpcBidMicros: z.number().int().min(10_000).nullable()`. **No `mergeEditDoc` logic change**: `base` is already copied wholesale-from-stored (server-owned) and `desired` is already taken wholesale-from-incoming (schema.ts:118) — the Zod schema addition suffices.

## (c) Differ mapping rows, expected/DRIFT baselines, rollback recipes

Phase order preserves the existing safety property (enables LAST). Each row is **one batched action per ad group/campaign** (BLAST_RADIUS counts 1 per batch — an operator pruning 30 keywords is one decision).

| Phase | Condition | Emits | entityKind/Ref | expected (DRIFT) | Rollback recipe |
|---|---|---|---|---|---|
| **A2** (after ad-group pauses) | `baseKeywords` where `desiredStatus==="PAUSED" && status==="ENABLED" && !negative`, grouped per ad group | `update_keyword_status {status:"PAUSED", keywords}` | `ad_group` / `g.id` | `null` | same verb, `status:"ENABLED"`, same keywords |
| **B2** (after budget) | `g.desired.cpcBidMicros !== g.base.cpcBidMicros`, both non-null (setting where base null allowed; clearing→null deferred) | `update_cpc {newCpcBidMicros}` | `ad_group` / `g.id` | `{ cpcBidMicros: g.base.cpcBidMicros }` | `update_cpc(before.cpcBidMicros)`; **null if `before.cpcBidMicros==null`** |
| **C0** (before add_negatives) | `campaign.removeNegatives` non-empty | `remove_negatives {resourceNames, removed:[{text,match}] from baseNegatives}` | `campaign` / `c.id` | `null` | `add_negatives(removed)` |
| **E0** (with enables, LAST) | `desiredStatus==="ENABLED" && status==="PAUSED" && !negative`, grouped | `update_keyword_status {status:"ENABLED", keywords}` | `ad_group` / `g.id` | `null` | same verb, `status:"PAUSED"` |

Differ throws (fail-closed, mirroring the tmp:-guard self-assert at diff.ts:249-253): `desiredStatus` set on a **negative** baseKeyword; `removeNegatives` resourceName not in `baseNegatives`. es-MX notes: `«Pausar N keyword(s) en "grupo"»`, `«CPC de "grupo": 0.80 → 0.65»`, `«Quitar N negativa(s) de "campaña"»`.

**DRIFT honesty:** `update_cpc` gets a real field-scoped `expected.cpcBidMicros` and the DRIFT gate compares it present-only (exactly the `dailyBudgetMicros` pattern, gates.ts:65-71). The keyword-batch and negative-removal verbs get `expected:null` → DRIFT passes "Sin baseline"; per-criterion drift baselining would need a criterion-level before-snapshot the rail doesn't carry. Their protection is (a) the 60-min `EDIT_BASELINE_MAX_AGE_MS` compile ceiling and (b) `validateOnly` rehearsal (pausing/removing an already-removed criterion fails rehearsal → VALIDATE_ONLY blocks). This is no weaker than a manual pause in the Google UI (which faces no drift check at all); worst outcome is a no-op or a Google error, never over-spend.

## Snapshot + rollback completeness (adversarial point 2)

`snapshot()` and `EntitySnapshot` gain `cpcBidMicros` — the ad_group GAQL (google.ts:343) **must** add `ad_group.cpc_bid_micros` or `update_cpc` rollback/DRIFT/verify are all blind. `buildRollback` new cases:
- `update_keyword_status` → same verb, inverted status, same `keywords`. **Payload self-sufficient; before-snapshot carries nothing.** Fully reversible.
- `update_cpc` → `update_cpc(before.cpcBidMicros)`; **null when `before.cpcBidMicros==null`** (honestly un-rollbackable — smart-bidding ad group with no manual bid; matches `budget_update` null precedent at google.ts:448).
- `remove_negatives` → `add_negatives(payload.removed)` when `removed` present; **null when absent** (the internal rollback-of-`add_negatives` usage passes only `resourceNames`, so it returns null — no rollback-of-rollback, exactly today's behavior). Re-created negatives get NEW resourceNames — acceptable, negatives carry no quality history.

`verify.ts`: `update_cpc` proves landing via `after.cpcBidMicros === payload.newCpcBidMicros` (three-state: null actual → "unverifiable" skip). The keyword/negative batch verbs stay OUT of `VERIFIABLE_ACTION_TYPES` — the sweep's one-read primitive is a PARENT `snapshot()`, which cannot prove per-criterion status/absence; their landing proof is the ledger's per-operation resourceNames. Criterion-level GAQL verification is a clean future sweep extension (still READ-only) — deferred.

## Gate story (adversarial point 1 — no user verb bypasses a manual-equivalent gate)

13 → **14 gates** (one new: `CPC_DELTA`). All three verbs flow through `executeAction` → the full suite.
- **ACTION_ALLOWED**: all 3 pass the normal allow-list path; `INTERNAL_ACTION_TYPES` = `{remove_entity}` only. The one nuance is `remove_negatives`'s dual use: as a USER proposal it faces ACTION_ALLOWED (must be allow-listed); as the INTERNAL rollback of `add_negatives` it rides the `rollbackAction` hard-blocker filter that skips ACTION_ALLOWED (executor.ts:200-202) — **the same rollback-always-executes rule that already governs `remove_entity` and every budget/pause/enable rollback**. No manual-equivalent gate is bypassed on the user path. Honest coupling: `add_negatives`-rollback correctness now depends on that filter list → **pinned by a test**.
- **CAPABILITY**: free Meta coverage — the verbs aren't in `meta.ts` capabilities, so CAPABILITY blocks them on Meta rows (meta.ts untouched).
- **CPC_DELTA** (new, blocking): `|new − before.cpcBidMicros| / before ≤ settings.maxBudgetDeltaPct` (reuses the existing money-delta cap — **no new settings column, no migration for it**). Null `before` fails **open** with evidence "sin CPC base" (smart-bidding ad groups legitimately have no manual CPC); `VALIDATE_ONLY` is the real backstop there (Google rejects an invalid bid at rehearsal, pre-mutation). CPC isn't budget, so open-fail here is never over-spend.
- **CURRENCY_SANITY**: `update_cpc` clause — positive integer micros ≥ `10_000` (US$0.01 floor; CPCs are legitimately sub-unit, unlike the 1-unit budget floor).
- **DRIFT**: new `cpcBidMicros` present-only clause.
- **BLAST_RADIUS**: batch = 1 action; to bound an unbounded batch, the edit schema caps non-KEEP dispositions per ad group per save (Zod refine) — the blast bound lives where the batch is formed.
- **VALIDATE_ONLY**: automatic — `network==="google_ads"` already forces rehearsal (gates.ts:121-126); `buildMutation` supports all 3, so every one is rehearsed and its guards surface as VALIDATE_ONLY blocks.
- **BUDGET_DELTA / ABS_BUDGET_CAP / LEARNING_PHASE / META_LEARNING_RESET / PAUSED_ON_CREATE / TRACKING_SIGNAL / KILL_SWITCH**: N/A→pass, unchanged (keyword/CPC ops don't scale spend; no learning-reset gate needed because strategy changes are cut).

## mergeEditDoc boundary (adversarial point 3)

Covered in §b: `baseKeywords`/`baseNegatives` stay server-owned; only `desiredStatus`/`removeNegatives` cross from the client, matched/filtered against server-owned resourceNames with unknowns dropped, and the differ re-throws on any unknown. `desired.cpcBidMicros` needs no merge change (desired is already wholesale-from-incoming). The only behavioral change to `mergeEditDoc` is turning the wholesale `baseKeywords` copy (schema.ts:119) into a per-row merge — new code, directly tested.

## (d) Scheduling — DEFERRED (full reasoning above, §1.D)

No `run_at`, no structural migration, `executor.ts`/`expireStaleApproved` byte-identical. Deferred with the escape hatch named: a future service-role background runner.

## (e) Report — CSV + print-view, no token links

- **CSV** (client-side, zero new server surface): "Exportar CSV" in `bitacora-client.tsx` serializes the already-loaded rows (page.tsx maps `listExecutions(…,200)`), UTF-8 BOM + RFC-4180 quoting for Excel es-MX. Columns: **Fecha, Red, Cuenta, Entidad, Acción** (es-MX label), **Antes→Después, Actor, Estado, Verificada** (`actionStatus==="verified"` — already in DTO), **Por qué** (`rationale`), **Reversión** (`rollbackNote`). Label the button "últimas 200 ejecuciones visibles" so truncation is visible.
- **Weekly summary — NEW `src/app/command/bitacora/reporte/page.tsx`** (server component, auth-gated; **not** the `/r/[account]/[token]` signed-link pattern — that's a new token lifecycle for the mutation ledger, deferred). Same `listExecutions` join filtered to `validate_only=false AND status='done' AND created_at >= now()-7d`, grouped Cuenta→Campaña. Each row = the client-story sentence: fecha · acción (es-MX) · antes→después · **por qué** (`cc_actions.rationale`) · badge ✓ Verificada / Ejecutada / Revertida. `@media print` CSS + "Imprimir / Guardar PDF" (`window.print()`) — what the media buyer attaches to the client email. **No schema change:** `rationale` is already on `cc_actions`; `listExecutions` already returns the full action row — map `rationale` into `ExecutionDto` in `page.tsx`.

## (f) UI deltas (es-MX)

- **Edit workbench (`editar/editor-panels.tsx`)**: live keyword rows become full-opacity with per-row `[Pausar]`/`[Reactivar]` (positives only; negatives show no status control); pending states render inline (PAUSE = amber "se pausará", ENABLE = green "se reactivará", each with `[Deshacer]`). New "CPC máx." money Field per ad group next to Estado, with a "En vivo: $X.XX" ghost line; disabled with "La campaña usa puja automática" when the strategy is smart-bidding. New "Negativas de campaña en vivo (N)" list with per-row `[Quitar]`/strikethrough. First-removal one-time hint: "Pausar es reversible; quitar negativas re-crea recursos nuevos al revertir."
- **`acciones-client.tsx` label map (:31)** += `update_keyword_status: "Pausar/Reactivar keywords"`, `update_cpc: "Cambiar CPC"`, `remove_negatives: "Quitar negativas"`. `revisar` cards render the differ notes with existing machinery.
- **Ajustes**: 3 new checkboxes auto-derived from `CC_SETTINGS_ACTION_TYPES` (add es-MX labels only).
- **Bitácora**: "Exportar CSV" + "Resumen semanal →" link; add a Verificada column.
- **Acciones / Novedades / resumen**: UNTOUCHED — new verbs flow through as ordinary rows.
- **Deliberately deferred**: a search-term view to inform pruning decisions (no `search_term_view` GAQL exists in-app today; it's a real new read surface — must not ride a pruning slice). A muted "revisa términos de búsqueda en Google Ads" hint links out.

## (g) Deferred list

- `remove_keywords` (hard-delete positives) — pause achieves identical delivery; deletion's rollback is lossy.
- Ad-group-level negative removal — slice covers campaign negatives (the GOAL's "remove negatives from live campaigns"); `remove_negatives` is campaign-scoped by `buildMutation` construction.
- `update_bidding` (campaign strategy/target) — needs a Google learning-reset gate story + target-delta caps + a strategy-field-swap mutation; own slice.
- **Scheduling (`run_at`)** — no invariant-clean unattended trigger; semi-auto one-click can't deliver time-critical dayparting; revisit with a service-role background runner.
- Signed-link `/r`-style client report — print-view + CSV covers the weekly send; token lifecycle deferred.
- Criterion-level sweep verification of keyword/negative batches; clearing a CPC back to null; a dedicated `maxCpcDeltaPct` setting (reuse `maxBudgetDeltaPct`); Meta pruning/bidding parity (CAPABILITY blocks free).

## (h) File-level manifest

**NEW:** `src/app/command/bitacora/reporte/page.tsx` (+ `reporte-client.tsx` only if interactivity is needed); tests `__tests__/{diff-prune,gates-cpc,verify-cpc,rollback-remove-negatives,csv}.test.ts`.

**MODIFIED:** `src/lib/command/types.ts` · `gates.ts` · `verify.ts` · `networks/google.ts` · `edit/schema.ts` · `edit/read-tree.ts` · `edit/diff.ts` · `src/app/api/migrate/route.ts` · `src/app/command/editar/{editor-panels,editor-preview,editor-types,editor-client}.tsx` (+ `editar/revisar/*`) · `src/app/command/acciones/acciones-client.tsx` · Ajustes settings client · `src/app/command/bitacora/{page,bitacora-client}.tsx`.

**UNTOUCHED (load-bearing, verified):** `executor.ts` · `state.ts` · `plan-runner.ts` & `blueprint/*` · `networks/meta.ts` · `networks/index.ts` · `request-hash.ts` · `access.ts` · `settings.ts` (constant-driven) · `actions-repo.ts` (`listExecutions` already returns the full action row) · `api/command/actions` route (v1 manual path stays `CC_ACTION_TYPES`-only) · `api/command/verify` & the sweep loop (READ-only invariant intact) · `execute/route.ts` TTL backstop.

## Migration count (adversarial point 4 — one migration, justified)

**`010_command_center_v2_7`** — settings-only, additive, mirror of 008/009 exactly (route.ts:612-626):
```
UPDATE cc_settings SET allowed_action_types =
  allowed_action_types || '["update_keyword_status","update_cpc","remove_negatives"]'::jsonb
  WHERE NOT (allowed_action_types ? 'update_keyword_status');
ALTER TABLE cc_settings ALTER COLUMN allowed_action_types SET DEFAULT
  '["budget_update","pause","enable","add_negatives","create_budget","create_campaign",
    "create_ad_group","create_keywords","create_ad","create_adset",
    "update_keyword_status","update_cpc","remove_negatives"]'::jsonb;   -- 13-verb list
INSERT INTO schema_migrations (version) VALUES ('010_command_center_v2_7') ON CONFLICT DO NOTHING;
```
Justification: without the backfill `UPDATE`, `ACTION_ALLOWED` blocks all 3 verbs on existing workspaces; without the `ALTER … DEFAULT` (kept in lockstep with the backfill), a future bare-inserted `cc_settings` row would re-block them. **No `cc_actions` ALTER** — scheduling is deferred, so the first structural migration since 009 is deliberately not spent. `CPC_DELTA` reuses `max_budget_delta_pct` → no new settings column.

## Key risks to pin with tests

1. **Promotion coupling** — `remove_negatives`'s internal rollback-of-`add_negatives` now relies on `rollbackAction`'s hard-blocker filter ignoring ACTION_ALLOWED (executor.ts:200-202). Pin: rollback of `add_negatives` executes when `remove_negatives` is un-checked in settings. If that filter ever tightens, this test fails loudly instead of breaking rollbacks silently.
2. **`update_cpc` null-before** yields a null rollback recipe (honestly un-rollbackable), not a bogus one; and Google's rejection of a manual CPC on a smart-bidding ad group surfaces as readable `VALIDATE_ONLY` evidence.
3. **DRIFT `cpcBidMicros`** uses the both-present pattern (gates.ts:65-71) so legacy approved rows without the field don't false-block.
4. **Differ throw-paths** (`desiredStatus` on a negative; `removeNegatives` outside `baseNegatives`) directly tested, mirroring the tmp:-guard self-assert.
