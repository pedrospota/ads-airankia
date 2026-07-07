import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { adsDb } from "@/lib/ads-db";
import { ccActions, ccExecutions } from "@/lib/schema";
import { assertTransition } from "./state";
import type { CcActionStatus, CcNetwork } from "./types";

export type CcActionRow = typeof ccActions.$inferSelect;
export type CcExecutionRow = typeof ccExecutions.$inferSelect;

export async function createAction(values: typeof ccActions.$inferInsert): Promise<CcActionRow> {
  const rows = await adsDb.insert(ccActions).values(values).returning();
  return rows[0];
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
