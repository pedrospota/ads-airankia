import { describe, it, expect } from "bun:test";
import { previewBlueprintGates, type GatePreviewDeps } from "../blueprint/preview";
import type { BlueprintRepoDeps, CcBlueprintRow } from "../blueprint/repo";
import { CC_SETTINGS_DEFAULTS, type CcSettingsValues } from "../types";

// Same node-graph shape as blueprint-compile.test.ts / blueprint-repo.test.ts's fixture
// (already proven to satisfy blueprintDocSchema + compile()): budget → campaign → ad_group →
// keywords → ad = 5 actions.
function docFixture(dailyMicros = 350_000_000) {
  return {
    network: "google_ads",
    campaign: {
      nodeId: "c1", tempId: "campaign:2", name: "Camp", channel: "SEARCH", status: "PAUSED",
      budget: { nodeId: "b1", tempId: "budget:1", dailyMicros },
      bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
      geo: { countryCodes: ["MX"], presenceOnly: true },
      adGroups: [
        {
          nodeId: "g1", tempId: "ad_group:3", name: "AG",
          keywords: [{ text: "kw", match: "PHRASE" }],
          negatives: [],
          ads: [
            {
              nodeId: "a1", tempId: "ad:4", finalUrl: "https://x.mx/a",
              headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }],
              descriptions: [{ text: "D1" }, { text: "D2" }],
            },
          ],
        },
      ],
    },
  };
}

function baseBlueprint(over: Partial<CcBlueprintRow> = {}): CcBlueprintRow {
  return {
    id: "bp1", workspaceId: "w1", createdBy: "op@x.com", network: "google_ads",
    accountRef: "123", connectionId: null, doc: docFixture(), status: "draft", error: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  } as CcBlueprintRow;
}

// Meta doc fixture (Task 6), parameterized on the adset's daily budget so tests can drive a
// compliant vs. over-cap scenario — same node-graph shape proven valid by
// meta-compile.test.ts's fixtures: campaign → adset → ad = 3 actions.
function metaDocFixture(dailyBudgetMicros = 10_000_000) {
  return {
    network: "meta_ads",
    campaign: {
      nodeId: "c1", tempId: "campaign:1", name: "Meta Camp", status: "PAUSED", objective: "OUTCOME_TRAFFIC",
      adsets: [
        {
          nodeId: "as1", tempId: "adset:1", name: "Meta Adset", status: "PAUSED",
          dailyBudgetMicros,
          targeting: { countryCodes: ["MX"], ageMin: 18, ageMax: 65 },
          ads: [
            { nodeId: "ad1", tempId: "ad:1", name: "Ad 1", link: "https://example.com", message: "Check this out!" },
          ],
        },
      ],
    },
  };
}

function baseMetaBlueprint(over: Partial<CcBlueprintRow> = {}): CcBlueprintRow {
  return {
    id: "bp1", workspaceId: "w1", createdBy: "op@x.com", network: "meta_ads",
    accountRef: "act_123", connectionId: null, doc: metaDocFixture(), status: "draft", error: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  } as CcBlueprintRow;
}

/** In-memory fake of BlueprintRepoDeps, backed by one blueprint — mirrors
 * blueprint-repo.test.ts's harness. Never touches adsDb. Only `selectBlueprint` is actually
 * exercised by previewBlueprintGates; the rest are unreachable no-ops. */
function fakeBlueprintRepo(blueprint: CcBlueprintRow | null): BlueprintRepoDeps {
  return {
    insertBlueprint: async () => { throw new Error("not used"); },
    selectBlueprint: async (id, workspaceIds) => {
      if (!blueprint || blueprint.id !== id || !workspaceIds.includes(blueprint.workspaceId)) return null;
      return blueprint;
    },
    updateBlueprintDoc: async () => { throw new Error("not used"); },
    updateBlueprintStatus: async () => { throw new Error("not used"); },
    listActionsByBlueprint: async () => [],
    deleteProposedActionsByBlueprint: async () => {},
    insertActions: async () => [],
    approveProposedActions: async () => [],
  };
}

// The account's real cc_settings row. allowedActionTypes must explicitly include the create
// family — mirrors plan-runner.test.ts's fake settings (production rowToSettings() filters
// these against CC_ACTION_TYPES, a pre-existing gap outside this task's scope; the preview
// must reuse the SAME real settings the executor uses, gap and all).
const ALLOWED_WITH_CREATES = [
  "create_budget", "create_campaign", "create_ad_group", "create_keywords", "create_ad",
] as unknown as CcSettingsValues["allowedActionTypes"];

