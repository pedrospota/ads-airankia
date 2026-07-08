# Command Center v2.4 — Copiloto Anclado — Design Spec

Date: 2026-07-08 · Status: approved-for-planning (Fase 3 of the full-POC build)
Produced by: 3-lens design workflow (patch-safety, YAGNI, operator-UX) + opus synthesis. Repo main @ f7c2b2e.

All load-bearing claims verified in code at f7c2b2e. Key confirmations: route bounds (route.ts:41-46), the `_ai` read path stamping `source:'copiloto'` off raw jsonb via `localRef` on the **create** branch only (repo.ts:229-252) while **edit** (repo.ts:186) and **meta** (repo.ts:217) hardcode `source:"manual"`; create PUT saves RAW `body.doc` so siblings survive (route.ts:134) but edit PUT saves the `mergeEditDoc` output which strips siblings (route.ts:75); the exact client-writable set in `mergeEditDoc` (edit/schema.ts:139-224); nodeIds on campaign/budget/adGroup/ad only, keywords/negatives as id-less arrays (blueprint/schema.ts). Here is the merged design.

---

# Command Center v2.4 — Copiloto Anclado — MERGED DESIGN (synthesis + YAGNI-critic)

**Thesis, enforced by the file plan:** AI PROPOSES → human ACCEPTS → gates ENFORCE. The copilot's *only* effect channel is `propose_patch` → a card → a human click → `applyBlueprintPatch` → the existing autosave → the existing rail. No AI code path imports `executor`/`gates`/`actions-repo`. Slice 1 = **Google create + Google edit**, **2 tools**, **no streaming**, **no persistence**, provenance as an in-doc `_prov` sibling storing **only `'ia'`**, and the tool-loop extracted **once** (this dock is the sketch's mandated "second consumer").

## Adjudications where the three inputs conflicted (YAGNI-critic rulings)

1. **Provenance stores only `'ia'`** (not the 4-enum). `dato`/`auto`/`manual` are *derived*, never written — this is what makes provenance un-lie-able (see B). Kills operator-ux's stored `'auto'`.
2. **`get_metrics` is deferred.** Slice-1 grounds on the doc (edit baselines are already in it) + static `knowledge.ts`. Live v2.6 `listCampaignMetrics` is a trivial later add and expands cost/injection surface now. Owned tradeoff: "¿qué pauso según 30 días?" is weaker in slice 1; the operator has the ops-loop views elsewhere.
3. **The per-step Manual/AI mode toggle is CUT** (a mode implies the AI *runs* the step, contradicting propose→accept and adding state to audit). Honored instead as a thin **"✦ Pedir al copiloto"** shortcut per step/panel that opens the dock pre-seeded. **This cut is flagged to the roadmap owner** — it is named in the binding sketch.
4. **Bounds reuse the proven `/api/copiloto` numbers**, tightening only history depth because the doc rides each request: `MAX_ROUNDS=6`, 30s/25s budget, `max_tokens 2048`, **history 12 msgs / 8k chars** (vs 20), `get_doc` arrays trimmed to 30 items, body ≤256KB, ≤3 proposals/turn, ≤20 ops/patch, `rationale`≤300, `summary`≤160.
5. **New route, not a `mode` on `/api/copiloto`** — different auth (`getCommandAccess` vs raw session), disjoint tool belt, different response shape.

---

## (a) The patch contract + `applyBlueprintPatch`

**`src/lib/command/patch/schema.ts`** (NEW, isomorphic — zod only, zero server imports):

