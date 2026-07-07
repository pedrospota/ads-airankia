# Command Center v2.3 — Edit Mode (slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let an operator load a LIVE Google Search campaign into the workbench, edit the slice-1 surface (budget, statuses, add negatives/keywords/RSAs, RSA refresh), review an Antes→Después diff, and apply it through the untouched v1 rail.

**Architecture:** A SECOND compiler in front of shipped machinery: `readCampaignTree()` (GAQL) → server-owned `GoogleSearchEditDoc` stored in `cc_blueprints` (in-doc `docType` discriminator, NO migration) → pure `diffEditDoc()` emits ONLY existing verbs as ordered `cc_actions` (with field-scoped `expected` DRIFT baselines) → the existing plan-runner/approve/execute/rollback routes run them. ZERO new action types. `types.ts`, `gates.ts`, `executor.ts`, `plan-runner.ts` are UNTOUCHED.

**Tech Stack:** Next.js 16.2.2 App Router, TypeScript 5, Zod, Drizzle+pg, Google Ads REST v21 (GAQL + mutate), bun test.

**Spec:** `docs/superpowers/specs/2026-07-07-command-center-v2.3-edit-mode-design.md` (READ FIRST — the mapping table §c and staleness table §d are binding).

## Global Constraints

- Branch: work directly on `main`'s current HEAD via a feature branch `feat/command-center-v23-edit`; NEVER push without the controller's say-so. Commit after each task. bun at `~/.bun/bin/bun`; tests `~/.bun/bin/bun test src/lib/command`; typecheck `~/.local/bin/bunx tsc --noEmit`.
- **ZERO new action types; NO DB migration; `types.ts`/`gates.ts`/`executor.ts`/`plan-runner.ts` UNTOUCHED.** The differ emits only: `budget_update`, `pause`, `enable`, `add_negatives`, `create_keywords`, `create_ad`. NEVER `remove_entity`/`remove_negatives` (internal-only).
- **Server-owned baseline:** `base`, `resourceName`, `baseKeywords`, `unsupported`, `budgetShared`, `loadedAt` are written ONLY by the tree loader; `mergeEditDoc` copies ONLY `desired`/`replacement`/`new*` from the client.
- **Fail-closed:** non-SEARCH/REMOVED campaigns refuse at load; shared-budget edit throws in the differ; baseline older than `EDIT_BASELINE_MAX_AGE_MS` (60 min) throws at compile.
- **Ordering (safety):** phases A pause-intents → B budget → C negatives → D per-group creates (each RSA-replace = `create_ad` immediately followed by its paired `pause`) → E enable-intents LAST. A failed create means its paired pause never runs (runner stop-on-first-failure) → an ad group's enabled-ad count never decreases from a failure.
- Money in micros. UI text Spanish (es-MX). Every route `runtime="nodejs"`, `dynamic="force-dynamic"`, `getCommandAccess()` gate, `await params`. Repo conventions = v2 plan lines 13-21 (`docs/superpowers/plans/2026-07-07-command-center-v2.md`).
- v1 signature facts (verified): `gaql(auth, accountRef, query)` module-private in google.ts; `EntitySnapshot{entityKind,entityRef,name?,status?,dailyBudgetMicros?,budgetResourceName?,currency?,learningPhase?}`; executor `prepare()` passes `row.expected` to gates (executor.ts:84); `AddNegativesPayload = { negatives: Array<{text,match}> }`; `CreateKeywordsPayload = { adGroupRef, keywords: Array<{text,match,negative?}> }`; `CreateAdPayload = { adGroupRef, finalUrl, headlines:[{text,pinnedField?}], descriptions:[{text}], path1?, path2? }`; blueprint headline/description z-shapes: `z.object({ text: z.string().min(1).max(RSA_SPEC.headline.maxLen), pinnedField: z.string().optional() })` / `z.object({ text: z.string().min(1).max(RSA_SPEC.description.maxLen) })`.

---

### Task 1: Edit doc schema + mergeEditDoc (server-owned baseline)

**Files:**
- Create: `src/lib/command/edit/schema.ts`
- Test: `src/lib/command/__tests__/edit-schema.test.ts`

**Interfaces:**
- Produces: `editDocSchema`, `GoogleSearchEditDoc`, `EDIT_BASELINE_MAX_AGE_MS = 60*60_000`, `parseEditDoc(input): GoogleSearchEditDoc` (Zod `.parse`, throws), `mergeEditDoc(stored, incoming): GoogleSearchEditDoc` (returns a NEW doc: server fields from `stored`, client fields from `incoming`, unknown nodes dropped).

