import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { adsDb } from "@/lib/ads-db";
import { ccActions, ccExecutions } from "@/lib/schema";
import { assertTransition } from "./state";
import type { CcActionStatus, CcNetwork, CcPayload } from "./types";

export type CcActionRow = typeof ccActions.$inferSelect;
export type CcExecutionRow = typeof ccExecutions.$inferSelect;

export async function createAction(values: typeof ccActions.$inferInsert): Promise<CcActionRow> {
  const rows = await adsDb.insert(ccActions).values(values).returning();
  return rows[0];
}

/** Batch insert: all rows in a single INSERT statement, so a compiled action set is
 * written all-or-nothing (no partial set if a later row fails validation mid-loop). */
export async function createActions(values: Array<typeof ccActions.$inferInsert>): Promise<CcActionRow[]> {
  if (values.length === 0) return [];
  return adsDb.insert(ccActions).values(values).returning();
}

/** Insert skipping duplicates on (workspace, network, rec_key). Returns row or null if duped. */
export async function createActionDeduped(values: typeof ccActions.$inferInsert): Promise<CcActionRow | null> {
  const rows = await adsDb.insert(ccActions).values(values)
    // The backing unique index is partial (WHERE rec_key IS NOT NULL), so ON CONFLICT
    // must carry the matching predicate or Postgres throws 42P10 at runtime.
    .onConflictDoNothing({
      target: [ccActions.workspaceId, ccActions.network, ccActions.recKey],
      where: sql`${ccActions.recKey} is not null`,
    })
    .returning();
  return rows[0] ?? null;
}

export async function getAction(id: string, workspaceIds: string[]): Promise<CcActionRow | null> {
  const rows = await adsDb.select().from(ccActions)
    .where(and(eq(ccActions.id, id), inArray(ccActions.workspaceId, workspaceIds))).limit(1);
  return rows[0] ?? null;
}

export async function listActions(workspaceIds: string[], opts: { status?: CcActionStatus; network?: CcNetwork; limit?: number } = {}): Promise<CcActionRow[]> {
  const conditions = [inArray(ccActions.workspaceId, workspaceIds)];
  if (opts.status) conditions.push(eq(ccActions.status, opts.status));
  if (opts.network) conditions.push(eq(ccActions.network, opts.network));
  return adsDb.select().from(ccActions).where(and(...conditions))
    .orderBy(desc(ccActions.createdAt)).limit(opts.limit ?? 100);
}

/** Blueprint plan runner: this blueprint's actions, ordered by seq. */
export async function listActionsByBlueprint(blueprintId: string): Promise<CcActionRow[]> {
  return adsDb.select().from(ccActions)
    .where(eq(ccActions.blueprintId, blueprintId))
    .orderBy(ccActions.seq);
}

/**
 * Persist a resolved payload for a blueprint action, optionally stamping result_ref.
 * Without `resultRef`: guarded by the optimistic status check (only while the row is
 * still 'approved') — the plan runner uses this before calling executeAction. With
 * `resultRef`: unconditional on id — the plan runner uses this right after executeAction
 * has succeeded and already moved the row past 'approved'.
 */
export async function updateActionResolved(
  id: string, payload: CcPayload, resultRef?: string
): Promise<void> {
  const patch: Partial<typeof ccActions.$inferInsert> = { payload, updatedAt: new Date() };
  if (resultRef === undefined) {
    await adsDb.update(ccActions).set(patch)
      .where(and(eq(ccActions.id, id), eq(ccActions.status, "approved")));
    return;
  }
  patch.resultRef = resultRef;
  await adsDb.update(ccActions).set(patch).where(eq(ccActions.id, id));
}

export async function transitionAction(
  row: CcActionRow, to: CcActionStatus,
  patch: Partial<typeof ccActions.$inferInsert> = {}
): Promise<void> {
  assertTransition(row.status as CcActionStatus, to);
  await adsDb.update(ccActions)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(ccActions.id, row.id), eq(ccActions.status, row.status))); // optimistic guard
}

export async function countExecutedToday(accountRef: string): Promise<number> {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const rows = await adsDb.select({ n: sql<number>`count(*)::int` }).from(ccExecutions)
    .where(and(
      eq(ccExecutions.accountRef, accountRef),
      eq(ccExecutions.status, "done"),
      eq(ccExecutions.validateOnly, false),
      gte(ccExecutions.createdAt, start),
    ));
  return rows[0]?.n ?? 0;
}

export async function insertExecution(values: typeof ccExecutions.$inferInsert): Promise<CcExecutionRow> {
  const rows = await adsDb.insert(ccExecutions).values(values).returning();
  return rows[0];
}

