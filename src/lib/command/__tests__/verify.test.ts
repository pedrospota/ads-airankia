import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  runSweep, verifyOutcome,
  CC_APPROVAL_TTL_HOURS, VERIFIABLE_ACTION_TYPES,
  type VerifyDeps,
} from "../verify";
import type { CcActionRow } from "../actions-repo";
import type { CommandAccess } from "../access";
import type { AdapterAuth, EntitySnapshot, NetworkAdapter } from "../types";
import { metaBudgetRoundMicros } from "../networks/meta";

// ---------------------------------------------------------------------------
// Fixtures — mirrors executor.test.ts / plan-runner.test.ts's in-memory-fakes
// style: baseAction() + fakeAdapter() + a harness that wires a fake VerifyDeps.
// ---------------------------------------------------------------------------

function baseAction(over: Partial<CcActionRow> & Record<string, unknown> = {}): CcActionRow {
  return {
    id: "a1", workspaceId: "w1", createdBy: "op@x.com", network: "google_ads",
    connectionId: "c1", accountRef: "123", entityKind: "campaign", entityRef: "111",
    entityName: "Marca", actionType: "budget_update", payload: { newDailyBudgetMicros: 20_000_000 },
    expected: null, source: "manual", recKey: null, rationale: null, evidence: null,
    status: "executed", approvedBy: "op@x.com", approvedAt: new Date(),
    executedAt: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5h ago: older than VERIFY_AFTER_HOURS
    gateResults: null, error: null, blueprintId: null, seq: null, localRef: null, resultRef: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  } as CcActionRow;
}

function snapshot(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return { entityKind: "campaign", entityRef: "111", status: "ENABLED", dailyBudgetMicros: 20_000_000, ...over };
}

function access(workspaceIds: string[]): CommandAccess {
  return { email: "op@x.com", userId: "u1", accessToken: "tok", workspaceIds };
}

interface Harness {
  deps: VerifyDeps;
  drifted: Array<{ id: string; note: string }>;
  transitions: Array<{ id: string; to: string; patch?: Record<string, unknown> }>;
  calls: { expireStaleApproved: number; listVerifiableExecuted: number; snapshot: number; execute: number };
}

interface HarnessOpts {
  candidates?: CcActionRow[];
  expireResult?: number;
  adapterOverrides?: Partial<NetworkAdapter>;
  authResolve?: (action: CcActionRow) => Promise<AdapterAuth>;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const drifted: Harness["drifted"] = [];
  const transitions: Harness["transitions"] = [];
  const calls = { expireStaleApproved: 0, listVerifiableExecuted: 0, snapshot: 0, execute: 0 };

  const adapter: NetworkAdapter = {
    network: "google_ads",
    capabilities: () => ({ read: true, write: true, actionTypes: [] }),
    listCampaigns: async () => [],
    snapshot: async () => { calls.snapshot++; return snapshot(); },
    // verify.ts must NEVER call this — if it does, the test fails loudly.
    execute: async () => { calls.execute++; throw new Error("adapter.execute must never be called by the sweep"); },
    buildRollback: () => null,
    ...opts.adapterOverrides,
  };

  const deps: VerifyDeps = {
    repo: {
      expireStaleApproved: async () => { calls.expireStaleApproved++; return opts.expireResult ?? 0; },
      listVerifiableExecuted: async () => { calls.listVerifiableExecuted++; return opts.candidates ?? []; },
      recordVerificationDrift: async (id, note) => { drifted.push({ id, note }); },
      transitionAction: async (row, to, patch) => { transitions.push({ id: row.id, to, patch }); },
    },
    adapters: { for: () => adapter },
    auth: { resolve: opts.authResolve ?? (async () => ({ googleRefreshToken: "rt" })) },
  };

  return { deps, drifted, transitions, calls };
}

// ---------------------------------------------------------------------------
// verifyOutcome — pure matrix
// ---------------------------------------------------------------------------

