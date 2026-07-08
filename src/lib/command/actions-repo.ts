import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { adsDb } from "@/lib/ads-db";
import { ccActions, ccBlueprints, ccExecutions } from "@/lib/schema";
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
      inArray(ccActions.actionType, ["budget_update", "pause", "enable", "update_cpc"]),
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

// ---------------------------------------------------------------------------
// v2.6 Novedades inbox (design spec §c "Notification channel" + "Surface").
// A PURE QUERY over cc_actions/cc_blueprints — no new table, no migration,
// no read/unread state. Every category below is an existing, already-durable
// status (or status+predicate) that clears itself the moment the underlying
// row is resolved (re-approve/reject/revert/re-verify).
// ---------------------------------------------------------------------------

const NOVEDADES_WINDOW_DAYS = 7;
/** Per-category item cap. Cheap (single indexed query each) and keeps the
 * numeric counts themselves bounded — at beta's single-operator scale a
 * category pinned at this cap just reads as "50+", which is an acceptable
 * fidelity loss for a needs-attention badge (see design spec top-risks: "the
 * approved-row JS filter is bounded but watch p95 as cc_actions grows"). */
export const NOVEDADES_ITEM_LIMIT = 50;
/** The gate-blocked category has no dedicated status column to filter on
 * (it's 'approved' + a gateResults predicate), so it scans a wider bounded
 * window before the JS filter narrows it down to NOVEDADES_ITEM_LIMIT. */
export const NOVEDADES_APPROVED_SCAN_LIMIT = 200;

export interface NovedadItemRef {
  id: string;
  /** v3.0: notify.ts keys cc_notifications dedup rows on (workspace, kind, id). */
  workspaceId: string;
}

export interface NovedadesCounts {
  planesFallidos: number;
  accionesFallidas: number;
  conDeriva: number;
  bloqueadas: number;
  caducadas: number;
}

export interface NovedadesResult {
  counts: NovedadesCounts;
  total: number;
  /** Minimal id-only refs (already fetched alongside the counts — no extra
   * query), capped at NOVEDADES_ITEM_LIMIT. Used by the resumen page to build
   * a precise deep link for the single-failed-blueprint case. */
  items: {
    planesFallidos: NovedadItemRef[];
    accionesFallidas: NovedadItemRef[];
    conDeriva: NovedadItemRef[];
    bloqueadas: NovedadItemRef[];
    caducadas: NovedadItemRef[];
  };
}

/**
 * PURE, unit-testable: does this `gate_results` jsonb value contain at least
 * one element shaped like a BLOCKING gate FAILURE ({severity:'blocking',
 * status:'fail'} — see GateResult in types.ts / executor.ts's
 * approved→approved self-loop stamp on block)?
 *
 * Extracted as its own exported function (rather than inlined into
 * listNovedades) specifically so a gates.ts shape change (id/severity/status/
 * evidence) fails a fast, direct unit test instead of silently emptying the
 * "bloqueadas por compuertas" Novedades category — see
 * actions-repo.test.ts, which exercises this against gates.ts's REAL
 * runGates() output, not a hand-rolled fixture.
 */
export function hasBlockingGateFailure(gateResults: unknown): boolean {
  if (!Array.isArray(gateResults)) return false;
  return gateResults.some((g) => {
    if (!g || typeof g !== "object") return false;
    const r = g as Record<string, unknown>;
    return r.severity === "blocking" && r.status === "fail";
  });
}

/**
 * The Novedades inbox: five state-based "needs attention" counts, workspace-
 * scoped, windowed to the last NOVEDADES_WINDOW_DAYS by `updated_at`. Every
 * source is an indexed status query (idx_cc_actions_status) except
 * "bloqueadas", which fetches the bounded 'approved' set and JS-filters via
 * hasBlockingGateFailure (no gateResults index exists, nor is one needed at
 * this scan bound).
 *
 * Deliberately a query, not a subscription: re-running it after a row
 * resolves (re-approve, reject, rollback, re-verify) naturally reflects the
 * new state — there is no separate "dismiss" or read/unread concept to keep
 * in sync (design spec §c).
 */