export async function updateExecution(id: string, patch: Partial<typeof ccExecutions.$inferInsert>): Promise<void> {
  await adsDb.update(ccExecutions).set({ ...patch, updatedAt: new Date() }).where(eq(ccExecutions.id, id));
}

export async function latestDoneExecution(actionId: string): Promise<CcExecutionRow | null> {
  const rows = await adsDb.select().from(ccExecutions)
    .where(and(eq(ccExecutions.actionId, actionId), eq(ccExecutions.status, "done"), eq(ccExecutions.validateOnly, false)))
    .orderBy(desc(ccExecutions.createdAt)).limit(1);
  return rows[0] ?? null;
}

export async function listExecutions(workspaceIds: string[], limit = 100): Promise<Array<{ execution: CcExecutionRow; action: CcActionRow }>> {
  const rows = await adsDb.select({ execution: ccExecutions, action: ccActions })
    .from(ccExecutions)
    .innerJoin(ccActions, eq(ccExecutions.actionId, ccActions.id))
    .where(inArray(ccActions.workspaceId, workspaceIds))
    .orderBy(desc(ccExecutions.createdAt)).limit(limit);
  return rows;
}

export async function countByStatus(workspaceIds: string[]): Promise<Record<string, number>> {
  const rows = await adsDb.select({ status: ccActions.status, n: sql<number>`count(*)::int` })
    .from(ccActions).where(inArray(ccActions.workspaceId, workspaceIds)).groupBy(ccActions.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// ---------------------------------------------------------------------------
// v2.6 lazy verification sweep (src/lib/command/verify.ts). Read-only against
// the ad networks: these three functions only ever touch cc_actions rows via
// atomic/guarded SQL — verify.ts never calls executeAction/adapter.execute.
// ---------------------------------------------------------------------------

/**
 * ONE atomic set-based UPDATE: every stale 'approved' row (in the given
 * workspaces, approved more than `olderThanHours` ago) expires in a single
 * statement — inherently race-free, no per-row optimistic guard needed.
 * The legality of approved→expired is sanity-checked once at import time by
 * verify.ts (`assertTransition("approved", "expired")`), not here, because
 * this write is a raw UPDATE rather than a transitionAction call.
 */
export async function expireStaleApproved(workspaceIds: string[], olderThanHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  const rows = await adsDb.update(ccActions)
    .set({
      status: "expired",
      error: "Aprobación caducada (>72h): vuelve a aprobar",
      updatedAt: new Date(),
    })
    .where(and(
      inArray(ccActions.workspaceId, workspaceIds),
      eq(ccActions.status, "approved"),
      lt(ccActions.approvedAt, cutoff),
    ))
    .returning({ id: ccActions.id });
  return rows.length;
}

/**
 * Candidate rows for the verification pass: workspace-scoped, executed more
 * than `afterHours` ago, no drift/failure text recorded yet (`error IS NULL`
 * — this predicate is what makes drift one-shot: recordVerificationDrift sets
 * error, so a drifted row drops out of this select on the next sweep), action
 * type in the verifiable set, oldest first, capped at `limit`.
 *
 * The verifiable-type literal here mirrors verify.ts's exported
 * `VERIFIABLE_ACTION_TYPES` constant (kept separate, not imported, to avoid a
 * repo↔verify circular import) — verify.test.ts pins the constant's contents
 * so the two can't silently drift apart.
 */
export async function listVerifiableExecuted(
  workspaceIds: string[], afterHours: number, limit: number
): Promise<CcActionRow[]> {
  const cutoff = new Date(Date.now() - afterHours * 60 * 60 * 1000);
  return adsDb.select().from(ccActions)
    .where(and(
      inArray(ccActions.workspaceId, workspaceIds),
      eq(ccActions.status, "executed"),
      lt(ccActions.executedAt, cutoff),
      isNull(ccActions.error),
      inArray(ccActions.actionType, ["budget_update", "pause", "enable"]),
    ))
    .orderBy(asc(ccActions.executedAt))
    .limit(limit);
}

/**
 * Guarded UPDATE — the SOLE writer of `error` on an 'executed' row. Scoping to
 * `status='executed'` (not just `id`) makes the write a no-op if the row moved
 * on (rolled back, etc.) between the sweep's select and this write, and keeps
 * `error` unambiguous: executeAction/rollbackAction always clear it to null on
 * success, so error≠null on an 'executed' row means, and can only mean, drift.
 */
export async function recordVerificationDrift(id: string, note: string): Promise<void> {
  await adsDb.update(ccActions)
    .set({ error: note, updatedAt: new Date() })
    .where(and(eq(ccActions.id, id), eq(ccActions.status, "executed")));
}