describe("verifyOutcome", () => {
  it("google budget_update: exact micros match → verified", () => {
    const action = baseAction({ network: "google_ads", actionType: "budget_update", payload: { newDailyBudgetMicros: 20_000_000 } });
    const out = verifyOutcome(action, snapshot({ dailyBudgetMicros: 20_000_000 }));
    expect(out).toEqual({ outcome: "verified" });
  });

  it("google budget_update: mismatch → drift with expected/actual note", () => {
    const action = baseAction({ network: "google_ads", actionType: "budget_update", payload: { newDailyBudgetMicros: 20_000_000 } });
    const out = verifyOutcome(action, snapshot({ dailyBudgetMicros: 15_000_000 }));
    expect(out.outcome).toBe("drift");
    expect(out.note).toContain("20000000");
    expect(out.note).toContain("15000000");
  });

  it("meta budget_update: rounded compare verifies a non-cent-round payload (the rounding-mirror regression)", () => {
    // 34_996_000 micros is not a clean cents multiple; the adapter itself
    // rounds to cents on write (metaBudgetRoundMicros), so verify must mirror
    // that rounding or it will false-drift every such Meta budget.
    const action = baseAction({ network: "meta_ads", actionType: "budget_update", payload: { newDailyBudgetMicros: 34_996_000 } });
    expect(metaBudgetRoundMicros(34_996_000)).toBe(35_000_000); // pin the mirror's own math
    const out = verifyOutcome(action, snapshot({ dailyBudgetMicros: 35_000_000 }));
    expect(out).toEqual({ outcome: "verified" });
    // A raw (unrounded) compare would have been 34_996_000 !== 35_000_000 → false drift.
    expect(action.payload).not.toEqual({ newDailyBudgetMicros: 35_000_000 });
  });

  it("meta budget_update: genuine drift still reported after rounding", () => {
    const action = baseAction({ network: "meta_ads", actionType: "budget_update", payload: { newDailyBudgetMicros: 34_996_000 } });
    const out = verifyOutcome(action, snapshot({ dailyBudgetMicros: 40_000_000 }));
    expect(out.outcome).toBe("drift");
    expect(out.note).toContain("35000000");
    expect(out.note).toContain("40000000");
  });

  it("pause: verified iff after.status === 'PAUSED'", () => {
    const action = baseAction({ actionType: "pause", payload: {} });
    expect(verifyOutcome(action, snapshot({ status: "PAUSED" }))).toEqual({ outcome: "verified" });
    const drift = verifyOutcome(action, snapshot({ status: "ENABLED" }));
    expect(drift.outcome).toBe("drift");
    expect(drift.note).toContain("PAUSED");
    expect(drift.note).toContain("ENABLED");
  });

  it("enable: verified iff after.status === 'ENABLED'", () => {
    const action = baseAction({ actionType: "enable", payload: {} });
    expect(verifyOutcome(action, snapshot({ status: "ENABLED" }))).toEqual({ outcome: "verified" });
    const drift = verifyOutcome(action, snapshot({ status: "PAUSED" }));
    expect(drift.outcome).toBe("drift");
    expect(drift.note).toContain("ENABLED");
    expect(drift.note).toContain("PAUSED");
  });

  it("budget_update: after.dailyBudgetMicros null on a SUCCESSFUL snapshot (Meta CBO/lifetime budget) → unverifiable, not drift", () => {
    const action = baseAction({ network: "meta_ads", actionType: "budget_update", payload: { newDailyBudgetMicros: 20_000_000 } });
    const out = verifyOutcome(action, snapshot({ dailyBudgetMicros: null }));
    expect(out).toEqual({ outcome: "unverifiable" });
  });

  it("pause/enable: after.status null or 'UNKNOWN' on a SUCCESSFUL snapshot → unverifiable, not drift", () => {
    const action = baseAction({ actionType: "pause", payload: {} });
    expect(verifyOutcome(action, snapshot({ status: undefined }))).toEqual({ outcome: "unverifiable" });
    expect(verifyOutcome(action, snapshot({ status: "UNKNOWN" }))).toEqual({ outcome: "unverifiable" });
  });

  it("budget_update: malformed payload (missing newDailyBudgetMicros) → unverifiable, not a garbled drift note", () => {
    const action = baseAction({ actionType: "budget_update", payload: {} as unknown as { newDailyBudgetMicros: number } });
    const out = verifyOutcome(action, snapshot({ dailyBudgetMicros: 20_000_000 }));
    expect(out).toEqual({ outcome: "unverifiable" });
  });
});