// Meta's create verb set (Task 6) is disjoint from ALLOWED_WITH_CREATES above (no
// create_budget/create_ad_group/create_keywords; adds create_adset) — a compliant meta
// preview needs its own allow-list override or ACTION_ALLOWED blocks create_adset regardless
// of the scenario under test.
const ALLOWED_WITH_ADSET = [
  "create_campaign", "create_adset", "create_ad",
] as unknown as CcSettingsValues["allowedActionTypes"];

function makeDeps(opts: {
  blueprint: CcBlueprintRow | null;
  settings?: Partial<CcSettingsValues>;
  executedToday?: number;
}): GatePreviewDeps {
  return {
    blueprintRepo: fakeBlueprintRepo(opts.blueprint),
    settings: {
      get: async () => ({ ...CC_SETTINGS_DEFAULTS, allowedActionTypes: ALLOWED_WITH_CREATES, ...opts.settings }),
    },
    repo: { countExecutedToday: async () => opts.executedToday ?? 0 },
  };
}

// Edit-doc fixture (Task 5): same shape as edit-diff.test.ts's baseDoc(), with the campaign's
// desired.dailyBudgetMicros parameterized so tests can drive an over-cap vs. compliant change.
function editDocFixture(desiredDailyBudgetMicros: number) {
  return {
    docType: "google_search_edit_v1", network: "google_ads", accountRef: "123",
    loadedAt: "2026-07-07T12:00:00.000Z",
    campaign: {
      resourceName: "customers/123/campaigns/5", id: "5",
      base: {
        name: "C", status: "ENABLED", dailyBudgetMicros: 350_000_000,
        budgetResourceName: "customers/123/campaignBudgets/9", budgetShared: false, currency: "USD",
      },
      desired: { status: "ENABLED", dailyBudgetMicros: desiredDailyBudgetMicros },
      newNegatives: [],
      adGroups: [{
        resourceName: "customers/123/adGroups/7", id: "7",
        base: { name: "G", status: "ENABLED", cpcBidMicros: null }, desired: { status: "ENABLED", cpcBidMicros: null },
        baseKeywords: [{ text: "kw", match: "PHRASE", negative: false, resourceName: "customers/123/adGroupCriteria/7~1", status: "ENABLED" }],
        newKeywords: [], newAds: [],
        ads: [{
          resourceName: "customers/123/adGroupAds/7~11", unsupported: false,
          base: {
            status: "ENABLED", finalUrl: "https://x.com",
            headlines: [{ text: "H1" }, { text: "H2" }, { text: "H3" }], descriptions: [{ text: "D1" }, { text: "D2" }],
          },
          replacement: null,
        }],
      }],
    },
  };
}

describe("previewBlueprintGates", () => {
  it("a valid blueprint (budget within cap, action types allowed) has zero blocking gates", async () => {
    const deps = makeDeps({ blueprint: baseBlueprint() });

    const preview = await previewBlueprintGates("bp1", ["w1"], deps);

    expect(preview.summary.actions).toBe(5); // budget, campaign, ad_group, keywords, ad
    expect(preview.summary.blockingCount).toBe(0);
    expect(preview.validateOnlyDeferred).toBe(true);
    expect(preview.perAction.every((a) => a.blocking.length === 0)).toBe(true);
    // VALIDATE_ONLY is always unresolved pre-creation — present in the full gate list...
    expect(preview.perAction.every((a) => a.gates.some((g) => g.id === "VALIDATE_ONLY"))).toBe(true);
    // ...but never counted as a real block.
    expect(
      preview.perAction.every((a) => a.gates.find((g) => g.id === "VALIDATE_ONLY")?.status === "fail")
    ).toBe(true);
  });

  it("a budget exceeding settings.maxDailyBudgetMicros blocks the budget action with ABS_BUDGET_CAP", async () => {
    const deps = makeDeps({
      blueprint: baseBlueprint({ doc: docFixture(900_000_000) }),
      settings: { maxDailyBudgetMicros: 500_000_000 },
    });

    const preview = await previewBlueprintGates("bp1", ["w1"], deps);

    const budgetAction = preview.perAction.find((a) => a.actionType === "create_budget");
    expect(budgetAction?.blocking.map((g) => g.id)).toContain("ABS_BUDGET_CAP");
    expect(preview.summary.blockingCount).toBeGreaterThan(0);
  });

  it("throws when the blueprint is missing or out of the caller's workspace scope", async () => {
    const deps = makeDeps({ blueprint: baseBlueprint() });
    await expect(previewBlueprintGates("bp1", ["other-ws"], deps)).rejects.toThrow();
    await expect(previewBlueprintGates("missing", ["w1"], deps)).rejects.toThrow();
  });
});

