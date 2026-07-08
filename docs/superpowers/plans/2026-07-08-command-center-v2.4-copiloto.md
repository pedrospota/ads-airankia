# Command Center v2.4 — Copiloto Anclado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A docked AI copilot in the Google builder AND the edit workbench that proposes node-pinned patches the operator accepts/rejects, with honest `ia` provenance badges flowing to `cc_actions.source` — the AI never executes.

**Architecture:** Extracted OpenRouter tool-loop (`src/lib/llm/tool-loop.ts`) powering a NEW propose-only `/api/command/copiloto` (2 tools: `get_doc`, `propose_patch` with a server dry-run of the SAME pure `applyBlueprintPatch` the accept click runs); a patch layer (`src/lib/command/patch/{schema,apply}.ts`) enforcing WRITABLE_FIELDS per docKind + full-doc re-parse; `_prov` in-doc sibling storing ONLY `'ia'` (manual = absence; downgrade by the centralized `writeField` clearing keys); `_ai` markers feed the existing `source:'copiloto'` stamping. Rail untouched.

**Spec:** `docs/superpowers/specs/2026-07-08-command-center-v2.4-copiloto-design.md` — THE CONTRACT (§a patch contract, §b provenance, §c dock/API/tools/extraction, §e security chain, §f file plan, the two named riskiest seams).

## Global Constraints
- Branch `feat/command-center-v24-copiloto` off main (76fd393). NEVER push. Commit per task. Tests `~/.bun/bin/bun test src/lib/command` (374 baseline) + NEW `src/lib/command/patch` tests; tsc; eslint. Explicit `git add`.
- **UNTOUCHED:** `gates.ts`, `executor.ts`, `actions-repo.ts`, `compile.ts`, `edit/diff.ts`, `mergeEditDoc` (sub-schema EXPORTS only), meta files, `copiloto-tools.ts`, `sentinel.ts`, `llm/{openrouter,index}.ts`, `suggest.ts` server code.
- **No AI-path file imports executor/gates/actions-repo.** `propose_patch` terminates in a card. The only mutation entry is human Accept → `applyBlueprintPatch` → existing autosave → existing server boundaries.
- Bounds (spec §adjudication 4): MAX_ROUNDS=6, 30s/25s budget, max_tokens 2048, history 12 msgs/8k chars, get_doc arrays capped 30, body ≤256KB, ≤3 proposals/turn, ≤20 ops/patch, rationale ≤300, summary ≤160. es-MX copy. `/api/copiloto` refactor must be BEHAVIOR-PRESERVING (its existing tests green before+after).

### Task 1: tool-loop extraction (behavior-preserving)
**Files:** NEW `src/lib/llm/tool-loop.ts`; MODIFY `src/app/api/copiloto/route.ts`.
Implement spec §c "Tool-loop extraction" verbatim: extract ONLY callOpenRouter+wire types+round loop (budget starvation, embedded-200 errors, arg-JSON hardening) from route.ts:109-145/205-305 into `runToolLoop(ToolLoopParams)`; each route keeps its own model policy/trimming/sentinel belt. Refactor /api/copiloto onto it with SAME constants/responses. Run any existing copiloto tests + tsc + manual grep that response shapes unchanged.
- [ ] Verify → commit `refactor(v2.4): extract runToolLoop from /api/copiloto (behavior-preserving)`.

### Task 2: patch layer — schema + apply + prov helpers
**Files:** NEW `src/lib/command/patch/schema.ts`, `src/lib/command/patch/apply.ts`, `src/lib/command/__tests__/patch-apply.test.ts`. MODIFY (exports only): `blueprint/schema.ts` + `edit/schema.ts` sub-schema exports as needed.
Implement spec §a verbatim: patchOp/blueprintPatch zod; `WRITABLE_FIELDS` const registry EXACTLY as spec lists (create: campaign name/bidding/geo/languageCode, budget dailyMicros, adGroup name/cpcMicros/keywords/negatives, ad finalUrl/headlines/descriptions/path1/path2 — NEVER status/channel/nodeId/tempId; edit: EXACTLY the mergeEditDoc-lifted set incl. v2.7 fields); `applyBlueprintPatch` 6-rule ladder (shape→node resolution→field whitelist + per-field sub-schema parse→edit invariants (removeNegatives ⊆ baseNegatives, desiredStatus on existing rows)→immutable rebuild→FULL-doc parse) ALL-OR-NOTHING with es-MX errors; prov helpers (`readProv/stampProv/clearProv/deriveAiMarkers/sanitizeProv`, `ProvenanceMap = Record<string,"ia">`, key `${nodeId|resourceName}:${field}`).
- [ ] TDD: unknown node; EVERY base*/server field rejected per docKind; bad value (sub-schema); blast-bound overflow via patch → reject; all-or-nothing (1 bad op of 3 → zero applied); happy paths both docKinds; prov stamp/clear/derive/sanitize. → green, tsc 0. Commit `feat(v2.4): patch chokepoint — WRITABLE_FIELDS registry + applyBlueprintPatch + prov helpers`.