describe("VERIFIABLE_ACTION_TYPES", () => {
  it("is exactly {budget_update, pause, enable} — actions-repo.ts's listVerifiableExecuted mirrors this literal", () => {
    expect([...VERIFIABLE_ACTION_TYPES].sort()).toEqual(["budget_update", "enable", "pause"]);
  });

  it("(duplication pin) actions-repo.ts's listVerifiableExecuted inArray literal contains EXACTLY the members of VERIFIABLE_ACTION_TYPES", () => {
    // The two can't import each other (repo↔verify circular import — see the
    // comment above listVerifiableExecuted in actions-repo.ts), so the repo's
    // literal is duplicated by hand. Grep-assert on the source text — mirrors
    // this file's "verify.ts source never calls executeAction" technique
    // below — so the two lists can't silently drift apart.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "actions-repo.ts"), "utf8");
    const match = src.match(/inArray\(ccActions\.actionType,\s*\[([^\]]+)\]\)/);
    expect(match).not.toBeNull();
    const literalTypes = match![1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    expect(literalTypes.sort()).toEqual([...VERIFIABLE_ACTION_TYPES].sort());
  });
});

// ---------------------------------------------------------------------------
// runSweep — orchestration, via fake VerifyDeps. Each test uses a UNIQUE
// workspaceIds set so the module-scope throttle/in-flight state (by design,
// shared across the whole test file) can't leak between cases.
// ---------------------------------------------------------------------------

describe("runSweep — expiry pass", () => {
  it("calls expireStaleApproved with the workspace scope and the CC_APPROVAL_TTL_HOURS constant, propagates its count", async () => {
    const { deps, calls } = makeHarness({ expireResult: 3 });
    const result = await runSweep(access(["w-expiry"]), deps);
    expect(calls.expireStaleApproved).toBe(1);
    expect(result.expired).toBe(3);
  });

  it("(predicate pin) mirrors the intended repo filter: only approved rows older than the TTL, scoped to the given workspaces", async () => {
    // actions-repo.ts's real expireStaleApproved is DB-backed and not unit
    // tested here (consistent with the rest of this file's repo layer); this
    // pins the CONTRACT the fake — and the real SQL — must implement.
    const now = Date.now();
    const rows = [
      { id: "old-approved", workspaceId: "w-expiry-2", status: "approved", approvedAt: new Date(now - 73 * 3600_000) },
      { id: "fresh-approved", workspaceId: "w-expiry-2", status: "approved", approvedAt: new Date(now - 1 * 3600_000) },
      { id: "old-executed", workspaceId: "w-expiry-2", status: "executed", approvedAt: new Date(now - 100 * 3600_000) },
      { id: "old-other-ws", workspaceId: "w-unrelated", status: "approved", approvedAt: new Date(now - 100 * 3600_000) },
    ];
    const captured: { args: [string[], number] | null } = { args: null };
    const { deps } = makeHarness();
    deps.repo.expireStaleApproved = async (workspaceIds, olderThanHours) => {
      captured.args = [workspaceIds, olderThanHours];
      const cutoff = now - olderThanHours * 3600_000;
      return rows.filter((r) => workspaceIds.includes(r.workspaceId) && r.status === "approved" && r.approvedAt.getTime() < cutoff).length;
    };
    const result = await runSweep(access(["w-expiry-2"]), deps);
    expect(captured.args).toEqual([["w-expiry-2"], CC_APPROVAL_TTL_HOURS]);
    expect(result.expired).toBe(1); // only old-approved
  });
});