- [ ] **Step 1: Write failing tests** — `edit-schema.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { parseEditDoc, mergeEditDoc, type GoogleSearchEditDoc } from "../edit/schema";

function baseDoc(): GoogleSearchEditDoc {
  return parseEditDoc({
    docType: "google_search_edit_v1", network: "google_ads", accountRef: "123",
    loadedAt: "2026-07-07T12:00:00.000Z",
    campaign: {
      resourceName: "customers/123/campaigns/5", id: "5",
      base: { name: "C", status: "ENABLED", dailyBudgetMicros: 350_000_000, budgetResourceName: "customers/123/campaignBudgets/9", budgetShared: false, currency: "USD" },
      desired: { status: "ENABLED", dailyBudgetMicros: 350_000_000 },
      newNegatives: [],
      adGroups: [{
        resourceName: "customers/123/adGroups/7", id: "7",
        base: { name: "G", status: "ENABLED" }, desired: { status: "ENABLED" },
        baseKeywords: [{ text: "kw", match: "PHRASE", negative: false, resourceName: "customers/123/adGroupCriteria/7~1" }],
        newKeywords: [], newAds: [],
        ads: [{ resourceName: "customers/123/adGroupAds/7~11", unsupported: false,
          base: { status: "ENABLED", finalUrl: "https://x.com", headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }], descriptions: [{ text: "D1" }, { text: "D2" }] },
          replacement: null }],
      }],
    },
  });
}

describe("editDocSchema", () => {
  it("parses a valid edit doc", () => { expect(baseDoc().campaign.id).toBe("5"); });
  it("rejects a wrong docType (create docs must not enter the edit path)", () => {
    const d = { ...baseDoc(), docType: "google_search_v1" };
    expect(() => parseEditDoc(d)).toThrow();
  });
  it("rejects a replacement violating RSA_SPEC (headline > 30 chars)", () => {
    const d = baseDoc();
    d.campaign.adGroups[0].ads[0].replacement = { tempId: "t1", finalUrl: "https://x.com",
      headlines: [{ text: "x".repeat(31) }, { text: "b" }, { text: "c" }], descriptions: [{ text: "d1" }, { text: "d2" }] };
    expect(() => parseEditDoc(d)).toThrow();
  });
});

describe("mergeEditDoc (server-owned baseline)", () => {
  it("copies desired/new* from the client", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.desired.dailyBudgetMicros = 500_000_000;
    incoming.campaign.newNegatives = [{ text: "gratis", match: "EXACT" }];
    incoming.campaign.adGroups[0].newKeywords = [{ text: "nuevo kw", match: "PHRASE", negative: false }];
    const out = mergeEditDoc(stored, incoming);
    expect(out.campaign.desired.dailyBudgetMicros).toBe(500_000_000);
    expect(out.campaign.newNegatives).toHaveLength(1);
    expect(out.campaign.adGroups[0].newKeywords).toHaveLength(1);
  });
  it("REJECTS client tampering with base/loadedAt/budgetShared/resourceName", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.loadedAt = "2026-07-07T13:00:00.000Z";
    incoming.campaign.base.dailyBudgetMicros = 1;         // laundering attempt
    incoming.campaign.base.budgetShared = true;
    const out = mergeEditDoc(stored, incoming);
    expect(out.loadedAt).toBe(stored.loadedAt);
    expect(out.campaign.base.dailyBudgetMicros).toBe(350_000_000);
    expect(out.campaign.base.budgetShared).toBe(false);
  });
  it("drops client edits referencing nodes absent from the stored doc", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.adGroups.push({ ...baseDoc().campaign.adGroups[0], resourceName: "customers/123/adGroups/999", id: "999" });
    const out = mergeEditDoc(stored, incoming);
    expect(out.campaign.adGroups).toHaveLength(1);
  });
  it("matches ads by resourceName when copying replacement", () => {
    const stored = baseDoc(); const incoming = baseDoc();
    incoming.campaign.adGroups[0].ads[0].replacement = { tempId: "t1", finalUrl: "https://x.com",
      headlines: [{ text: "A" }, { text: "B" }, { text: "C" }], descriptions: [{ text: "d1" }, { text: "d2" }] };
    const out = mergeEditDoc(stored, incoming);
    expect(out.campaign.adGroups[0].ads[0].replacement?.tempId).toBe("t1");
  });
});
```
- [ ] **Step 2: Run → fail** (`~/.bun/bin/bun test src/lib/command/__tests__/edit-schema.test.ts`).
- [ ] **Step 3: Implement `src/lib/command/edit/schema.ts`** — the spec §b Zod block verbatim (define local `headline`/`description` shapes identical to the blueprint ones using `RSA_SPEC` from `../knowledge`; import `MICROS_PER_UNIT` from `../types`). `parseEditDoc = (input) => editDocSchema.parse(input)`. `mergeEditDoc(stored, incoming)`: parse `incoming` with `editDocSchema` first (throw on invalid), then build the result FROM `stored` and copy ONLY: `campaign.desired`, `campaign.newNegatives`, and per ad group matched by `resourceName`: `desired`, `newKeywords`, `newAds`, and per ad matched by `resourceName`: `replacement`. Ad groups/ads present in `incoming` but not `stored` are DROPPED (never appended).
- [ ] **Step 4: Run → pass**; `~/.local/bin/bunx tsc --noEmit` → exit 0.
- [ ] **Step 5: Commit** `git add src/lib/command/edit/schema.ts src/lib/command/__tests__/edit-schema.test.ts && git commit -m "feat(v2.3): edit doc schema + mergeEditDoc server-owned baseline"`

---

### Task 2: Adapter `ad` branch — pause/enable/snapshot for entityKind "ad" (the stealth suite)

**Files:**
- Modify: `src/lib/command/networks/google.ts`
- Test: `src/lib/command/__tests__/google-adapter.test.ts` (extend)

**Interfaces:**
- Consumes: v1 `buildMutation` pause/enable cases, `snapshot()`, `buildRollback` (already kind-generic for pause↔enable).
- Produces: `pause`/`enable` on `entityKind:"ad"` → `adGroupAds:mutate` with the action's FULL resourceName; `snapshot(auth, accountRef, "ad", <full resourceName>)` → `{status}` via GAQL by `ad_group_ad.resource_name`. This is what makes the RSA-replace pause half executable and DRIFT-protected.