```ts
export const MAX_PATCH_OPS = 20;

export const patchOpSchema = z.object({
  nodeId:   z.string().min(1),        // create: node.nodeId; edit: resourceName (root = "campaign")
  field:    z.string().min(1),        // whitelisted per docKind × node kind (fail-closed)
  value:    z.unknown(),
  rationale:z.string().min(1).max(300),
});
export const blueprintPatchSchema = z.object({
  docKind: z.enum(["google_create", "google_edit"]),
  summary: z.string().min(1).max(160),
  ops:     z.array(patchOpSchema).min(1).max(MAX_PATCH_OPS),
});
export type BlueprintPatch = z.infer<typeof blueprintPatchSchema>;

// Explicit const registry — anything NOT listed is rejected.
export const WRITABLE_FIELDS: Record<"google_create"|"google_edit", Record<NodeKind, readonly string[]>>;
//  google_create — campaign: name, bidding, geo, languageCode | budget: dailyMicros
//                  adGroup: name, cpcMicros, keywords, negatives | ad: finalUrl, headlines, descriptions, path1, path2
//                  (NEVER status/channel — schema literals — nor nodeId/tempId)
//  google_edit    — EXACTLY the mergeEditDoc-lifted set (edit/schema.ts:139-224):
//                  campaign: desired.status, desired.dailyBudgetMicros, newNegatives, removeNegatives
//                  adGroup:  desired.status, desired.cpcBidMicros, newKeywords, newAds
//                  baseKeyword row: desiredStatus | existing ad: replacement
//                  (every base*/resourceName/id/loadedAt is unreachable BY CONSTRUCTION)
```

**`src/lib/command/patch/apply.ts`** (NEW — THE chokepoint, pure, no rail/IO imports):

```ts
export type PatchTarget =
  | { docKind: "google_create"; doc: CcBlueprintDoc }
  | { docKind: "google_edit";   doc: GoogleSearchEditDoc };

export type ApplyPatchResult =
  | { ok: true;  doc: PatchTarget["doc"]; touched: Array<{ nodeId: string; field: string }> }
  | { ok: false; errors: Array<{ opIndex: number; message: string }> };   // es-MX, shown to model AND human

export function applyBlueprintPatch(target: PatchTarget, patch: BlueprintPatch): ApplyPatchResult;
```

Rules — enforced **in order**, **ALL-OR-NOTHING** (one bad op rejects the whole patch; input never mutated — an accepted card is a unit, partial apply would make the card lie):

1. `blueprintPatchSchema.parse` the patch shape.
2. **Node resolution.** create → nodeId ∈ {campaign, budget, an adGroup, an ad} `nodeId`; edit → nodeId ∈ resourceNames present (+ literal `"campaign"`). Unknown → reject `UNKNOWN_NODE` (node-pinned by contract).
3. **Field ∈ WRITABLE_FIELDS[docKind][nodeKind]**, and `value` parses against **that field's own exported sub-schema** (reuse the real sub-schemas from `blueprint/schema.ts` / `edit/schema.ts` — export where needed, never duplicate).
4. **Edit invariants mirrored from `mergeEditDoc`:** `removeNegatives` ⊆ `baseNegatives[].resourceName`; `desiredStatus` only on keyword rows that exist.
5. **After splicing all ops (immutable rebuild): full-doc `blueprintDocSchema.parse` / `editDocSchema.parse`** — this re-fires the bidding `superRefine` and the `EDIT_BATCH_MAX` blast bounds. Parse failure → reject.
6. No side effects, no persistence, no `cc_actions`. Caller decides.

**Where it lives / who calls it:** `src/lib/command/patch/` (sibling of `blueprint/`, `edit/`). Pure + isomorphic ⇒ **one implementation, three call sites**: builder accept, editor accept, and the new route's `propose_patch` executor as a **server dry-run** (so the model can never surface a card the accept path would reject, and gets corrective es-MX errors inside the loop).

**Builder wrinkle (verified):** `/command/crear` holds `BuilderState`, not the doc. Accept = `applyBlueprintPatch({docKind:"google_create", doc: buildDoc(state, ids)}, patch)` → on `ok`, `setState(stateFromDoc(result.doc, state))` via a NEW inverse `stateFromDoc` in `builder-types.ts` (a clean bijection for the single-group builder — **mandatory round-trip unit test**; a missed field silently drops an accepted value). The editor holds the doc directly: Accept = `setDoc(result.doc)`.

## (b) Provenance — storage, flow, rendering

**Key:** `` `${nodeId}:${field}` `` (create) / `` `${resourceName}:${field}` `` (edit) — same identity as the patch contract. Array fields (keywords/negatives/headlines) get **list-level** provenance only (no item ids; per-item deferred).