describe("runSweep — verification pass", () => {
  it("verified: google budget_update matching → transitionAction(row, 'verified', evidence stamp), no drift write", async () => {
    const row = baseAction({ id: "v1", network: "google_ads", actionType: "budget_update", payload: { newDailyBudgetMicros: 20_000_000 }, evidence: { proposal: "x" } });
    const { deps, drifted, transitions, calls } = makeHarness({
      candidates: [row],
      adapterOverrides: { snapshot: async () => { calls.snapshot++; return snapshot({ dailyBudgetMicros: 20_000_000 }); } },
    });
    const result = await runSweep(access(["w-verify-google"]), deps);
    expect(calls.listVerifiableExecuted).toBe(1);
    expect(calls.snapshot).toBe(1);
    expect(drifted).toHaveLength(0);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ id: "v1", to: "verified" });
    const evidence = transitions[0].patch?.evidence as { proposal?: string; verification?: Record<string, unknown> };
    expect(evidence.proposal).toBe("x"); // prior evidence preserved (merge, not clobber)
    expect(evidence.verification).toMatchObject({ checkedField: "dailyBudgetMicros", expected: 20_000_000, actual: 20_000_000 });
    expect(typeof evidence.verification?.checkedAt).toBe("string");
    expect(result).toEqual({ expired: 0, verified: 1, drifted: 0, checked: 1 });
  });

  it("verified: meta budget_update within the cents-rounding tolerance", async () => {
    const row = baseAction({ id: "v2", network: "meta_ads", actionType: "budget_update", payload: { newDailyBudgetMicros: 34_996_000 } });
    const { deps, drifted, transitions } = makeHarness({
      candidates: [row],
      adapterOverrides: { network: "meta_ads", snapshot: async () => snapshot({ dailyBudgetMicros: 35_000_000 }) },
    });
    const result = await runSweep(access(["w-verify-meta"]), deps);
    expect(drifted).toHaveLength(0);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].to).toBe("verified");
    expect(result.verified).toBe(1);
  });

  it("verified: pause / enable both directions", async () => {
    const pauseRow = baseAction({ id: "p1", actionType: "pause", payload: {} });
    const { deps: pauseDeps, transitions: pauseTransitions } = makeHarness({
      candidates: [pauseRow], adapterOverrides: { snapshot: async () => snapshot({ status: "PAUSED" }) },
    });
    await runSweep(access(["w-verify-pause"]), pauseDeps);
    expect(pauseTransitions[0]?.to).toBe("verified");

    const enableRow = baseAction({ id: "e1", actionType: "enable", payload: {} });
    const { deps: enableDeps, transitions: enableTransitions } = makeHarness({
      candidates: [enableRow], adapterOverrides: { snapshot: async () => snapshot({ status: "ENABLED" }) },
    });
    await runSweep(access(["w-verify-enable"]), enableDeps);
    expect(enableTransitions[0]?.to).toBe("verified");
  });

  it("drift: status mismatch → recordVerificationDrift with a Spanish note, row status UNCHANGED (no transitionAction call)", async () => {
    const row = baseAction({ id: "d1", actionType: "pause", payload: {} });
    const { deps, drifted, transitions } = makeHarness({
      candidates: [row], adapterOverrides: { snapshot: async () => snapshot({ status: "ENABLED" }) },
    });
    const result = await runSweep(access(["w-drift"]), deps);
    expect(transitions).toHaveLength(0); // executed→drift is NOT an edge; status stays untouched
    expect(drifted).toHaveLength(1);
    expect(drifted[0].id).toBe("d1");
    expect(drifted[0].note).toContain("PAUSED");
    expect(drifted[0].note).toContain("ENABLED");
    expect(result).toEqual({ expired: 0, verified: 0, drifted: 1, checked: 1 });
  });

  it("(one-shot pin) once error is set by drift, the row's own predicate would exclude it from a future select", () => {
    // Mirrors listVerifiableExecuted's `error IS NULL` filter — after
    // recordVerificationDrift writes a note, the row is no longer selectable.
    const rows = [
      { id: "still-selectable", status: "executed", error: null as string | null, actionType: "budget_update" },
      { id: "already-drifted", status: "executed", error: "Deriva de estado: ...", actionType: "budget_update" },
    ];
    const selectable = (r: (typeof rows)[number]) =>
      r.status === "executed" && r.error === null && VERIFIABLE_ACTION_TYPES.has(r.actionType);
    expect(rows.filter(selectable).map((r) => r.id)).toEqual(["still-selectable"]);
  });

  it("budget_update: after.dailyBudgetMicros null on a SUCCESSFUL snapshot (Meta CBO/lifetime budget) → skipped untouched, NOT drifted, NOT verified, still selectable next sweep", async () => {
    const row = baseAction({ id: "nb1", network: "meta_ads", actionType: "budget_update", payload: { newDailyBudgetMicros: 20_000_000 } });
    const { deps, drifted, transitions, calls } = makeHarness({
      candidates: [row],
      adapterOverrides: { network: "meta_ads", snapshot: async () => { calls.snapshot++; return snapshot({ dailyBudgetMicros: null }); } },
    });
    const result = await runSweep(access(["w-null-budget"]), deps);
    expect(calls.snapshot).toBe(1);
    expect(transitions).toHaveLength(0); // not verified — no evidence stamp written
    expect(drifted).toHaveLength(0); // not drifted — error column stays null, row stays selectable
    expect(result).toEqual({ expired: 0, verified: 0, drifted: 0, checked: 1 });
  });

  it("read error on snapshot(): row is skipped untouched, no drift/verified write (retryable next sweep)", async () => {
    const row = baseAction({ id: "r1" });
    const { deps, drifted, transitions, calls } = makeHarness({
      candidates: [row],
      adapterOverrides: { snapshot: async () => { calls.snapshot++; throw new Error("network blip"); } },
    });
    const result = await runSweep(access(["w-read-error"]), deps);
    expect(calls.snapshot).toBe(1);
    expect(transitions).toHaveLength(0);
    expect(drifted).toHaveLength(0);
    expect(result).toEqual({ expired: 0, verified: 0, drifted: 0, checked: 1 });
  });

  it("capabilities().read === false: skipped WITHOUT stamping, snapshot never called (auto-retries when creds land)", async () => {
    const row = baseAction({ id: "c1", network: "meta_ads" });
    const { deps, drifted, transitions, calls } = makeHarness({
      candidates: [row],
      adapterOverrides: { network: "meta_ads", capabilities: () => ({ read: false, write: false, actionTypes: [], reason: "META_SYSTEM_USER_TOKEN no configurado" }) },
    });
    const result = await runSweep(access(["w-capability-skip"]), deps);
    expect(calls.snapshot).toBe(0);
    expect(transitions).toHaveLength(0);
    expect(drifted).toHaveLength(0);
    expect(result.checked).toBe(1); // was considered this pass, just not stamped
  });

  it("never calls adapter.execute", async () => {
    const row = baseAction({ id: "n1" });
    const { deps, calls } = makeHarness({ candidates: [row] });
    await runSweep(access(["w-no-execute"]), deps);
    expect(calls.execute).toBe(0);
  });

  it("auth.resolve throws for one row in the batch: that row is skipped untouched, the sweep still RESOLVES (not rejects), and a healthy row later in the batch still gets verified", async () => {
    const poisonRow = baseAction({ id: "poison1" });
    const healthyRow = baseAction({ id: "healthy1" });
    const { deps, drifted, transitions, calls } = makeHarness({
      candidates: [poisonRow, healthyRow],
      authResolve: async (action) => {
        if (action.id === "poison1") throw new Error("disconnected OAuth: no connectionId");
        return { googleRefreshToken: "rt" };
      },
      adapterOverrides: { snapshot: async () => { calls.snapshot++; return snapshot({ dailyBudgetMicros: 20_000_000 }); } },
    });
    const result = await runSweep(access(["w-poison-row"]), deps);
    expect(calls.snapshot).toBe(1); // only the healthy row ever reached adapter.snapshot
    expect(transitions).toHaveLength(1);
    expect(transitions[0].id).toBe("healthy1");
    expect(drifted).toHaveLength(0); // poison1 was skipped, not drifted
    expect(result).toEqual({ expired: 0, verified: 1, drifted: 0, checked: 2 });
  });
});

