// Centro de Mando v2.6 — LAZY VERIFICATION SWEEP.
// READ-only against the ad networks: expires stale approvals (DB-only, atomic)
// and verifies that already-executed mutations actually landed (ONE
// adapter.snapshot() read per candidate row, capped). NEVER calls
// executeAction/adapter.execute — see design spec §c and top-risk #? (the
// error column is the sole drift signal; recordVerificationDrift is its only
// writer on an 'executed' row).
import { assertTransition } from "./state";
import { buildExecutorDeps } from "./executor-deps";
import { metaBudgetRoundMicros } from "./networks/meta";
import * as repo from "./actions-repo";
import type { CcActionRow } from "./actions-repo";
import type { CommandAccess } from "./access";
import type {
  AdapterAuth, BudgetUpdatePayload, CcActionStatus, CcEntityKind, CcNetwork,
  EntitySnapshot, NetworkAdapter,
} from "./types";

// Sanity check, run once at module load. The expiry pass below writes
// approved→expired via a raw set-based UPDATE (not transitionAction, which is
// per-row/optimistic) because expiry must be atomic across every stale row at
// once — so it can't lean on transitionAction's own assertTransition call for
// protection. This throws at import time (loudly, at boot) if state.ts ever
// drops the edge, instead of failing silently inside a background sweep.
assertTransition("approved", "expired");

export const CC_APPROVAL_TTL_HOURS = 72;
export const VERIFY_AFTER_HOURS = 4;
export const VERIFY_BATCH_LIMIT = 10;
export const VERIFIABLE_ACTION_TYPES: ReadonlySet<string> = new Set(["budget_update", "pause", "enable"]);

/** In-process throttle: skip redundant reads on rapid navigation across tabs/pages. */
const SWEEP_THROTTLE_MS = 10 * 60 * 1000;

export interface SweepResult {
  expired: number;
  verified: number;
  drifted: number;
  /** Candidate rows examined this pass (bounded by VERIFY_BATCH_LIMIT); includes
   * rows skipped for missing read capability or a transient read error. */
  checked: number;
}

const ZERO_RESULT: SweepResult = { expired: 0, verified: 0, drifted: 0, checked: 0 };

export interface VerifyRepo {
  expireStaleApproved(workspaceIds: string[], olderThanHours: number): Promise<number>;
  listVerifiableExecuted(workspaceIds: string[], afterHours: number, limit: number): Promise<CcActionRow[]>;
  recordVerificationDrift(id: string, note: string): Promise<void>;
  transitionAction(row: CcActionRow, to: CcActionStatus, patch?: Record<string, unknown>): Promise<void>;
}

export interface VerifyDeps {
  repo: VerifyRepo;
  adapters: { for(network: CcNetwork): NetworkAdapter };
  auth: { resolve(action: CcActionRow): Promise<AdapterAuth> };
}

/**
 * Real deps: resolves auth/adapters the SAME way every /api/command/* route
 * does (buildExecutorDeps), so the sweep can never drift onto a different
 * auth path than execute/approve. The repo surface wraps the three new
 * actions-repo functions plus the existing transitionAction (already
 * optimistic/guarded — see actions-repo.ts).
 */
function buildVerifyDeps(access: CommandAccess): VerifyDeps {
  const executorDeps = buildExecutorDeps(access.accessToken);
  return {
    repo: {
      expireStaleApproved: repo.expireStaleApproved,
      listVerifiableExecuted: repo.listVerifiableExecuted,
      recordVerificationDrift: repo.recordVerificationDrift,
      transitionAction: (row, to, patch) => repo.transitionAction(row, to, patch),
    },
    adapters: executorDeps.adapters,
    auth: executorDeps.auth,
  };
}

interface VerificationCheck {
  checkedField: "dailyBudgetMicros" | "status";
  expected: unknown;
  actual: unknown;
  verified: boolean;
  note?: string;
}

/** Shared by verifyOutcome (pure, exported) and runSweep (needs the extra
 * checkedField/expected/actual to build the evidence stamp) so the compare
 * logic lives in exactly one place. */
function computeCheck(action: CcActionRow, after: EntitySnapshot): VerificationCheck {
  if (action.actionType === "budget_update") {
    const payload = action.payload as BudgetUpdatePayload;
    // Meta writes budgets via microsToCents (see networks/meta.ts); comparing
    // raw micros would false-drift every non-cent-round Meta budget. Mirror
    // that rounding here via the ONE shared helper.
    const expected = action.network === "meta_ads"
      ? metaBudgetRoundMicros(payload.newDailyBudgetMicros)
      : payload.newDailyBudgetMicros;
    const actual = after.dailyBudgetMicros ?? null;
    const verified = actual === expected;
    return {
      checkedField: "dailyBudgetMicros", expected, actual, verified,
      note: verified ? undefined : `Deriva de presupuesto: esperado ${expected} micros, actual ${actual ?? "desconocido"} micros`,
    };
  }
  // pause | enable — the only other VERIFIABLE_ACTION_TYPES members.
  const expectedStatus = action.actionType === "pause" ? "PAUSED" : "ENABLED";
  const actual = after.status ?? null;
  const verified = actual === expectedStatus;
  return {
    checkedField: "status", expected: expectedStatus, actual, verified,
    note: verified ? undefined : `Deriva de estado: esperado ${expectedStatus}, actual ${actual ?? "desconocido"}`,
  };
}