### Task 3: builder bijection — stateFromDoc
**Files:** MODIFY `src/app/command/crear/builder-types.ts` (+ its test file).
`stateFromDoc(doc, prevState): BuilderState` — inverse of buildDoc for the single-group builder. MANDATORY round-trip test: for a fully-populated state, `stateFromDoc(buildDoc(state,ids), state)` reproduces every writable field (enumerate assertions field-by-field — a missed field silently drops accepted patch values, spec's #2 riskiest seam).
- [ ] TDD → green, tsc 0. Commit `feat(v2.4): stateFromDoc bijection for patch acceptance in the builder`.

### Task 4: provenance plumbing (the riskiest seam)
**Files:** MODIFY `src/app/api/command/blueprint/[id]/route.ts` (edit PUT: after mergeEditDoc, `sanitizeProv(merged, body.doc?._prov)` → re-attach `_prov` + derived `_ai` onto the saved object — spec §b "the one real plumbing change"), `src/lib/command/blueprint/repo.ts` (edit compile branch: read raw `_ai`, `source: aiPaths.has(a.entityRef) ? "copiloto" : "manual"` — repo.ts:186). Tests: extend blueprint-repo tests (edit compile with `_ai` containing an entityRef → that action source copiloto, others manual) + a route-level note (sanitize logic unit-tested via the exported helper on merged docs: keys must resolve to writable fields, cap 500, value 'ia' only).
- [ ] TDD → green (374+), tsc 0. Commit `feat(v2.4): edit provenance survives the merge — sanitizeProv re-attach + source:'copiloto' from _ai`.

### Task 5: the propose-only route
**Files:** NEW `src/app/api/command/copiloto/route.ts`.
Spec §c API verbatim: POST `{messages, docKind, blueprintId, doc}`; getCommandAccess gate; scoped blueprint load + id/docKind match; edit → `mergeEditDoc(stored, doc)` BEFORE grounding; create → parseBlueprint reject-garbage; body ≤256KB; `runToolLoop` with system prompt (covenant + field vocabulary + RSA_SPEC/GOOGLE_THRESHOLDS + account summary), tools get_doc (no args, trimmed 30) + propose_patch (zod parse + DRY applyBlueprintPatch vs the grounded doc; invalid → `{ok:false,errors}` back to the model; valid → proposals accumulator cap 3); response `{reply, proposals, toolsUsed}`; bounds per Global Constraints; never-Anthropic model guard mirroring /api/copiloto.
- [ ] Gates: tsc 0; suite green; eslint. Commit `feat(v2.4): /api/command/copiloto — propose-only tool loop (get_doc + propose_patch dry-run)`.

### Task 6: dock UI + provenance rendering
**Files:** NEW `src/components/command/{copiloto-dock,copiloto-proposal-card,prov-badge}.tsx`; MODIFY `crear/builder-client.tsx` (mount; accept=buildDoc→apply→stateFromDoc; attach `_prov`+`_ai` into the doc sent by the create POST/PUT; centralize writeField clearing prov; ✨ accept stamps 'ia'), `crear/builder-steps.tsx`+`builder-preview.tsx` (ProvBadge + «✦ Pedir al copiloto»), `editar/[id]/editor-client.tsx` (mount; accept=apply→setDoc; PUT carries `_prov`; field edits clear prov) + `editor-panels.tsx` (badges+shortcut) + both revisar clients (per-node «✦ N campos de IA» + badges) + `acciones-client.tsx` Origen badge.
Spec §c UX verbatim: collapsed pill ✦ Copiloto (violet dot pending), expanded right panel min(380px,100vw-32px), Esc/✕, empty-state teaching copy + 3 host-specific chips; card = summary + breadcrumb + old→new rows (live-doc values) + plain-text rationale + Aceptar/Rechazar/Ver nodo; stale node on accept → «El borrador cambió; pídela de nuevo.»
- [ ] Gates: tsc 0; suite green; eslint clean on src/components/command + crear + editar + acciones. Commit `feat(v2.4): copiloto dock + proposal cards + provenance badges (es-MX)`.

### Task 7: verification + deploy notes
- [ ] Full suite (≥390 expected) · tsc 0 · build 0 (`/api/command/copiloto` present) · smoke :4405 (login 200, copiloto route 403 anon). DEPLOY-NOTES v2.4 section: no migration; the propose→accept covenant; OPENROUTER_API_KEY dependency (already in prod); cost bounds; deferred list (Meta dock, get_metrics, v2.5 chat-entry). Commit + report git log.

## Plan self-review
Spec §a→T2; §b→T2 (helpers) + T4 (plumbing) + T6 (rendering); §c→T1 (extraction) + T5 (route) + T6 (dock); §e chain→enforced across T2/T5/T6 with the double-validation preserved; riskiest seams → T4 (prov re-attach, own task) + T3 (bijection, own task with field-by-field test). Types: BlueprintPatch/ApplyPatchResult (T2) → T5/T6; stateFromDoc (T3) → T6; sanitizeProv/deriveAiMarkers (T2) → T4/T6.