describe("runSweep — double-run guard", () => {
  it("in-flight dedupe: two concurrent calls share one execution", async () => {
    const row = baseAction({ id: "dd1" });
    const { deps, calls } = makeHarness({ candidates: [row] });
    const [r1, r2] = await Promise.all([
      runSweep(access(["w-dedupe"]), deps),
      runSweep(access(["w-dedupe"]), deps),
    ]);
    expect(calls.listVerifiableExecuted).toBe(1);
    expect(calls.expireStaleApproved).toBe(1);
    expect(r1).toEqual(r2);
  });

  it("throttle: a second call for the same workspace scope shortly after a completed sweep returns zeros without touching the repo", async () => {
    const { deps, calls } = makeHarness({ expireResult: 5 });
    const first = await runSweep(access(["w-throttle"]), deps);
    expect(first.expired).toBe(5);
    expect(calls.expireStaleApproved).toBe(1);

    const second = await runSweep(access(["w-throttle"]), deps);
    expect(second).toEqual({ expired: 0, verified: 0, drifted: 0, checked: 0 });
    expect(calls.expireStaleApproved).toBe(1); // unchanged: no repo call at all
    expect(calls.listVerifiableExecuted).toBe(1); // unchanged
  });

  it("throttle is scoped per workspace set: a different workspace scope is not throttled", async () => {
    const { deps: deps1 } = makeHarness({ expireResult: 1 });
    await runSweep(access(["w-throttle-scope-a"]), deps1);

    const { deps: deps2, calls: calls2 } = makeHarness({ expireResult: 2 });
    const result = await runSweep(access(["w-throttle-scope-b"]), deps2);
    expect(calls2.expireStaleApproved).toBe(1);
    expect(result.expired).toBe(2);
  });

  it("in-flight dedupe is scoped per workspace set: concurrent calls for DIFFERENT scopes both execute independently (not deduped into one, don't share counts); same-scope concurrency still dedupes (see test above)", async () => {
    const rowA = baseAction({ id: "diffA" });
    const rowB = baseAction({ id: "diffB" });
    const harnessA = makeHarness({ candidates: [rowA] });
    const harnessB = makeHarness({ candidates: [rowB] });
    const [resultA, resultB] = await Promise.all([
      runSweep(access(["w-dedupe-scope-a"]), harnessA.deps),
      runSweep(access(["w-dedupe-scope-b"]), harnessB.deps),
    ]);
    // Both scopes actually ran their own repo calls — neither was starved by
    // sharing the other scope's in-flight promise.
    expect(harnessA.calls.listVerifiableExecuted).toBe(1);
    expect(harnessB.calls.listVerifiableExecuted).toBe(1);
    expect(resultA.checked).toBe(1);
    expect(resultB.checked).toBe(1);
    // Each scope's own row was verified — not the other scope's row (i.e. no
    // cross-contamination of counts/results between the two Maps entries).
    expect(harnessA.transitions).toHaveLength(1);
    expect(harnessA.transitions[0]?.id).toBe("diffA");
    expect(harnessB.transitions).toHaveLength(1);
    expect(harnessB.transitions[0]?.id).toBe("diffB");
  });
});