describe("previewBlueprintGates — edit-doc branch (Task 5)", () => {
  // allowedActionTypes must explicitly include budget_update — ALLOWED_WITH_CREATES (this
  // file's default override, above) only lists the v2 create_* family, so edit-branch actions
  // need their own allow-list override or ACTION_ALLOWED would block them regardless of the
  // scenario under test.
  const ALLOWED_WITH_EDITS = CC_SETTINGS_DEFAULTS.allowedActionTypes;

  it("an edit blueprint's over-cap budget change blocks with ABS_BUDGET_CAP", async () => {
    const deps = makeDeps({
      blueprint: baseBlueprint({ doc: editDocFixture(500_000_000) }),
      settings: { maxDailyBudgetMicros: 400_000_000, allowedActionTypes: ALLOWED_WITH_EDITS },
    });

    const preview = await previewBlueprintGates("bp1", ["w1"], deps);

    const budgetAction = preview.perAction.find((a) => a.actionType === "budget_update");
    expect(budgetAction?.blocking.map((g) => g.id)).toContain("ABS_BUDGET_CAP");
  });

  it("an edit blueprint's compliant budget change (within cap and delta) has zero blocking gates", async () => {
    const deps = makeDeps({
      blueprint: baseBlueprint({ doc: editDocFixture(380_000_000) }),
      settings: { maxDailyBudgetMicros: 400_000_000, allowedActionTypes: ALLOWED_WITH_EDITS },
    });

    const preview = await previewBlueprintGates("bp1", ["w1"], deps);

    expect(preview.summary.actions).toBe(1); // only the budget change diffs
    expect(preview.summary.blockingCount).toBe(0);
  });
});

describe("previewBlueprintGates — meta network branch (Task 6)", () => {
  it("a compliant meta blueprint has zero blocking gates, network:'meta_ads' reaches GateInput", async () => {
    const deps = makeDeps({
      blueprint: baseMetaBlueprint(),
      settings: { allowedActionTypes: ALLOWED_WITH_ADSET },
    });

    const preview = await previewBlueprintGates("bp1", ["w1"], deps);

    expect(preview.summary.actions).toBe(3); // campaign, adset, ad
    expect(preview.summary.blockingCount).toBe(0);
    expect(preview.validateOnlyDeferred).toBe(true);
    // PAUSED_ON_CREATE runs and passes for the campaign+adset actions — only reachable if the
    // meta-shaped payload (status: "PAUSED" literal from compileMeta) made it into GateInput,
    // and only stays a *pass* (not a block) if CAPABILITY/ACTION_ALLOWED also passed against
    // the meta-shaped capabilities/allow-list rather than the google ones.
    const pausedOnCreateRows = preview.perAction.flatMap((a) => a.gates).filter((g) => g.id === "PAUSED_ON_CREATE");
    expect(pausedOnCreateRows.length).toBeGreaterThan(0);
    expect(pausedOnCreateRows.every((g) => g.status === "pass")).toBe(true);
  });

  it("an over-cap adset budget blocks the create_adset action with ABS_BUDGET_CAP", async () => {
    const deps = makeDeps({
      blueprint: baseMetaBlueprint({ doc: metaDocFixture(900_000_000) }),
      settings: { allowedActionTypes: ALLOWED_WITH_ADSET, maxDailyBudgetMicros: 500_000_000 },
    });

    const preview = await previewBlueprintGates("bp1", ["w1"], deps);

    const adsetAction = preview.perAction.find((a) => a.actionType === "create_adset");
    expect(adsetAction?.blocking.map((g) => g.id)).toContain("ABS_BUDGET_CAP");
    expect(preview.summary.blockingCount).toBeGreaterThan(0);
  });
});