**Stored value: only `'ia'`.** The conceptual 4-value model resolves as: **`dato`** = structural (every edit `base*`/`baseKeywords`/`baseNegatives` field — read-only by `mergeEditDoc` anyway); **`auto`** = untouched system default (create `status:PAUSED`, default geo/lang, `desired===base`) — **not badged in slice 1, so not stored**; **`manual`** = a writable field with no `_prov` entry; **`ia`** = value came from an accepted `propose_patch` op **or** an accepted per-field ✨ suggest. So `ProvenanceMap = Record<string, "ia">` — minimal, honest, cheap.

**Downgrade enforcement (the critique-2 answer):** the ONLY writer of `'ia'` is the accept path (`applyBlueprintPatch` + ✨). **Every other writable-field mutation in builder/editor routes through one `writeField(key, value)` helper that `delete`s `_prov[key]`.** Editing an `ia` field afterward downgrades it to manual by construction. Centralizing writes through the single helper is the enforcement; a test ("edit each writable field after an accept ⇒ badge downgrades") is the guard. **Residual (accepted, cosmetic):** a compromised client can mislabel attribution (`source:'copiloto'` vs `'manual'`) — it affects *labels only, never payloads*, and **no gate keys on `source`** — identical trust level to the pre-existing `_ai` convention.

