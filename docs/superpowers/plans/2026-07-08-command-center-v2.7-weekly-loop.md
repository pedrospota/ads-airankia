# Command Center v2.7 — Weekly Loop Completo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete the weekly operator loop: pause/reactivate live keywords, edit ad-group CPC, remove live campaign negatives (all through the edit workbench + rail), and give the operator a client-ready Bitácora export + weekly report page.

**Architecture:** 2 new user verbs (`update_keyword_status`, `update_cpc`) + promotion of `remove_negatives` to user-proposable (rollback path verified unaffected); a new `CPC_DELTA` gate (13→14); edit-doc gains server-owned keyword `status`/`baseNegatives` + client-writable `desiredStatus`/`removeNegatives`/`desired.cpcBidMicros`; the differ emits 4 new row kinds in the existing phase order; report = client-side CSV + an auth-gated print-view page. ONE settings-only migration (010). Scheduling DEFERRED (spec §1.D).

**Tech Stack:** unchanged (Next 16.2.2, TS5, Drizzle, GAQL mocked, bun test).

**Spec:** `docs/superpowers/specs/2026-07-08-command-center-v2.7-weekly-loop-design.md` — THE CONTRACT. §(a) verbs/payloads/touchpoints, §(b) schema+merge rules, §(c) differ table + gate story, snapshot/rollback completeness section, §(e) report, §(f) UI, migration §, and the 4 risks-to-pin. Implement verbatim; the spec cites exact file:line anchors.

## Global Constraints