export async function listNovedades(workspaceIds: string[]): Promise<NovedadesResult> {
  const cutoff = new Date(Date.now() - NOVEDADES_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [failedBlueprints, failedActions, driftedActions, expiredActions, approvedCandidates] = await Promise.all([
    // (a) Plan falló mid-execution → cc_blueprints.status='failed'.
    adsDb.select({ id: ccBlueprints.id, workspaceId: ccBlueprints.workspaceId }).from(ccBlueprints)
      .where(and(
        inArray(ccBlueprints.workspaceId, workspaceIds),
        eq(ccBlueprints.status, "failed"),
        gte(ccBlueprints.updatedAt, cutoff),
      ))
      .orderBy(desc(ccBlueprints.updatedAt))
      .limit(NOVEDADES_ITEM_LIMIT),
    // (b) Acción falló → cc_actions.status='failed'.
    adsDb.select({ id: ccActions.id, workspaceId: ccActions.workspaceId }).from(ccActions)
      .where(and(
        inArray(ccActions.workspaceId, workspaceIds),
        eq(ccActions.status, "failed"),
        gte(ccActions.updatedAt, cutoff),
      ))
      .orderBy(desc(ccActions.updatedAt))
      .limit(NOVEDADES_ITEM_LIMIT),
    // (c) Deriva → status='executed' AND error IS NOT NULL. Mirrors
    // listVerifiableExecuted's `error IS NULL` predicate, inverted: this is
    // exactly the set that predicate excludes — recordVerificationDrift is
    // the sole writer of `error` on an 'executed' row (see its header
    // comment), so error≠null here unambiguously means drift.
    adsDb.select({ id: ccActions.id, workspaceId: ccActions.workspaceId }).from(ccActions)
      .where(and(
        inArray(ccActions.workspaceId, workspaceIds),
        eq(ccActions.status, "executed"),
        isNotNull(ccActions.error),
        gte(ccActions.updatedAt, cutoff),
      ))
      .orderBy(desc(ccActions.updatedAt))
      .limit(NOVEDADES_ITEM_LIMIT),
    // (e) Caducada → cc_actions.status='expired'.
    adsDb.select({ id: ccActions.id, workspaceId: ccActions.workspaceId }).from(ccActions)
      .where(and(
        inArray(ccActions.workspaceId, workspaceIds),
        eq(ccActions.status, "expired"),
        gte(ccActions.updatedAt, cutoff),
      ))
      .orderBy(desc(ccActions.updatedAt))
      .limit(NOVEDADES_ITEM_LIMIT),
    // (d) Bloqueada por compuertas en execute → status='approved' AND
    // gate_results contains a blocking fail (JS-filtered below via
    // hasBlockingGateFailure over this bounded scan).
    adsDb.select({ id: ccActions.id, workspaceId: ccActions.workspaceId, gateResults: ccActions.gateResults }).from(ccActions)
      .where(and(
        inArray(ccActions.workspaceId, workspaceIds),
        eq(ccActions.status, "approved"),
        gte(ccActions.updatedAt, cutoff),
      ))
      .orderBy(desc(ccActions.updatedAt))
      .limit(NOVEDADES_APPROVED_SCAN_LIMIT),
  ]);

  const blockedActions = approvedCandidates
    .filter((a) => hasBlockingGateFailure(a.gateResults))
    .slice(0, NOVEDADES_ITEM_LIMIT)
    .map((a) => ({ id: a.id, workspaceId: a.workspaceId }));

  const counts: NovedadesCounts = {
    planesFallidos: failedBlueprints.length,
    accionesFallidas: failedActions.length,
    conDeriva: driftedActions.length,
    bloqueadas: blockedActions.length,
    caducadas: expiredActions.length,
  };

  return {
    counts,
    total:
      counts.planesFallidos + counts.accionesFallidas + counts.conDeriva +
      counts.bloqueadas + counts.caducadas,
    items: {
      planesFallidos: failedBlueprints,
      accionesFallidas: failedActions,
      conDeriva: driftedActions,
      bloqueadas: blockedActions,
      caducadas: expiredActions,
    },
  };
}