**Storage:** in-doc raw sibling `_prov`, following the exact `_ai` convention (zod doesn't declare it; `parseBlueprint`/`parseEditDoc` strip it; readers pull it off raw jsonb like repo.ts:229). Zero new tables/columns.
- **Create:** works for free — the create PUT saves RAW `body.doc` (route.ts:134), so `_ai` + `_prov` ride along.
- **Edit:** the edit PUT saves `mergeEditDoc`'s parsed output (route.ts:75), which strips siblings. **The one real plumbing change:** after `mergeEditDoc`, the route must **`sanitizeProv(merged, body._prov)`** (keys must resolve to writable field keys of the merged doc; value `'ia'`; cap ~500 entries) and re-attach `_prov` + derived `_ai` before `saveBlueprintDoc`. ~15 lines. **This needs its own test** — if forgotten/mis-ordered, edit provenance silently drops to manual (guts deliverable-b for edit; a badge/source bug, not a safety bug).

**Flow to `cc_actions.source`:**
- **Create:** on save, `deriveAiMarkers(doc, prov)` appends the **`tempId`** (compile `localRef` = tempId) of any node with ≥1 `'ia'` field into `_ai`. The dormant read path (repo.ts:229-252) then stamps `source:'copiloto'` unchanged — this finally gives it a writer.
- **Edit:** modify repo.ts:186 (currently hardcoded `source:"manual"`) to read raw `_ai` and set `source: aiPaths.has(a.entityRef) ? "copiloto" : "manual"` — matching on `entityRef` (resourceName), the stable identity that equals the patch/prov key. ~10 lines. Coarse (action-level), matching the create path's granularity.

**Rendering:** one `src/components/command/prov-badge.tsx` — **`IA`** chip (accent, "Sugerido por el copiloto y aceptado por ti"), **`Dato`** chip (muted, edit baselines only). **Nothing for manual/auto** (badge noise ≫ value) + a one-line legend "Sin etiqueta = escrito por ti." Mounted in `builder-preview.tsx`/`builder-steps.tsx`, `editor-panels.tsx`, both `revisar-client.tsx` (per-node "✦ N campos de IA" + per-field badges — the accept-audit moment), and optionally the `acciones-client.tsx` "Origen" column (lights up for free from `source`). The existing ✨ accept also stamps `'ia'`, closing today's gap where AI-authored values are indistinguishable from typed ones.

## (c) The docked panel + API + tools + grounding

**`src/components/command/copiloto-dock.tsx`** (+ `copiloto-proposal-card.tsx`), NEW, client, mounted in BOTH `/command/crear` and `/command/editar/[id]`:

```ts
interface CopilotoDockProps {
  docKind: "google_create" | "google_edit";
  blueprintId: string;
  accountRef: string;
  getDoc: () => CcBlueprintDoc | GoogleSearchEditDoc;      // CURRENT in-memory doc (incl. unsaved edits)
  onAccept: (patch: BlueprintPatch) => ApplyPatchResult;    // parent applies + stamps _prov + autosaves
  onSelectNode?: (nodeId: string) => void;                  // "Ver nodo": editor NodeSelection / builder setStep
}
```

- **UX:** collapsed = fixed bottom-right pill "✦ Copiloto" (over the shells, zero grid changes, works at the <980px collapse; violet dot when a card is pending). Expanded = right-anchored panel `min(380px, 100vw-32px)`; Esc/✕ collapses; bottom-sheet on mobile. Empty state teaches: "Pídeme propuestas sobre este borrador. Nunca aplico nada sin tu Aceptar." + 3 host-specific example chips.
- **Proposal card:** `summary` + node breadcrumb; per-op `old → new` rows (arrays as +N/−N chips); **"Por qué: <rationale>" rendered as PLAIN TEXT** (injection surface); **[Aceptar]** / **[Rechazar]** + "Ver nodo". Accept → `onAccept` → `applyBlueprintPatch` → setState + stamp `_prov`/`_ai` → existing debounced autosave. Cards are one-shot; a card whose node changed re-validates on Accept and degrades to "El borrador cambió; pídela de nuevo." Conversation = in-memory component state (lost on reload — the *accepted work* persists in the doc, which is the product).

**API: NEW `/api/command/copiloto/route.ts`.** Request `{ messages, docKind, blueprintId, doc }` (client sends the CURRENT doc — fresher than DB under the 1200ms debounce). Server: `getCommandAccess` gate, load blueprint workspace-scoped, verify `id`+`docKind` match, **for edit run `mergeEditDoc(stored, doc)` BEFORE grounding** (the model can never be shown spoofed baselines), `parseBlueprint` for create (reject garbage before the model), body ≤256KB, then `runToolLoop`. Response `{ reply, proposals: Array<{ id, summary, ops, rationale }>, toolsUsed }`.

**Tools — exactly 2 in slice 1:**
1. `get_doc` (**no args** → no injection/SSRF surface) → the request's (merged, for edit) doc, trimmed (arrays capped 30 with `_truncado` notes, the `copiloto-tools.ts` idiom).
2. `propose_patch(ops, summary)` → executor runs `blueprintPatchSchema.parse` + **dry** `applyBlueprintPatch` against the grounded doc. Invalid → returns `{ ok:false, errors }` to the model (self-correction within remaining rounds). Valid → returns `{ ok:true }` and pushes into the proposals accumulator (cap 3). **Its only effect is a card. No DB write, no rail import.**

**Grounding (system prompt, static):** the propose→accept covenant ("Todo cambio es una PROPUESTA vía propose_patch; jamás afirmes que aplicaste algo"); the docKind field vocabulary (the whitelist, so the model targets real fields); `RSA_SPEC` + `GOOGLE_THRESHOLDS` from `knowledge.ts` (free, deterministic); account name/currency; for edit, a compact baseline summary (status, budget, ad-group count) — the full tree is behind `get_doc`. **No sentinel tools, no live metrics in slice 1.**

**Tool-loop extraction (warranted NOW per the binding sketch):** NEW `src/lib/llm/tool-loop.ts`:

```ts
export interface ToolLoopParams {
  apiKey: string; model: string; system: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  tools: ChatTool[];                                            // OpenAI wire shape (reuse)
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxRounds?: number; budgetMs?: number; perCallMs?: number; maxTokens?: number; temperature?: number;
}
export async function runToolLoop(p: ToolLoopParams): Promise<{ reply: string; toolsUsed: string[] }>;
```
Extract **ONLY** `callOpenRouter` + wire types + the round loop (route.ts:109-145, 205-305) incl. budget-starvation, embedded-200-error handling, arg-JSON hardening. **NOT** the sentinel belt, **NOT** `resolveModel` policy (each route keeps its own never-Anthropic guard), **NOT** payload trimming. Refactor `/api/copiloto` onto it **behavior-preservingly** (same constants, same responses — run its smoke/golden tests before and after; this is the regression risk).

## (d) Slice-1 scope

**IN:** Google create dock + Google edit dock; patch `schema.ts` + `apply.ts` + tests; `_prov` (ia-only) + `_ai` writer (create) + `_ai` reader (edit branch) + `ProvBadge` in builder/editor/both revisar (+ Acciones Origen); NEW `/api/command/copiloto` with `get_doc` + `propose_patch`; tool-loop extraction + `/api/copiloto` refactor; ✨-suggest stamps `'ia'`; the "✦ Pedir al copiloto" step shortcut. Multi-turn chat with ≤3 cards/reply.

**DEFERRED:** v2.5 chat-entry (create FROM chat — separate spec, roadmap:254; the dock never creates, only patches an open draft; the 20-op/256KB caps also prevent whole-doc generation sneaking through `propose_patch`); **Meta create dock** (lean form has no nodeIds; repo.ts:198 excludes Meta from `_ai` — needs its own node-identity + whitelist; additive: one apply overload + one dock mount, also unblocks repo.ts:217's hardcoded `source`); **`get_metrics`** (v2.6 `listCampaignMetrics` trivially wired later); streaming/SSE; conversation persistence; per-item array provenance; **per-step mode toggle** (cut, flagged); accept-all/bulk; per-op partial accept; multi-patch negotiation; provenance history/audit; **server-side `applyBlueprintPatch` on save** (it's pure/isomorphic — later hardening; `mergeEditDoc`/`parseBlueprint` already give the independent server validation slice 1 needs); retiring legacy `_ai`; per-workspace cost quotas (engine llm-usage view covers observability).

## (e) Security — the chain, verified end-to-end (no bypass)

**Effect chain:** LLM output → `propose_patch` zod parse (server) → **dry** `applyBlueprintPatch` (whitelist + node existence + full-doc parse ×2 + blast bounds, server) → card → **HUMAN Accept** → `applyBlueprintPatch` re-run **client-side against the live doc** (same fn; stale/vanished node fails closed `UNKNOWN_NODE`) → debounced autosave PUT → **server trust boundary** (create: `parseBlueprint` on raw; edit: `mergeEditDoc` rebuilds from STORED server-owned fields, filters `removeNegatives ⊆ baseNegatives`, re-parses `EDIT_BATCH_MAX` superRefines) → compile/diff → `cc_actions('proposed')` → **gates** (BLAST_RADIUS, CURRENCY_SANITY, PAUSED_ON_CREATE) → per-action human approve → `executeAction`. The patch layer adds validation **in front of** boundaries that already hold without it. A fully hostile model + a careless accept still cannot touch a `base*` field, exceed `EDIT_BATCH_MAX`, or reach the rail.

**Adversarial answers to the four demanded critiques:**
1. **AI→rail without the human click + double validation?** No path exists. `propose_patch` terminates in *data* (a card), not effects; the only mutation entrypoint is `onAccept`→`applyBlueprintPatch`→autosave→server re-validate. No AI-path file imports `executor`/`gates`/`actions-repo`. `source:'copiloto'` is stamped only at compile from `_ai`/`_prov`.
2. **Provenance that can lie (manual-after-accept):** downgraded by the centralized `writeField` clearing `_prov[key]`; only accept writes `'ia'`; server `sanitizeProv` re-validates keys/enum/size on edit (shape, not truth). Residual = cosmetic mislabel by a compromised client, no gate keys on `source`. Test-guarded.
3. **Dock ↔ autosave race:** accept runs `applyBlueprintPatch` against the **current** doc at click time (not proposal time) — deleted node ⇒ `UNKNOWN_NODE` fail-closed; a value-level conflict last-writes, mitigated by rendering `old→new` from the **live** doc at render (not OT). Accept just updates the same state the debounced autosave already watches → no double-PUT.
4. **Cost runaway:** `MAX_ROUNDS=6`, 30s/25s AbortController budget, last-round tool-starvation forces a final text answer, `max_tokens 2048`, history 12/8k, ≤3 proposals, ≤20 ops, no bulk-accept, `getCommandAccess`-gated, `resolveModel` never-Anthropic. No DB metering (parity with `/api/copiloto`).

**Injection surface:** operator text + doc (edit docs contain attacker-influenced live-account strings — campaign/keyword names). Worst case = a plausible, schema-valid card the human must read and accept, with gates still running. `rationale`/`summary` are plain text, capped. **Note the AGENTS.md caveat:** the new route-handler + client-component conventions must be checked against `node_modules/next/dist/docs`, not memory.

## (f) File plan

**NEW**
- `src/lib/llm/tool-loop.ts` — `runToolLoop` (extracted OpenRouter loop)
- `src/lib/command/patch/schema.ts` — patch zod, `WRITABLE_FIELDS`, `MAX_PATCH_OPS`, `ProvenanceMap`, prov helpers (`readProv`/`stampProv`/`clearProv`/`deriveAiMarkers`/`sanitizeProv`)
- `src/lib/command/patch/apply.ts` — `applyBlueprintPatch` (pure, isomorphic)
- `src/lib/command/patch/__tests__/patch-apply.test.ts` — unknown node, every non-writable `base*` field, bad value, blast-bound overflow, all-or-nothing, `stateFromDoc` round-trip, ia→manual downgrade
- `src/app/api/command/copiloto/route.ts` — propose-only endpoint (`get_doc` + `propose_patch` on `runToolLoop`)
- `src/components/command/copiloto-dock.tsx`, `src/components/command/copiloto-proposal-card.tsx`, `src/components/command/prov-badge.tsx`

**MODIFIED**
- `src/app/api/copiloto/route.ts` — refactor onto `tool-loop.ts` (behavior-preserving; existing tests must still pass)
- `src/app/api/command/blueprint/[id]/route.ts` — **edit branch: `sanitizeProv` + re-attach `_prov`/derived `_ai` onto `merged` before save** (the one real plumbing change; test it)
- `src/lib/command/blueprint/repo.ts` — edit compile branch honors `_ai` via `entityRef` → `source:'copiloto'`
- `src/app/command/crear/builder-client.tsx` — mount dock; accept = `buildDoc`→apply→`stateFromDoc`; save `_prov` + derived `_ai`; centralize `writeField` clearing prov; ✨ accept stamps `'ia'`
- `src/app/command/crear/builder-types.ts` — add `stateFromDoc()`
- `src/app/command/crear/builder-preview.tsx` + `builder-steps.tsx` — `ProvBadge`, "✦ Pedir al copiloto"
- `src/app/command/editar/[id]/editor-client.tsx` — mount dock; accept = `applyBlueprintPatch`→`setDoc`; send `_prov` with the PUT; clear prov on field edit
- `src/app/command/editar/[id]/editor-panels.tsx` — `ProvBadge`, shortcut  (+ `page.tsx` to pass raw `_prov` if needed)
- both `revisar/revisar-client.tsx` — per-node IA count + field badges
- `src/app/command/acciones/acciones-client.tsx` — "Origen" badge (optional nice-to-have)

**UNTOUCHED (load-bearing guarantee):** `gates.ts`, `executor.ts`, `executor-deps.ts`, `actions-repo.ts`, `blueprint/compile.ts`, `edit/diff.ts`, `edit/schema.ts` (`mergeEditDoc` unchanged — sub-schema exports only if needed), `blueprint/schema.ts` (sub-schema exports only), `meta-schema.ts`/`meta-compile.ts`/`crear-meta/*`, `copiloto-tools.ts`, `sentinel.ts`, `llm/openrouter.ts`, `llm/index.ts`, `suggest.ts` (`callStructured` unchanged; only its client accept handler stamps `'ia'`).

**The single riskiest task to test first:** the edit-doc `_prov` re-attach after `mergeEditDoc` (route.ts:62-82) — without it, edit provenance and `source:'copiloto'` silently vanish. Second: the builder `stateFromDoc` bijection — a missed field silently drops an accepted patch value.