- [ ] **Step 1: Write failing tests** (extend google-adapter.test.ts, reuse its fetch-mock + AUTH):
```ts
  it("pause on entityKind ad → adGroupAds:mutate with the FULL resourceName", async () => {
    responder = () => ({ results: [{ resourceName: "customers/123/adGroupAds/7~11" }] });
    await googleAdapter.execute(AUTH, "123",
      { actionType: "pause", entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", payload: {} },
      { entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", status: "ENABLED" });
    const body = JSON.parse(String(calls.find(c => c.url.endsWith("adGroupAds:mutate"))?.init?.body));
    expect(body.operations[0].update.resourceName).toBe("customers/123/adGroupAds/7~11");
    expect(body.operations[0].update.status).toBe("PAUSED");
    expect(body.operations[0].updateMask).toBe("status");
  });
  it("snapshot on entityKind ad queries by resource_name and returns status", async () => {
    responder = (url) => String(url).includes("googleAds:search")
      ? { results: [{ adGroupAd: { status: "ENABLED", resourceName: "customers/123/adGroupAds/7~11" } }] } : {};
    const snap = await googleAdapter.snapshot(AUTH, "123", "ad", "customers/123/adGroupAds/7~11");
    expect(snap.status).toBe("ENABLED");
    const q = String(calls.find(c => String(c.url).includes("googleAds:search"))?.init?.body);
    expect(q).toContain("ad_group_ad.resource_name");
  });
  it("validate() handles pause on an ad (validateOnly of adGroupAds:mutate)", async () => {
    responder = () => ({});
    const res = await googleAdapter.validate!(AUTH, "123",
      { actionType: "pause", entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", payload: {} },
      { entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", status: "ENABLED" });
    expect(res.ok).toBe(true);
  });
  it("buildRollback of pause(ad) → enable with the same FULL resourceName", () => {
    const r = googleAdapter.buildRollback(
      { actionType: "pause", entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", payload: {} },
      { entityKind: "ad", entityRef: "customers/123/adGroupAds/7~11", status: "ENABLED" },
      { operation: "adGroupAds:mutate", request: {}, response: {} });
    expect(r?.action.actionType).toBe("enable");
    expect(r?.action.entityRef).toBe("customers/123/adGroupAds/7~11");
  });
```
Adapt the snapshot mock to the file's real GAQL mock pattern (READ the existing snapshot tests first and mirror how they stub `googleAds:search`).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement in `google.ts`.** (a) In the `pause`/`enable` case of `buildMutation`, BEFORE the ad_group branch:
```ts
      if (action.entityKind === "ad") {
        // entityRef is the FULL adGroupAds resourceName (customers/x/adGroupAds/g~a).
        return { endpoint: "adGroupAds:mutate", body: { operations: [{ updateMask: "status", update: { resourceName: action.entityRef, status } }] } };
      }
```
(b) In `snapshot()`, FIRST branch:
```ts
    if (entityKind === "ad") {
      const rows = await gaql(auth, accountRef, `
        SELECT ad_group_ad.status, ad_group_ad.resource_name
        FROM ad_group_ad WHERE ad_group_ad.resource_name = '${entityRef}'`);
      if (!rows.length) throw new Error(`Anuncio ${entityRef} no encontrado.`);
      const s = (rows[0] as { adGroupAd?: { status?: string } }).adGroupAd;
      return { entityKind, entityRef, status: (s?.status as EntitySnapshot["status"]) ?? "UNKNOWN", learningPhase: "UNKNOWN", raw: rows[0] };
    }
```
(c) `validate()` and `buildRollback` need NO edits (they flow through `buildMutation` / the generic pause↔enable case) — the tests prove it. (d) Do NOT touch `capabilities()`.
- [ ] **Step 4: Run → pass** (whole `src/lib/command` suite green); tsc exit 0.
- [ ] **Step 5: Commit** `git add src/lib/command/networks/google.ts src/lib/command/__tests__/google-adapter.test.ts && git commit -m "feat(v2.3): adapter ad branch — pause/enable/snapshot by full adGroupAds resourceName"`

---

### Task 3: readCampaignTree (GAQL loader) + buildEditDoc (pure mapper)

**Files:**
- Modify: `src/lib/command/networks/google.ts` (append exported `readCampaignTree`)
- Create: `src/lib/command/edit/read-tree.ts` (pure `buildEditDoc`)
- Test: `src/lib/command/__tests__/edit-read-tree.test.ts`

**Interfaces:**
- Consumes: module-private `gaql(auth, accountRef, query)` (google.ts), `AdapterAuth`.
- Produces: `readCampaignTree(auth: AdapterAuth, accountRef: string, campaignId: string): Promise<RawCampaignTree>` exported from google.ts (4 GAQL reads; throws on non-SEARCH/REMOVED/not-found). `RawCampaignTree = { campaign: GaqlRow; adGroups: GaqlRow[]; keywords: GaqlRow[]; ads: GaqlRow[] }` (export the type from google.ts). `buildEditDoc(tree: RawCampaignTree, accountRef: string, nowIso: string): GoogleSearchEditDoc` in read-tree.ts — PURE (nowIso injected; no Date.now inside), returns a doc with `desired=base`, empty `new*`, `loadedAt=nowIso`.