- Branch `feat/command-center-v27-weekly` off main (spec commit). NEVER push. Commit per task. bun `~/.bun/bin/bun`; tests `~/.bun/bin/bun test src/lib/command`; typecheck `~/.local/bin/bunx tsc --noEmit`. Explicit `git add <paths>`.
- **UNTOUCHED (load-bearing):** `executor.ts`, `state.ts`, `plan-runner.ts`, `blueprint/*`, `networks/meta.ts`, `settings.ts`, `actions-repo.ts`, `request-hash.ts`, the verify sweep loop's READ-only invariant, v1 manual-actions route (stays CC_ACTION_TYPES-only — the new verbs are edit-flow-only proposals).
- `INTERNAL_ACTION_TYPES` becomes `{remove_entity}` ONLY. The promotion-safety pin (spec risk #1) is MANDATORY: a rollback of `add_negatives` must still execute when `remove_negatives` is NOT allow-listed.
- Money: CPC in integer micros, floor 10_000 (US$0.01). `CPC_DELTA` reuses `settings.maxBudgetDeltaPct` (no new column); null `before.cpcBidMicros` fails OPEN with evidence «sin CPC base» (VALIDATE_ONLY is the backstop; CPC open-fail is never over-spend).
- es-MX copy per spec §(f). Zero structural DB change; migration 010 is settings-only + keeps the THREE defaults in lockstep (migrate CREATE TABLE default, 010 ALTER default, `src/lib/schema.ts` Drizzle default — the v2 lesson).

---

### Task 1: Vocabulary + gates + migration 010
**Files:** `src/lib/command/types.ts`, `src/lib/command/gates.ts`, `src/app/api/migrate/route.ts`, `src/lib/schema.ts`. Tests: `gates.test.ts` + `settings.test.ts` (extend).
Implement spec §(a) touchpoints 1-2 + the migration §: `CcMaintenanceActionType`; payloads `UpdateKeywordStatusPayload`/`UpdateCpcPayload`; `RemoveNegativesPayload += removed?`; `CcPayload` union; `EntitySnapshot += cpcBidMicros?`; `CC_SETTINGS_ACTION_TYPES` += the 3 verbs; gates: `INTERNAL_ACTION_TYPES={remove_entity}`, new blocking `CPC_DELTA` (|Δ|/before ≤ maxBudgetDeltaPct; null-before → pass «sin CPC base»), `CURRENCY_SANITY` update_cpc clause (int ≥10_000), `DRIFT` cpcBidMicros both-present clause; migration 010 (backfill UPDATE + ALTER default + INSERT, idempotent) + schema.ts + CREATE TABLE defaults (13-verb list).
- [ ] TDD (gate tests: CPC_DELTA block/pass/null-open; CURRENCY_SANITY cpc floor incl. the cents-as-micros 9_999 reject; DRIFT cpc both-present + legacy-row no-false-block (risk #3); ACTION_ALLOWED normal path for all 3 verbs + remove_entity still internal; settings round-trip keeps the 3) → implement → 288 stay green → tsc 0. Commit `feat(v2.7): maintenance verbs vocabulary + CPC_DELTA gate + migration 010`.

### Task 2: Adapter + verify — mutations, snapshot cpc, rollback recipes, readCampaignTree deltas
**Files:** `src/lib/command/networks/google.ts`, `src/lib/command/verify.ts`. Tests: `google-adapter.test.ts` + `verify.test.ts` (extend).
Implement spec §(a) verb table + touchpoints 3-4 + the snapshot/rollback section: `buildMutation` cases `update_keyword_status` (adGroupCriteria:mutate status ops; fail-closed resourceName guard: contains `/adGroupCriteria/` + starts `customers/${accountRef}/`) and `update_cpc` (adGroups:mutate cpcBidMicros string); `capabilities` += the 2; `snapshot()` ad_group GAQL += `ad_group.cpc_bid_micros` → `cpcBidMicros`; `readCampaignTree`: ad_group GAQL += cpc_bid_micros, keyword GAQL += `ad_group_criterion.status`, NEW 5th GAQL campaign negatives, `RawCampaignTree += campaignNegatives`; `buildRollback` 3 cases per the spec table (self-inverse keywords; update_cpc from before.cpcBidMicros, null when null; remove_negatives → add_negatives(removed), null when removed absent); verify.ts: `VERIFIABLE_ACTION_TYPES += update_cpc`, `computeCheck` cpc branch BEFORE the pause/enable fallback (three-state).
- [ ] TDD: mutation body asserts; resourceName-guard throw; rollback recipes incl. null-before (risk #2) and add_negatives-restore; **the promotion-safety pin (risk #1)** — rollback of add_negatives executes with remove_negatives un-allow-listed (mirror executor rollback-path test fakes); verify cpc landed/drift/unverifiable-null. → 288+ green, tsc 0. Commit `feat(v2.7): google maintenance mutations + cpc snapshot/verify + rollback recipes (remove_negatives promoted)`.

### Task 3: Edit schema + read-tree + mergeEditDoc per-row merge
**Files:** `src/lib/command/edit/schema.ts`, `src/lib/command/edit/read-tree.ts`. Tests: `edit-schema.test.ts` + `edit-read-tree.test.ts` (extend).
Implement spec §(b) verbatim: `baseKeywords[i]` += server-owned `status` + client-writable `desiredStatus?`; campaign += server-owned `baseNegatives` + client-writable `removeNegatives` (⊆-filtered in merge); `existingAdGroup.base/desired += cpcBidMicros` (base nullable; desired int ≥10_000 nullable); `mergeEditDoc`: baseKeywords wholesale-copy → per-row merge matched by resourceName (unknown incoming rows DROPPED); removeNegatives filtered ⊆ stored baseNegatives; read-tree maps keyword status, ad-group cpc (base+desired seed), campaign negatives from the 5th GAQL; blast-bound Zod refine capping non-KEEP dispositions per ad group per spec.
- [ ] TDD: schema accepts/rejects; TAMPER tests (client rewrites baseKeywords status/baseNegatives → stored wins; unknown resourceName in removeNegatives → filtered); read-tree mapping + round-trip parseEditDoc. → green, tsc 0. Commit `feat(v2.7): edit doc pruning/cpc fields — server-owned baselines, per-row merge`.

### Task 4: Differ — 4 emission blocks + throws
**Files:** `src/lib/command/edit/diff.ts`. Tests: `edit-diff.test.ts` (extend).
Implement spec §(c) table verbatim: A2 pause-batches per ad group (after ad-group pauses), B2 update_cpc (expected {cpcBidMicros: base}), C0 remove_negatives (payload.removed from baseNegatives) BEFORE add_negatives, E0 reactivate-batches LAST with enables; batched-per-group (one action per group per direction); es-MX notes per spec; throws: desiredStatus on a negative; removeNegatives resourceName ∉ baseNegatives (risk #4).
- [ ] TDD: each row kind; phase ordering incl. A2/E0 positions preserved vs existing phases; batching (3 keywords → 1 action); expected scoping; both throws; no-op discipline. → green, tsc 0. Commit `feat(v2.7): differ prune/cpc/negatives emissions — batched, phase-ordered, fail-closed`.

### Task 5: Edit workbench + labels UI
**Files:** `src/app/command/editar/{editor-panels,editor-types,editor-preview,editor-client}.tsx`, `editar/[id]/revisar/revisar-client.tsx` (labels/cards additive), `src/app/command/acciones/acciones-client.tsx` (label map), Ajustes settings client (3 checkbox labels — find it via the settings route consumer). 
Implement spec §(f): per-keyword [Pausar]/[Reactivar] with pending inline states + [Deshacer]; CPC field per ad group («En vivo: $X.XX» ghost; disabled «La campaña usa puja automática» when base null); «Negativas de campaña en vivo (N)» list with [Quitar]/strikethrough; first-removal hint; countEdits extended; revisar cards render the new notes; acciones labels. eslint clean.
- [ ] Gates: tsc 0, suite green, eslint clean on editar+acciones. Commit `feat(v2.7): edit workbench pruning + CPC + negatives UI (es-MX)`.

### Task 6: Bitácora export + weekly report
**Files:** `src/app/command/bitacora/{page,bitacora-client}.tsx`, NEW `src/app/command/bitacora/reporte/page.tsx` (+client if needed). Tests: NEW `csv` serializer test (pure function in a lib file, e.g. `src/lib/command/report-csv.ts`).
Implement spec §(e): CSV button (client-side, UTF-8 BOM, RFC-4180, columns per spec incl. Verificada + Por qué (rationale) + Reversión; label «últimas 200 ejecuciones visibles»); map rationale into the DTO in page.tsx; Verificada column; reporte page (auth-gated server component, last-7d done non-dry-run executions grouped Cuenta→Campaña, client-story rows, @media print CSS + «Imprimir / Guardar PDF», «Resumen semanal →» link from Bitácora).
- [ ] TDD the csv serializer (quoting/BOM/columns); gates tsc 0 + suite + eslint. Commit `feat(v2.7): bitácora CSV export + weekly client report page`.

### Task 7: Verification + deploy notes
- [ ] Full suite (expect ≥300) · tsc 0 · build 0 (reporte route present) · smoke :4404 (login 200, /command/bitacora/reporte 404-gated anon).
- [ ] DEPLOY-NOTES v2.7 section: migration 010 required; the promotion note (remove_negatives now user-proposable, remove_entity stays internal); scheduling deferred + escape hatch; CPC_DELTA reuses maxBudgetDeltaPct. Commit + `git log --oneline main..HEAD`.

## Plan self-review
Spec §(a)→T1-2; §(b)→T3; §(c)+gate story→T1 (gates) + T4 (differ); snapshot/rollback→T2; §(e)→T6; §(f)→T5; migration→T1; risks #1→T2 pin, #2→T2, #3→T1, #4→T4. Types: payloads (T1)→T2/T4; RawCampaignTree.campaignNegatives (T2)→T3 read-tree; schema fields (T3)→T4 differ→T5 UI. No placeholders — every task names its spec section + exact deltas.