describe("safety invariant: verify.ts source never calls executeAction or adapter.execute", () => {
  it("grep-assert on the module source", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "verify.ts"), "utf8");
    expect(src).not.toMatch(/executeAction\s*\(/);
    expect(src).not.toMatch(/\.execute\s*\(/);
  });
});

describe("invariant: only recordVerificationDrift writes error on executed rows", () => {
  it("(sole-error-writer pin) actions-repo.ts's recordVerificationDrift has guarded UPDATE with both error set AND status='executed' in WHERE", () => {
    // The sole writer of `error` on an 'executed' row must:
    // (a) SET error to a non-null value (error: note)
    // (b) GUARD the WHERE clause with status='executed' so the write is a no-op if row moved on
    // This ensures error≠null on 'executed' unambiguously means drift.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "actions-repo.ts"), "utf8");
    expect(src).toContain("function recordVerificationDrift");
    expect(src).toMatch(/recordVerificationDrift[\s\S]*?\.set\(\s*\{\s*error:\s*note/);
    expect(src).toMatch(/recordVerificationDrift[\s\S]*?eq\(ccActions\.status,\s*["']executed["']\)/);
  });

  it("(sole-error-writer pin) executor.ts's executeAction transition to 'executed' clears error to null on success", () => {
    // When a mutation succeeds, the action transitions from 'executing' to 'executed'
    // and error must be explicitly cleared to null so it can't carry forward from a failed attempt.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "executor.ts"), "utf8");
    expect(src).toMatch(/transitionAction[\s\S]*?["']executed["'][\s\S]*?error:\s*null/);
  });
});