- [ ] **Step 1: Write failing tests** — feed `buildEditDoc` hand-built GaqlRow fixtures (this is the pure part; `readCampaignTree` itself is covered by one fetch-mock test in the adapter test file):
```ts
import { describe, it, expect } from "bun:test";
import { buildEditDoc } from "../edit/read-tree";
import type { RawCampaignTree } from "../networks/google";

const TREE: RawCampaignTree = {
  campaign: { campaign: { id: "5", resourceName: "customers/123/campaigns/5", name: "C", status: "ENABLED", advertisingChannelType: "SEARCH", campaignBudget: "customers/123/campaignBudgets/9" },
              campaignBudget: { amountMicros: "350000000", explicitlyShared: false }, customer: { currencyCode: "USD" } },
  adGroups: [{ adGroup: { id: "7", resourceName: "customers/123/adGroups/7", name: "G", status: "ENABLED" } }],
  keywords: [{ adGroupCriterion: { resourceName: "customers/123/adGroupCriteria/7~1", negative: false, keyword: { text: "kw", matchType: "PHRASE" } }, adGroup: { id: "7" } }],
  ads: [
    { adGroupAd: { resourceName: "customers/123/adGroupAds/7~11", status: "ENABLED",
        ad: { type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://x.com"],
          responsiveSearchAd: { headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }], descriptions: [{ text: "D1" }, { text: "D2" }], path1: "ofertas" } } }, adGroup: { id: "7" } },
    { adGroupAd: { resourceName: "customers/123/adGroupAds/7~12", status: "ENABLED", ad: { type: "EXPANDED_TEXT_AD" } }, adGroup: { id: "7" } },
  ],
};

describe("buildEditDoc", () => {
  it("maps the tree with desired=base, empty new*, loadedAt=nowIso", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    expect(doc.docType).toBe("google_search_edit_v1");
    expect(doc.loadedAt).toBe("2026-07-07T12:00:00.000Z");
    expect(doc.campaign.base.dailyBudgetMicros).toBe(350_000_000); // string micros → number
    expect(doc.campaign.base.budgetShared).toBe(false);
    expect(doc.campaign.desired).toEqual({ status: "ENABLED", dailyBudgetMicros: 350_000_000 });
    expect(doc.campaign.adGroups[0].baseKeywords).toHaveLength(1);
    expect(doc.campaign.adGroups[0].newKeywords).toHaveLength(0);
  });
  it("flags non-RSA ads unsupported (they still exist for the enabled-count)", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    expect(doc.campaign.adGroups[0].ads[0].unsupported).toBe(false);
    expect(doc.campaign.adGroups[0].ads[1].unsupported).toBe(true);
    expect(doc.campaign.adGroups[0].ads[1].base.headlines).toHaveLength(0);
  });
  it("attaches keywords/ads to the RIGHT ad group by adGroup.id", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    expect(doc.campaign.adGroups[0].ads).toHaveLength(2);
  });
  it("output round-trips through parseEditDoc (schema-valid by construction)", () => {
    const doc = buildEditDoc(TREE, "123", "2026-07-07T12:00:00.000Z");
    const { parseEditDoc } = require("../edit/schema");
    expect(() => parseEditDoc(doc)).not.toThrow();
  });
});
```
Also add ONE fetch-mock test to `google-adapter.test.ts`: `readCampaignTree` throws `"Solo campañas de Búsqueda"` when the campaign row has `advertisingChannelType: "PERFORMANCE_MAX"`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** In `google.ts` append + export:
```ts
export interface RawCampaignTree { campaign: GaqlRow; adGroups: GaqlRow[]; keywords: GaqlRow[]; ads: GaqlRow[] }
export async function readCampaignTree(auth: AdapterAuth, accountRef: string, campaignId: string): Promise<RawCampaignTree> {
  const id = Number(campaignId);
  const [c] = await gaql(auth, accountRef, `
    SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type,
           campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared, customer.currency_code
    FROM campaign WHERE campaign.id = ${id}`);
  if (!c) throw new Error(`Campaña ${campaignId} no encontrada.`);
  const camp = (c as { campaign?: { advertisingChannelType?: string; status?: string } }).campaign;
  if (camp?.advertisingChannelType !== "SEARCH") throw new Error("Solo campañas de Búsqueda se pueden editar en esta versión.");
  if (camp?.status === "REMOVED") throw new Error("La campaña está eliminada.");
  const adGroups = await gaql(auth, accountRef, `
    SELECT ad_group.id, ad_group.resource_name, ad_group.name, ad_group.status
    FROM ad_group WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED' ORDER BY ad_group.name`);
  const keywords = await gaql(auth, accountRef, `
    SELECT ad_group_criterion.resource_name, ad_group_criterion.negative, ad_group_criterion.keyword.text,
           ad_group_criterion.keyword.match_type, ad_group.id
    FROM ad_group_criterion WHERE campaign.id = ${id} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`);
  const ads = await gaql(auth, accountRef, `
    SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls,
           ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
           ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group.id
    FROM ad_group_ad WHERE campaign.id = ${id} AND ad_group_ad.status != 'REMOVED'`);
  return { campaign: c, adGroups, keywords, ads };
}
```
In `read-tree.ts`: pure mapping. Number(`amountMicros`) (GAQL returns string micros). `unsupported = ad.type !== "RESPONSIVE_SEARCH_AD"`; unsupported ads get `base.headlines/descriptions = []`. Group children by `row.adGroup.id`. `desired = { status: base.status, dailyBudgetMicros: base.dailyBudgetMicros }` etc. If campaign `status` is anything other than ENABLED/PAUSED (e.g. UNKNOWN), throw — the edit surface only models those two.
- [ ] **Step 4: Run → pass**; whole suite green; tsc exit 0.
- [ ] **Step 5: Commit** `git add src/lib/command/networks/google.ts src/lib/command/edit/read-tree.ts src/lib/command/__tests__/edit-read-tree.test.ts src/lib/command/__tests__/google-adapter.test.ts && git commit -m "feat(v2.3): readCampaignTree GAQL loader + pure buildEditDoc mapper"`

---

### Task 4: diffEditDoc — the pure differ (mapping table + ordering + field-scoped expected)

**Files:**
- Create: `src/lib/command/edit/diff.ts`
- Test: `src/lib/command/__tests__/edit-diff.test.ts`

**Interfaces:**
- Consumes: `GoogleSearchEditDoc` (Task 1), `CcInternalActionType`/`CcEntityKind`/`CcPayload`/`EntitySnapshot` from `../types`, `createHash` from `node:crypto`.
- Produces:
```ts
export interface EditCompiledAction {
  seq: number; localRef: string | null;
  actionType: CcInternalActionType;      // only: budget_update|pause|enable|add_negatives|create_keywords|create_ad
  entityKind: CcEntityKind; entityRef: string;
  payload: CcPayload;
  expected: Partial<EntitySnapshot> | null;
  entityName: string | null;
  recKey: string;                        // "ed-" + sha256(`${blueprintId}|${seq}`).slice(0,14)
  note: string;                          // es-MX antes→después
}
export function diffEditDoc(doc: GoogleSearchEditDoc, blueprintId: string): EditCompiledAction[];
```

- [ ] **Step 1: Write failing tests** — cover EVERY mapping row + ordering + throws. Use a `mk()` helper deriving from Task 1's `baseDoc()` fixture shape (copy the fixture builder into this test file — tests must be self-contained):
```ts
// (fixture builder identical to edit-schema.test.ts's baseDoc(), inline here)
describe("diffEditDoc — mapping", () => {
  it("no changes → []", () => expect(diffEditDoc(mk(), "bp1")).toHaveLength(0));
  it("budget change → budget_update with field-scoped expected", () => {
    const d = mk(); d.campaign.desired.dailyBudgetMicros = 500_000_000;
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("budget_update");
    expect(a.entityRef).toBe("5");                                    // numeric id, v1 convention
    expect(a.payload).toEqual({ newDailyBudgetMicros: 500_000_000 });
    expect(a.expected).toEqual({ dailyBudgetMicros: 350_000_000 });   // ONLY the mutated field
  });
  it("campaign status flip → pause with expected {status: base}", () => {
    const d = mk(); d.campaign.desired.status = "PAUSED";
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("pause"); expect(a.expected).toEqual({ status: "ENABLED" });
  });
  it("newNegatives → add_negatives with expected null", () => {
    const d = mk(); d.campaign.newNegatives = [{ text: "gratis", match: "EXACT" }];
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("add_negatives"); expect(a.expected).toBeNull();
  });
  it("newKeywords → create_keywords with REAL adGroupRef and tmp entityRef", () => {
    const d = mk(); d.campaign.adGroups[0].newKeywords = [{ text: "kw2", match: "PHRASE", negative: false }];
    const [a] = diffEditDoc(d, "bp1");
    expect(a.actionType).toBe("create_keywords");
    expect((a.payload as { adGroupRef: string }).adGroupRef).toBe("customers/123/adGroups/7");
    expect(a.entityRef.startsWith("tmp:")).toBe(true);
  });
  it("RSA replace on an ENABLED ad → create_ad immediately followed by paired pause(old, FULL ref)", () => {
    const d = mk(); d.campaign.adGroups[0].ads[0].replacement = REPL;
    const acts = diffEditDoc(d, "bp1");
    const i = acts.findIndex(a => a.actionType === "create_ad");
    expect(acts[i + 1].actionType).toBe("pause");
    expect(acts[i + 1].entityKind).toBe("ad");
    expect(acts[i + 1].entityRef).toBe("customers/123/adGroupAds/7~11");
    expect(acts[i + 1].expected).toEqual({ status: "ENABLED" });
  });
  it("RSA replace on a PAUSED ad → create_ad only (no pause)", () => {
    const d = mk(); d.campaign.adGroups[0].ads[0].base.status = "PAUSED";
    d.campaign.adGroups[0].ads[0].replacement = REPL;
    const acts = diffEditDoc(d, "bp1");
    expect(acts.filter(a => a.actionType === "pause")).toHaveLength(0);
  });
});
describe("diffEditDoc — ordering (phases A..E)", () => {
  it("pause intents first, enables LAST, creates in between", () => {
    const d = mk();
    d.campaign.adGroups[0].desired.status = "PAUSED";        // A (ad-group pause)
    d.campaign.desired.dailyBudgetMicros = 500_000_000;      // B
    d.campaign.newNegatives = [{ text: "n", match: "EXACT" }]; // C
    d.campaign.adGroups[0].newKeywords = [{ text: "k", match: "PHRASE", negative: false }]; // D
    d.campaign.desired.status = "ENABLED";                   // no-op (already ENABLED)
    const order = diffEditDoc(d, "bp1").map(a => a.actionType);
    expect(order).toEqual(["pause", "budget_update", "add_negatives", "create_keywords"]);
  });
  it("seq is contiguous from 0 and recKey is deterministic", () => {
    const d = mk(); d.campaign.desired.dailyBudgetMicros = 500_000_000;
    const [a1] = diffEditDoc(d, "bp1"); const [a2] = diffEditDoc(d, "bp1");
    expect(a1.seq).toBe(0); expect(a1.recKey).toBe(a2.recKey); expect(a1.recKey.startsWith("ed-")).toBe(true);
  });
});
describe("diffEditDoc — fail-closed throws", () => {
  it("throws on budget change while budgetShared", () => {
    const d = mk(); d.campaign.base.budgetShared = true; d.campaign.desired.dailyBudgetMicros = 500_000_000;
    expect(() => diffEditDoc(d, "bp1")).toThrow(/compartido/);
  });
  it("throws on replacement of an unsupported ad", () => {
    const d = mk(); d.campaign.adGroups[0].ads[0].unsupported = true; d.campaign.adGroups[0].ads[0].replacement = REPL;
    expect(() => diffEditDoc(d, "bp1")).toThrow();
  });
  it("throws on duplicate tempId across newAds/replacements", () => {
    const d = mk();
    d.campaign.adGroups[0].newAds = [ { ...REPL, tempId: "dup" } ];
    d.campaign.adGroups[0].ads[0].replacement = { ...REPL, tempId: "dup" };
    expect(() => diffEditDoc(d, "bp1")).toThrow(/tempId/);
  });
  it("no non-create action ever carries a tmp: ref (self-assert)", () => {
    const d = mk(); d.campaign.desired.status = "PAUSED"; d.campaign.adGroups[0].newKeywords = [{ text: "k", match: "PHRASE", negative: false }];
    for (const a of diffEditDoc(d, "bp1"))
      if (!a.actionType.startsWith("create_")) expect(a.entityRef.startsWith("tmp:")).toBe(false);
  });
});
```
(`REPL = { tempId: "t1", finalUrl: "https://x.com", headlines: [{text:"A"},{text:"B"},{text:"C"}], descriptions: [{text:"d1"},{text:"d2"}] }`.)
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `diff.ts`** — pure, no IO, no Date. Phases:
  - **A pauses:** campaign `desired.status==="PAUSED" && base.status==="ENABLED"` → `pause` (campaign, entityRef=`doc.campaign.id`, expected `{status:"ENABLED"}`, note `\`Pausar campaña «${name}»\``); then each ad group same-pattern (entityRef=`group.id`).
  - **B budget:** `desired.dailyBudgetMicros !== base.dailyBudgetMicros` → if `base.budgetShared` throw `"El presupuesto es compartido; no se puede editar desde aquí."` else `budget_update` payload `{newDailyBudgetMicros: desired}`, expected `{dailyBudgetMicros: base.dailyBudgetMicros}`, note antes→después in currency units.
  - **C negatives:** `newNegatives.length` → `add_negatives` payload `{negatives}`, expected null.
  - **D per ad group in doc order:** (1) `newKeywords.length` → `create_keywords` entityRef `tmp:kw:${group.id}`, localRef `kw:${group.id}`, payload `{adGroupRef: group.resourceName, keywords: newKeywords}` (pass `negative` through). (2) per ad with `replacement`: throw if `unsupported`; `create_ad` entityRef `tmp:${replacement.tempId}`, localRef `${replacement.tempId}`, payload `{adGroupRef: group.resourceName, finalUrl, headlines, descriptions, path1?, path2?}`; if `ad.base.status==="ENABLED"` immediately push `pause` (entityKind "ad", entityRef `ad.resourceName` FULL, expected `{status:"ENABLED"}`, note `"Google no permite editar anuncios: se crea uno nuevo y se pausa el anterior."`). (3) per `newAds` entry → `create_ad` same shape.
  - **E enables:** ad groups then campaign, `desired==="ENABLED" && base==="PAUSED"` → `enable`, expected `{status:"PAUSED"}`.
  - Assign `seq` in emit order; `recKey = "ed-" + createHash("sha256").update(`${blueprintId}|${seq}`).digest("hex").slice(0, 14)`; collect tempIds in a Set → throw on duplicates; final self-assert loop (non-create with `tmp:` prefix → throw).