// Meta-EDIT doc fixture (meta-edit plan Task 5) — ABO adset with base 20.00,
// desired parameterized; plus one ad pause so status verbs are exercised too.
function metaEditDocFixture(desiredAdsetBudgetMicros: number) {
  return {
    docType: "meta_edit_v1", network: "meta_ads", accountRef: "act_123",
    loadedAt: "2026-07-08T12:00:00.000Z",
    campaign: {
      id: "111",
      base: { name: "C", status: "ENABLED", effectiveStatus: "ACTIVE",
              dailyBudgetMicros: null, lifetimeBudgetMicros: null, currency: "MXN" },
      desired: { status: "ENABLED", dailyBudgetMicros: null },
      adsets: [{
        id: "222",
        base: { name: "AS", status: "ENABLED", effectiveStatus: "ACTIVE",
                dailyBudgetMicros: 20_000_000, lifetimeBudgetMicros: null, learningPhase: "STABLE" },
        desired: { status: "ENABLED", dailyBudgetMicros: desiredAdsetBudgetMicros },
        ads: [{ id: "333", base: { name: "Ad 1", status: "ENABLED", effectiveStatus: "ACTIVE" }, desired: { status: "PAUSED" } }],
      }],
    },
  };
}

function baseMetaEditBlueprint(over: Partial<CcBlueprintRow> = {}): CcBlueprintRow {
  return baseMetaBlueprint({ doc: metaEditDocFixture(22_000_000), ...over });
}

describe("previewBlueprintGates — meta-edit docType branch", () => {
  it("compiles via the differ; every action's gates carry network meta_ads and pass under the DEFAULT allow-list (zero migrations)", async () => {
    // NOTE: settings deliberately NOT overridden — CC_SETTINGS_DEFAULTS already
    // allows budget_update|pause|enable (the zero-migration property).
    const deps = makeDeps({ blueprint: baseMetaEditBlueprint() });
    const preview = await previewBlueprintGates("bp1", ["w1"], { ...deps, settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS }) } });

    expect(preview.perAction.map((a) => a.actionType)).toEqual(["pause", "budget_update"]);
    expect(preview.summary.blockingCount).toBe(0);
    // META_LEARNING_RESET only exists as a non-"No aplica" result when the gate
    // ran with network meta_ads AND saw a real prior budget — both properties at once.
    const budgetGates = preview.perAction[1].gates;
    const mlr = budgetGates.find((g) => g.id === "META_LEARNING_RESET")!;
    expect(mlr.status).toBe("pass");
    expect(mlr.evidence).toContain("10.0%"); // 20.00 → 22.00 = 10% — computed FROM expected
  });

  it("synthetic before is seeded from action.expected: BUDGET_DELTA blocks a >30% jump (needs the prior budget)", async () => {
    const deps = makeDeps({ blueprint: baseMetaEditBlueprint({ doc: metaEditDocFixture(30_000_000) }) }); // +50%
    const preview = await previewBlueprintGates("bp1", ["w1"], { ...deps, settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS }) } });

    const budget = preview.perAction.find((a) => a.actionType === "budget_update")!;
    expect(budget.blocking.map((g) => g.id)).toContain("BUDGET_DELTA");
    // Had before been the create branches' bare UNKNOWN, BUDGET_DELTA would fail
    // with "Sin presupuesto base medible" — assert the delta evidence instead.
    expect(budget.blocking.find((g) => g.id === "BUDGET_DELTA")!.evidence).toContain("50.0%");
  });

  it("CAPABILITY: SYNTHETIC_CAPABILITIES_META_EDIT grants exactly budget_update|pause|enable (a create verb would block)", async () => {
    const deps = makeDeps({ blueprint: baseMetaEditBlueprint() });
    const preview = await previewBlueprintGates("bp1", ["w1"], { ...deps, settings: { get: async () => ({ ...CC_SETTINGS_DEFAULTS }) } });
    for (const a of preview.perAction) {
      expect(a.gates.find((g) => g.id === "CAPABILITY")!.status).toBe("pass");
      // Meta non-create verbs never require a rehearsal — VALIDATE_ONLY passes
      // ("No aplica"), unlike every google preview row.
      expect(a.gates.find((g) => g.id === "VALIDATE_ONLY")!.status).toBe("pass");
    }
  });

  it("risk #1 regression: a meta CREATE blueprint still previews through compileMeta with SYNTHETIC_CAPABILITIES_META", async () => {
    const deps = makeDeps({
      blueprint: baseMetaBlueprint(),
      settings: { allowedActionTypes: ALLOWED_WITH_ADSET },
    });
    const preview = await previewBlueprintGates("bp1", ["w1"], deps);
    expect(preview.perAction.map((a) => a.actionType)).toEqual(["create_campaign", "create_adset", "create_ad"]);
    expect(preview.summary.blockingCount).toBe(0);
  });
});