/**
 * PURE, unit-testable: does `after` (a fresh adapter.snapshot()) match what
 * `action` was supposed to have written? budget_update compares payload
 * micros for Google / metaBudgetRoundMicros(payload) for Meta; pause/enable
 * compare after.status. Never touches the network or the DB.
 */
export function verifyOutcome(action: CcActionRow, after: EntitySnapshot): { verified: boolean; note?: string } {
  const { verified, note } = computeCheck(action, after);
  return note === undefined ? { verified } : { verified, note };
}

let sweepInFlight: Promise<SweepResult> | null = null;
const lastSweepAt = new Map<string, number>();

function throttleKey(workspaceIds: string[]): string {
  return [...workspaceIds].sort().join(",");
}

/**
 * Lazy sweep, fired fire-and-forget from the /command clients on mount (plus
 * a manual "Verificar ahora" button) — NOT an external cron. (1) Expiry pass
 * first: one atomic set-based UPDATE, approved→expired, older than
 * CC_APPROVAL_TTL_HOURS. (2) Verification pass: up to VERIFY_BATCH_LIMIT
 * 'executed' rows older than VERIFY_AFTER_HOURS get ONE read-only
 * adapter.snapshot() each; verified rows transition executed→verified with a
 * verification stamp merged into evidence; drifted rows get a Spanish note
 * written to cc_actions.error (recordVerificationDrift); read errors and
 * missing read-capability rows are skipped untouched, retried next sweep.
 *
 * Never mutates the ad networks: no executeAction, no adapter.execute call
 * anywhere in this module.
 *
 * Double-run guard: a module-scope in-flight promise dedupes concurrent
 * callers (e.g. two open tabs) down to one execution, and a per-workspace-set
 * throttle (~10 min) turns a call shortly after a completed sweep into a
 * free zero-result — no repo/network calls at all.
 */
export async function runSweep(
  access: CommandAccess, deps: VerifyDeps = buildVerifyDeps(access)
): Promise<SweepResult> {
  if (sweepInFlight) return sweepInFlight;

  const key = throttleKey(access.workspaceIds);
  const last = lastSweepAt.get(key);
  if (last !== undefined && Date.now() - last < SWEEP_THROTTLE_MS) {
    return ZERO_RESULT;
  }

  sweepInFlight = (async () => {
    try {
      const expired = await deps.repo.expireStaleApproved(access.workspaceIds, CC_APPROVAL_TTL_HOURS);

      const candidates = await deps.repo.listVerifiableExecuted(
        access.workspaceIds, VERIFY_AFTER_HOURS, VERIFY_BATCH_LIMIT
      );

      let verified = 0;
      let drifted = 0;
      for (const row of candidates) {
        const auth = await deps.auth.resolve(row);
        const adapter = deps.adapters.for(row.network as CcNetwork);
        // Meta sin credenciales (or any adapter without read access): skip
        // WITHOUT stamping, so it auto-verifies the moment creds land.
        if (!adapter.capabilities(auth).read) continue;

        let after: EntitySnapshot;
        try {
          after = await adapter.snapshot(auth, row.accountRef, row.entityKind as CcEntityKind, row.entityRef);
        } catch {
          // Fail closed: never claim verified/drift without a successful
          // read. Row stays 'executed' with error still null — retried the
          // very next sweep, exactly as if it hadn't been picked up.
          continue;
        }

        const check = computeCheck(row, after);
        if (check.verified) {
          const priorEvidence = (row.evidence ?? {}) as Record<string, unknown>;
          await deps.repo.transitionAction(row, "verified", {
            evidence: {
              ...priorEvidence,
              verification: {
                checkedAt: new Date().toISOString(),
                checkedField: check.checkedField,
                expected: check.expected,
                actual: check.actual,
              },
            },
          });
          verified++;
        } else {
          await deps.repo.recordVerificationDrift(row.id, check.note ?? "Deriva detectada");
          drifted++;
        }
      }

      lastSweepAt.set(key, Date.now());
      return { expired, verified, drifted, checked: candidates.length };
    } finally {
      sweepInFlight = null;
    }
  })();

  return sweepInFlight;
}
