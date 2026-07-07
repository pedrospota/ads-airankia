// Centro de Mando — plan runner. A sequential LOOP ABOVE the single per-action
// executor chokepoint (executor.ts: executeAction/rollbackAction). It NEVER bypasses
// that chokepoint and NEVER calls adapter.execute() directly.
//
// Flow: cc_blueprints.doc → compile() → ordered cc_actions (blueprint_id, seq, local_ref,
// payload with tmp:<localRef> placeholders) → "approve blueprint" (bulk proposed→approved,
// out of scope here) → executeBlueprint (this file) → v1 executeAction per action, in seq
// order, resolving tmp: refs from earlier siblings' result_ref as they become known →
// rollbackBlueprint reverses the sequence over v1 rollbackAction (children before parents).
import { executeAction, rollbackAction, type ExecutorDeps } from "../executor";
import type { CcActionRow } from "../actions-repo";
import type { CcPayload } from "../types";

export interface PlanRunnerRepo {
  listActionsByBlueprint(blueprintId: string): Promise<CcActionRow[]>;
  /**
   * Persist a resolved payload, optionally stamping result_ref.
   * - Called with no `resultRef` BEFORE executeAction: guarded by the optimistic
   *   status check (only applies while the row is still 'approved').
   * - Called WITH `resultRef` AFTER executeAction succeeds: the row has already
   *   legitimately moved past 'approved' (executeAction drove it to 'executed'), so
   *   this stamp is unconditional on id.
   */
  updateActionResolved(id: string, payload: CcPayload, resultRef?: string): Promise<void>;
}

export interface PlanOutcome {
  ok: boolean;
  failedSeq?: number;
  error?: string;
}

const TMP_REF = /^tmp:(.+)$/;

/**
 * Deep-walk `payload`, building a NEW structure where every string value matching
 * `^tmp:(.+)$` is replaced by its resolved resourceName from `refMap` (keyed by the
 * localRef — everything after "tmp:"). Every other value (strings, numbers, booleans,
 * null, nested objects/arrays) passes through unchanged.
 *
 * THE SACRED INVARIANT (spec §2): this function may ONLY substitute tmp: placeholder
 * strings. It must never coerce, reorder, or drop any other field, and it must throw
 * if a tmp: ref has no entry in refMap (fail closed on an unresolved reference rather
 * than silently shipping the literal placeholder string to a live network call).
 */
export function resolvePayload<T>(payload: T, refMap: Record<string, string>): T {
  return walk(payload, refMap) as T;
}

function walk(value: unknown, refMap: Record<string, string>): unknown {
  if (typeof value === "string") {
    const m = TMP_REF.exec(value);
    if (!m) return value;
    const localRef = m[1];
    const resolved = refMap[localRef];
    if (resolved === undefined) {
      throw new Error(`Ref temporal sin resolver: tmp:${localRef}`);
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, refMap));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, refMap);
    }
    return out;
  }
  return value;
}

function requireSeq(action: CcActionRow): number {
  if (action.seq === null || action.seq === undefined) {
    throw new Error(`Acción de blueprint sin seq: ${action.id}`);
  }
  return action.seq;
}

export async function executeBlueprint(
  blueprintId: string,
  actor: string,
  workspaceIds: string[],
  deps: ExecutorDeps,
  repo2: PlanRunnerRepo
): Promise<PlanOutcome> {
  const compiled = await repo2.listActionsByBlueprint(blueprintId);
  if (compiled.length === 0) return { ok: true };

  // Blast-radius pre-check: refuse the WHOLE plan up front if executing every action in
  // it (blueprint size, not just the remaining/unexecuted ones — a deliberately
  // conservative reading of "compiled-plan size" per the design doc) would push this
  // account's daily action count over the cap. Nothing executes if this fails.
  const accountRef = compiled[0].accountRef;
  const workspaceId = compiled[0].workspaceId;
  const settings = await deps.settings.get(workspaceId);
  const executedToday = await deps.repo.countExecutedToday(accountRef);
  if (compiled.length + executedToday > settings.maxActionsPerAccountDay) {
    return { ok: false, failedSeq: -1, error: "plan excede el cupo diario" };
  }

  const ordered = [...compiled].sort((a, b) => requireSeq(a) - requireSeq(b));
  const refMap: Record<string, string> = {};

  for (const action of ordered) {
    const seq = requireSeq(action);

    // Resume: an action already executed in a prior (partial) run is not re-executed —
    // seed the refMap from its stored result_ref so later actions can still resolve
    // tmp: refs pointing at it.
    if (action.status === "executed") {
      if (action.localRef && action.resultRef) refMap[action.localRef] = action.resultRef;
      continue;
    }

    const resolved = resolvePayload(action.payload as CcPayload, refMap);
    // Persist the resolved payload BEFORE calling executeAction, guarded by the
    // optimistic status check (only while still 'approved').
    await repo2.updateActionResolved(action.id, resolved);

    const outcome = await executeAction(action.id, actor, workspaceIds, deps);
    if (!outcome.ok) {
      return { ok: false, failedSeq: seq, error: outcome.error };
    }

    const result = outcome.resourceNames?.[0];
    if (result !== undefined) {
      // Stamp result_ref now that the action has legitimately moved past 'approved'.
      await repo2.updateActionResolved(action.id, resolved, result);
      if (action.localRef) refMap[action.localRef] = result;
    }
  }

  return { ok: true };
}

export async function rollbackBlueprint(
  blueprintId: string,
  actor: string,
  workspaceIds: string[],
  deps: ExecutorDeps,
  repo2: PlanRunnerRepo
): Promise<PlanOutcome> {
  const actions = await repo2.listActionsByBlueprint(blueprintId);
  const executed = actions.filter((a) => a.status === "executed" || a.status === "verified");
  const reversed = [...executed].sort((a, b) => requireSeq(b) - requireSeq(a));

  let firstFailure: { seq: number; error?: string } | undefined;
  for (const action of reversed) {
    const outcome = await rollbackAction(action.id, actor, workspaceIds, deps);
    if (!outcome.ok && !firstFailure) {
      firstFailure = { seq: requireSeq(action), error: outcome.error };
    }
  }

  if (firstFailure) return { ok: false, failedSeq: firstFailure.seq, error: firstFailure.error };
  return { ok: true };
}