- [ ] **Step 4: Run → pass**; suite green; tsc exit 0.
- [ ] **Step 5: Commit** `git add src/lib/command/edit/diff.ts src/lib/command/__tests__/edit-diff.test.ts && git commit -m "feat(v2.3): pure diffEditDoc — mapping table, safety ordering, field-scoped expected"`

---

### Task 5: Repo docType branch + gate-preview edit branch

**Files:**
- Modify: `src/lib/command/blueprint/repo.ts` (compileBlueprintToActions edit branch)
- Modify: `src/lib/command/blueprint/preview.ts` (edit branch)
- Test: `src/lib/command/__tests__/blueprint-repo.test.ts` + `src/lib/command/__tests__/blueprint-preview.test.ts` (extend both)

**Interfaces:**
- Consumes: `parseEditDoc`, `EDIT_BASELINE_MAX_AGE_MS` (Task 1), `diffEditDoc` (Task 4), existing repo deps (`selectBlueprint`, guard, `insertActions`).
- Produces: `compileBlueprintToActions` detects `doc.docType === "google_search_edit_v1"` (exact literal) → TTL check → `parseEditDoc` → `diffEditDoc` → rows that ALSO carry `expected` and `entityName`; the create path stays byte-for-byte unchanged. `previewBlueprintGates` handles edit docs (builds each action's `before` from its `expected` merged over a synthetic snapshot so the DRIFT preview reads correctly; VALIDATE_ONLY stays excluded).

- [ ] **Step 1: Write failing tests.** In `blueprint-repo.test.ts` (reuse its in-memory fake deps; add an edit-doc fixture — the Task 1 `baseDoc()` shape with one budget change):
```ts
  it("edit doc compiles via diffEditDoc and rows carry expected + entityName", async () => {
    const bp = await seedBlueprint({ doc: editDocWithBudgetChange(), status: "draft" });
    const rows = await compileBlueprintToActions(bp.id, [WS], fake);
    expect(rows).toHaveLength(1);
    expect(rows[0].actionType).toBe("budget_update");
    expect(rows[0].expected).toEqual({ dailyBudgetMicros: 350_000_000 });
    expect(rows[0].entityName).toBeTruthy();
    expect(rows[0].recKey?.startsWith("ed-")).toBe(true);
  });
  it("edit doc with a stale baseline (>60 min) refuses to compile", async () => {
    const doc = editDocWithBudgetChange();
    doc.loadedAt = new Date(Date.now() - 61 * 60_000).toISOString();
    const bp = await seedBlueprint({ doc, status: "draft" });
    await expect(compileBlueprintToActions(bp.id, [WS], fake)).rejects.toThrow(/caducado/);
  });
  it("create docs still compile through the v2 path (branch mis-detection guard)", async () => {
    const bp = await seedBlueprint({ doc: validCreateDoc(), status: "draft" });
    const rows = await compileBlueprintToActions(bp.id, [WS], fake);
    expect(rows[0].recKey?.startsWith("bp-")).toBe(true);   // create compiler, not the edit one
  });
```
In `blueprint-preview.test.ts`: an edit blueprint with one budget change over settings `maxDailyBudgetMicros: 400_000_000` and desired 500M → the preview's budget action has `ABS_BUDGET_CAP` in `blocking`; a compliant change → `summary.blockingCount === 0`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** In `compileBlueprintToActions`, after the existing guard/delete block and BEFORE the create-path `parseBlueprint`:
```ts
  const rawDoc = blueprint.doc as { docType?: unknown };
  if (rawDoc?.docType === "google_search_edit_v1") {
    const ageMs = Date.now() - Date.parse((rawDoc as { loadedAt?: string }).loadedAt ?? "");
    if (!Number.isFinite(ageMs) || ageMs > EDIT_BASELINE_MAX_AGE_MS) {
      throw new Error("Baseline caducado; recarga el árbol de la campaña antes de compilar.");
    }
    const doc = parseEditDoc(blueprint.doc);
    const compiled = diffEditDoc(doc, blueprintId);
    if (compiled.length === 0) throw new Error("No hay cambios que aplicar.");
    const rows = compiled.map((a) => ({
      workspaceId: blueprint.workspaceId, createdBy: blueprint.createdBy, network: blueprint.network,
      connectionId: blueprint.connectionId, accountRef: blueprint.accountRef,
      entityKind: a.entityKind, entityRef: a.entityRef, entityName: a.entityName,
      actionType: a.actionType, payload: a.payload as never, expected: a.expected as never,
      source: "manual" as const, recKey: a.recKey, rationale: a.note,
      status: "proposed" as const, blueprintId, seq: a.seq, localRef: a.localRef,
    }));
    return deps.insertActions(rows);
  }
```
(Mirror the create branch's exact row-field style — read it first; only `expected`/`entityName`/`rationale` are additions the create path leaves null.) In `preview.ts`: where the doc is parsed, branch on the same literal; for edit docs use `diffEditDoc` output; per action `before = { entityKind, entityRef, status: "UNKNOWN", ...(<a.expected ?? {}>) }` so DRIFT-relevant gates read the load-time baseline; everything else (settings, executedToday, VALIDATE_ONLY exclusion) unchanged.
- [ ] **Step 4: Run → pass**; suite green; tsc exit 0.
- [ ] **Step 5: Commit** `git add src/lib/command/blueprint/repo.ts src/lib/command/blueprint/preview.ts src/lib/command/__tests__/blueprint-repo.test.ts src/lib/command/__tests__/blueprint-preview.test.ts && git commit -m "feat(v2.3): compile/preview edit-doc branch — TTL, diffEditDoc, expected-stamped rows"`

---

### Task 6: API surface — POST /api/command/edit + PUT/GET edit-doc branches

**Files:**
- Create: `src/app/api/command/edit/route.ts`
- Modify: `src/app/api/command/blueprint/[id]/route.ts` (PUT: editDocSchema+mergeEditDoc branch; GET: compiled-preview edit branch)

**Interfaces:**
- Consumes: `getCommandAccess`/`commandDenied`, `buildExecutorDeps` + `deps.auth.resolve` (mirror `src/app/api/command/campaigns/route.ts:26-33` EXACTLY for auth), `readCampaignTree` + `buildEditDoc` (Task 3), `createBlueprint` (repo), `parseEditDoc`/`mergeEditDoc` (Task 1), `diffEditDoc` (Task 4).
- Produces: `POST /api/command/edit` `{network:'google_ads', connection_id, account_ref, campaign_id}` → loads the live tree → creates a draft edit blueprint → `{ id }`. PUT on an edit blueprint validates with `editDocSchema` and applies `mergeEditDoc(stored, incoming)`; GET returns `{ blueprint, compiled }` where compiled uses `diffEditDoc` for edit docs.

- [ ] **Step 1: Implement `POST /api/command/edit`** (no unit tests — route layer follows the repo's tsc+smoke convention). Skeleton = v1 route pattern (`runtime`/`dynamic`/gate/try-catch). Body validation: all four fields required (400). Verify `connection_id` belongs to the caller's workspace EXACTLY like `blueprint/route.ts:50-60` (Supabase read of `ads_google_connections`). Then:
```ts
    const deps = buildExecutorDeps(access.accessToken);
    const auth = await deps.auth.resolve({ network, connectionId, workspaceId } as unknown as CcActionRow);
    const adapter = adapterFor("google_ads");
    if (!adapter.capabilities(auth).read) return NextResponse.json({ error: "Sin acceso de lectura" }, { status: 409 });
    const tree = await readCampaignTree(auth, accountRef, campaignId);      // throws non-SEARCH/REMOVED → catch → 409 with the Spanish message
    const doc = buildEditDoc(tree, accountRef, new Date().toISOString());
    const bp = await createBlueprint({ workspaceId, createdBy: access.email, network: "google_ads",
      accountRef, connectionId, doc: doc as never, status: "draft" });
    return NextResponse.json({ id: bp.id });
```
Catch: `readCampaignTree`'s known throws → 409 `{error: message}`; unknown → 500.
- [ ] **Step 2: Extend PUT in `blueprint/[id]/route.ts`.** After loading the stored blueprint (existing scoped fetch): if `stored.doc?.docType === "google_search_edit_v1"` → `const merged = mergeEditDoc(parseEditDoc(stored.doc), body.doc)` (Zod errors → 400 with message) → `saveBlueprintDoc(id, merged, ...)`. Else the existing create-doc path unchanged.
- [ ] **Step 3: Extend GET compiled-preview.** Where it currently does `compile(parseBlueprint(doc), id)`: branch on the docType literal → `diffEditDoc(parseEditDoc(doc), id)` for edit docs (return the actions array under the same `compiled` key; each `EditCompiledAction` already carries `note`/`expected` for the review UI).
- [ ] **Step 4: Verify** `~/.local/bin/bunx tsc --noEmit` exit 0 AND `~/.bun/bin/bun test src/lib/command` green.
- [ ] **Step 5: Commit** `git add src/app/api/command/edit/route.ts "src/app/api/command/blueprint/[id]/route.ts" && git commit -m "feat(v2.3): /api/command/edit + edit-doc branches on blueprint PUT/GET"`

---

### Task 7: Editor UI — /command/editar/[id] + "Editar" entry in Cuentas

**Files:**
- Create: `src/app/command/editar/[id]/page.tsx` (server gate + load blueprint → client)
- Create: `src/app/command/editar/[id]/editor-client.tsx` (the edit workbench island)
- Modify: `src/app/command/cuentas/cuentas-client.tsx` (per-campaign "Editar" button)

**Interfaces:**
- Consumes: `getCommandAccess` + `getBlueprint` (server page); `PUT /api/command/blueprint/[id]` (autosave of `desired`/`new*`); `POST /api/command/edit` (from Cuentas). Navigates to `/command/editar/[id]/revisar` (Task 8).
- Produces: the edit workbench per spec §f-2.

**MIRROR these files (read them first):** `src/app/command/crear/page.tsx` (server-gate shell), `src/app/command/crear/builder-client.tsx` + `builder-steps.tsx` + `builder-preview.tsx` (3-pane layout, field editors, SerpPreview, autosave pattern), `src/app/command/acciones/acciones-client.tsx` (fetch + theme tokens). AGENTS.md applies: non-standard Next.js — `await params`, mirror existing pages, check `node_modules/next/dist/docs/` if unsure.

- [ ] **Step 1: Cuentas entry.** In `cuentas-client.tsx`, each GOOGLE campaign row whose `advertisingChannelType === "SEARCH"` (the campaigns API already returns channel — READ the DTO first; if it doesn't, show Editar on all Google rows and let `POST /api/command/edit`'s 409 message surface) gains a small `Editar` button → `POST /api/command/edit {network:'google_ads', connection_id, account_ref, campaign_id}` → on `{id}` → `router.push(\`/command/editar/${id}\`)`; on 409 → inline error with the Spanish message. Disable the button while creating.
- [ ] **Step 2: Server page.** `page.tsx`: gate (`getCommandAccess` → `redirect("/login")`), `await params`, `getBlueprint(id, access.workspaceIds)` → `notFound()` if missing or `doc.docType !== "google_search_edit_v1"`. `<Header breadcrumbs={[{label:"Centro de Mando",href:"/command"},{label:"Cuentas",href:"/command/cuentas"},{label:"Editar campaña"}]}/>`. Pass `{ blueprintId, doc, status }` to the client.
- [ ] **Step 3: Client island** (`"use client"`), per spec §f-2, es-MX:
  - 3-pane shell like `builder-client.tsx`. LEFT: live tree — campaign → ad groups → keywords/ads; per-node badge `en vivo` (grey) / `editado` (amber) / `nuevo` (green); header line `Cargado hace N min` (derive from `doc.loadedAt`, re-render each minute) + `Recargar` button → confirm dialog («Se descartarán los cambios sin aplicar») → `POST /api/command/edit` again with the same campaign → `router.replace` to the NEW blueprint id.
  - CENTER: per selected node, ONLY §a-editable fields active: campaign budget (currency input → micros; LOCKED with «Presupuesto compartido — no editable» when `base.budgetShared`) + status toggle; ad-group status toggle; add-negatives editor (campaign level); newKeywords editor per group; ads list — each RSA shows base text greyed with `Reemplazar anuncio` (opens the RSA field editor from `builder-steps.tsx` pre-filled with base values → saves into `replacement`) and each non-RSA shows «Tipo de anuncio no compatible»; `Añadir anuncio` → newAds entry. Base values always visible greyed; RSA validators (RSA_SPEC counts) exactly as in create.
  - RIGHT: `SerpPreview` of the selected ad (or its replacement) + running diff counter «N cambios» + when `base.status === "ENABLED"`: amber banner «Editando una campaña ACTIVA — los cambios aplican de inmediato al publicar».
  - Autosave: debounced `PUT /api/command/blueprint/[id]` with the WHOLE doc (server merges via mergeEditDoc; client never mutates `base`). Surface 400s inline (`ErrorCard`).
  - Footer: `Revisar cambios (N)` → `router.push(\`/command/editar/${id}/revisar\`)`, disabled when N===0. Compute N client-side with a tiny `countEdits(doc)` (desired≠base fields + new* lengths + replacements) — do NOT import the differ into the client bundle.
- [ ] **Step 4: Verify** tsc exit 0; suite green; `~/.local/bin/bunx eslint src/app/command/editar/` clean.
- [ ] **Step 5: Commit** `git add "src/app/command/editar/[id]" src/app/command/cuentas/cuentas-client.tsx && git commit -m "feat(v2.3): edit workbench UI + Editar entry from Cuentas"`

---

### Task 8: Review & apply UI — /command/editar/[id]/revisar

**Files:**
- Create: `src/app/command/editar/[id]/revisar/page.tsx`
- Create: `src/app/command/editar/[id]/revisar/revisar-client.tsx`

**Interfaces:**
- Consumes: server-side `getBlueprint` + `diffEditDoc` + `previewBlueprintGates` (same pattern as `crear/[id]/revisar/page.tsx` — READ IT and mirror; it already handles the gate-preview prop); `POST /api/command/blueprint/[id]/{approve,execute}` (reused verbatim); `POST .../rollback` for the failure path.
- Produces: the Antes→Después review per spec §f-3/§f-4.

- [ ] **Step 1: Server page** — mirror `crear/[id]/revisar/page.tsx`: gate, `await params`, scoped `getBlueprint` (+404 on wrong docType), compute `compiled = diffEditDoc(parseEditDoc(doc), id)` and `preview = previewBlueprintGates(...)` server-side, pass both.
- [ ] **Step 2: Client** — mirror `revisar-client.tsx` structurally; differences for edit mode:
  - Cards grouped by node, one per action, rendering the action's `note` (the differ's es-MX antes→después) + the payload details; RSA-replace pairs render as ONE card: «Se creará un anuncio nuevo y se pausará el anterior» with old (greyed) vs new side by side.
  - The gate-preview strip (blocking gates disable the button) IDENTICAL to create's.
  - Honesty banner replaces "EN PAUSA": «Estos cambios se aplican a una campaña EN VIVO al publicar» + the staleness line «Baseline cargado hace N min» (block with a Recargar CTA if > 60 min — mirror the TTL).
  - Button «Aplicar cambios» → approve → execute → on success `router.replace("/command/bitacora")`. 409-blocked → gate table (reuse). Execute-stage failure → the same no-retry dead-end handling as create's revisar (links «Revertir lo aplicado» → `POST .../rollback` when blueprint status is `failed`, and «Ver Bitácora») — read the create revisar's `executeFailed` handling and mirror it, adding the rollback button.
  - Double-submit guard identical to create's.
- [ ] **Step 3: Verify** tsc exit 0; suite green; eslint clean on the new folder.
- [ ] **Step 4: Commit** `git add "src/app/command/editar/[id]/revisar" && git commit -m "feat(v2.3): edit review — antes/después cards, gate preview, aplicar + revertir"`

---

### Task 9: Verification + deploy notes

**Files:**
- Modify: `docs/superpowers/plans/DEPLOY-NOTES-command-center.md`

- [ ] **Step 1:** `~/.bun/bin/bun test src/lib/command` → all green (report the count; expect ≥150).
- [ ] **Step 2:** `~/.local/bin/bunx tsc --noEmit` → exit 0.
- [ ] **Step 3:** `~/.bun/bin/bun run build` → exit 0; confirm `/command/editar/[id]`, `/command/editar/[id]/revisar`, `/api/command/edit` in the route list.
- [ ] **Step 4:** Runtime smoke — prod server on :4400 with `COMMAND_CENTER_BETA=true` + the public Supabase envs (see v2 plan Task 15): `/command/editar/x` → 404 (gated), `POST /api/command/edit` → 403.
- [ ] **Step 5:** Append to DEPLOY-NOTES a "v2.3 Edit mode" section: no migration needed; edit surface list; the §d staleness honesty table (DRIFT covers status+budget ONLY); the RSA-replace double-serving window + rollback recovery; CC_DRY_RUN cannot rehearse multi-action edit plans (same tmp:-resolution caveat as create).
- [ ] **Step 6:** Commit `git add docs/superpowers/plans/DEPLOY-NOTES-command-center.md && git commit -m "docs(v2.3): deploy notes — edit-mode rollout + staleness honesty"` and report `git log --oneline main..HEAD`.

---

## Plan self-review

- **Spec coverage:** §a edit surface → Tasks 4 (mapping) + 7 (UI locks); §b readTree/doc/mergeEditDoc → Tasks 1+3; §c differ/ordering/expected/recKey/wiring → Tasks 4+5; the ONE adapter extension → Task 2; §d staleness (TTL + honesty) → Tasks 5 (TTL) + 7/8 (UI copy) + 9 (deploy notes); §e rollback → existing recipes + Task 2's ad-branch test + Task 8's Revertir; §f UI flow → Tasks 7+8; §g API → Task 6 (+5 for compile branch); §h deferred → excluded everywhere; spec Tests list → distributed into Tasks 1-5 test steps.
- **Type consistency:** `EditCompiledAction` (Task 4) consumed by Task 5 rows + Task 6 GET + Task 8 cards; `parseEditDoc`/`mergeEditDoc`/`EDIT_BASELINE_MAX_AGE_MS` (Task 1) consumed by Tasks 5/6; `RawCampaignTree`/`buildEditDoc` (Task 3) consumed by Task 6; verbs restricted to the six allowed everywhere.
- **Placeholder scan:** every code step carries real code or an exact mirror-this-file instruction with the concrete deltas; no TBDs.
- **Known adaptation points:** Task 2's snapshot-mock must mirror the real test file's GAQL stub; Task 7's channel field on the campaigns DTO (fallback specified); Task 8 mirrors create's revisar (named file).
