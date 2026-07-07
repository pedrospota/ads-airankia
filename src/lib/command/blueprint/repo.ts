// Centro de Mando — Blueprint repo. Persists a draft campaign blueprint (cc_blueprints),
// compiles it into ordered cc_actions rows (blueprint_id/seq/local_ref, status 'proposed'),
// and bulk-approves them. Owns cc_blueprints.status transitions (draft → approved →
// executing → executed | failed) — the plan runner (blueprint/plan-runner.ts) deliberately
// stays out of that (see its header comment + progress.md Task 9 carry-note); the
// execute/rollback API (Task 11) is expected to call setBlueprintStatus around
// executeBlueprint/rollbackBlueprint.
//
// Workspace scoping: every read/mutate that targets an existing row filters
// workspaceId against the caller's workspaceIds, mirroring actions-repo.ts/settings.ts
// (e.g. `inArray(ccBlueprints.workspaceId, workspaceIds)`).
import { and, desc, eq, inArray } from "drizzle-orm";
import { adsDb } from "@/lib/ads-db";
import { ccActions, ccBlueprints } from "@/lib/schema";
import { createActions, listActionsByBlueprint, type CcActionRow } from "../actions-repo";
import { diffEditDoc } from "../edit/diff";
import { EDIT_BASELINE_MAX_AGE_MS, parseEditDoc } from "../edit/schema";
import { compile } from "./compile";
import { parseBlueprint } from "./schema";

export type CcBlueprintRow = typeof ccBlueprints.$inferSelect;
export type NewBlueprintInput = typeof ccBlueprints.$inferInsert;
export type CcBlueprintStatus = "draft" | "approved" | "executing" | "executed" | "failed";

/**
 * Injectable persistence surface, mirroring ExecutorRepo/PlanRunnerRepo (executor.ts,
 * blueprint/plan-runner.ts). Every exported function below takes an optional trailing
 * `deps` argument defaulting to the real adsDb-backed implementation, so unit tests can
 * swap in an in-memory fake without changing the public call signatures the API routes
 * (Task 11) use.
 */
export interface BlueprintRepoDeps {
  insertBlueprint(values: NewBlueprintInput): Promise<CcBlueprintRow>;
  selectBlueprint(id: string, workspaceIds: string[]): Promise<CcBlueprintRow | null>;
  updateBlueprintDoc(id: string, doc: unknown, workspaceIds: string[]): Promise<CcBlueprintRow | null>;
  updateBlueprintStatus(
    id: string, status: CcBlueprintStatus, workspaceIds: string[], error: string | null
  ): Promise<CcBlueprintRow | null>;
  listActionsByBlueprint(blueprintId: string): Promise<CcActionRow[]>;
  /** `workspaceId` is a belt-and-braces filter alongside blueprintId — the caller always
   * passes the already workspace-scoped blueprint's own workspaceId. */
  deleteProposedActionsByBlueprint(blueprintId: string, workspaceId: string): Promise<void>;
  /** Batch insert: ALL compiled rows in one call, so the write is all-or-nothing. */
  insertActions(values: Array<typeof ccActions.$inferInsert>): Promise<CcActionRow[]>;
  /** `workspaceId` is a belt-and-braces filter alongside blueprintId — the caller always
   * passes the already workspace-scoped blueprint's own workspaceId. */
  approveProposedActions(blueprintId: string, workspaceId: string, approver: string, now: Date): Promise<CcActionRow[]>;
}

const realDeps: BlueprintRepoDeps = {
  async insertBlueprint(values) {
    const rows = await adsDb.insert(ccBlueprints).values(values).returning();
    return rows[0];
  },
  async selectBlueprint(id, workspaceIds) {
    const rows = await adsDb.select().from(ccBlueprints)
      .where(and(eq(ccBlueprints.id, id), inArray(ccBlueprints.workspaceId, workspaceIds)))
      .limit(1);
    return rows[0] ?? null;
  },
  async updateBlueprintDoc(id, doc, workspaceIds) {
    const rows = await adsDb.update(ccBlueprints)
      .set({ doc, updatedAt: new Date() })
      .where(and(
        eq(ccBlueprints.id, id),
        inArray(ccBlueprints.workspaceId, workspaceIds),
        eq(ccBlueprints.status, "draft"),
      ))
      .returning();
    return rows[0] ?? null;
  },
  async updateBlueprintStatus(id, status, workspaceIds, error) {
    const rows = await adsDb.update(ccBlueprints)
      .set({ status, error, updatedAt: new Date() })
      .where(and(eq(ccBlueprints.id, id), inArray(ccBlueprints.workspaceId, workspaceIds)))
      .returning();
    return rows[0] ?? null;
  },
  listActionsByBlueprint,
  async deleteProposedActionsByBlueprint(blueprintId, workspaceId) {
    await adsDb.delete(ccActions)
      .where(and(
        eq(ccActions.blueprintId, blueprintId),
        eq(ccActions.status, "proposed"),
        eq(ccActions.workspaceId, workspaceId),
      ));
  },
  insertActions: (values) => createActions(values),
  async approveProposedActions(blueprintId, workspaceId, approver, now) {
    return adsDb.update(ccActions)
      .set({ status: "approved", approvedBy: approver, approvedAt: now, updatedAt: now })
      .where(and(
        eq(ccActions.blueprintId, blueprintId),
        eq(ccActions.status, "proposed"),
        eq(ccActions.workspaceId, workspaceId),
      ))
      .returning();
  },
};

export async function createBlueprint(
  values: NewBlueprintInput, deps: BlueprintRepoDeps = realDeps
): Promise<CcBlueprintRow> {
  return deps.insertBlueprint(values);
}

export async function getBlueprint(
  id: string, workspaceIds: string[], deps: BlueprintRepoDeps = realDeps
): Promise<CcBlueprintRow | null> {
  return deps.selectBlueprint(id, workspaceIds);
}

/** Lists this workspace's blueprints, most recent first. A plain scoped read (like
 * `listActions`/`listActionsByBlueprint` in actions-repo.ts) — deliberately NOT part of the
 * injectable `BlueprintRepoDeps` surface above, so adding it doesn't touch the interface
 * blueprint-repo.test.ts's in-memory fake implements. Used by the Task 11 GET list route. */
export async function listBlueprints(workspaceIds: string[], limit = 100): Promise<CcBlueprintRow[]> {
  return adsDb.select().from(ccBlueprints)
    .where(inArray(ccBlueprints.workspaceId, workspaceIds))
    .orderBy(desc(ccBlueprints.createdAt))
    .limit(limit);
}

/** Updates `doc` (+ updatedAt), workspace-scoped, only while status is 'draft'. Returns
 * null (no-op) if the blueprint isn't found in scope, or has already moved past 'draft'. */
export async function saveBlueprintDoc(
  id: string, doc: unknown, workspaceIds: string[], deps: BlueprintRepoDeps = realDeps
): Promise<CcBlueprintRow | null> {
  return deps.updateBlueprintDoc(id, doc, workspaceIds);
}

/**
 * DOUBLE-COMPILE GUARD (documented decision): if the blueprint's existing cc_actions rows
 * have moved past 'proposed' (approved/executing/executed/...), recompiling is refused —
 * those actions may already be approved or live, and silently deleting+replacing them
 * would strand or duplicate real network state. If every existing row is still 'proposed'
 * (an earlier compile that was never approved — a double-click, or an edit-then-recompile
 * while the blueprint is still 'draft'), it is safe to REPLACE: delete them and insert the
 * freshly compiled set. This is the only re-compile path reachable today, since
 * saveBlueprintDoc only mutates the doc while status==='draft' and compiling itself never
 * changes blueprint.status — so a second compile of a still-draft blueprint is the normal
 * "I edited the doc, recompile" flow, not a data-loss risk.
 */
export async function compileBlueprintToActions(
  blueprintId: string, workspaceIds: string[], deps: BlueprintRepoDeps = realDeps
): Promise<CcActionRow[]> {
  const blueprint = await deps.selectBlueprint(blueprintId, workspaceIds);
  if (!blueprint) throw new Error("Blueprint no encontrado.");

  // v2.3 EDIT-DOC BRANCH (Task 5): docs saved by the edit-tree flow (Task 1/4) carry
  // `docType: "google_search_edit_v1"` and compile through the differ (diffEditDoc), not the
  // v2 create compiler below. Keyed on the exact literal so a malformed/foreign doc falls
  // through to the create path's own parseBlueprint validation instead of silently matching.
  // The baseline (`loadedAt`) must be fresh — a stale tree may no longer reflect the live
  // account, so a re-load is required before compiling ("caducado" = "expired" in es-MX).
  // TTL is validated BEFORE the delete-first block: a doomed recompile must never wipe the
  // blueprint's existing proposed actions on its way to failing.
  const rawDoc = blueprint.doc as { docType?: unknown };
  const isEditDoc = rawDoc?.docType === "google_search_edit_v1";
  if (isEditDoc) {
    const ageMs = Date.now() - Date.parse((rawDoc as { loadedAt?: string }).loadedAt ?? "");
    if (!Number.isFinite(ageMs) || ageMs > EDIT_BASELINE_MAX_AGE_MS) {
      throw new Error("Baseline caducado; recarga el árbol de la campaña antes de compilar.");
    }
  }

  const existing = await deps.listActionsByBlueprint(blueprintId);
  if (existing.some((a) => a.status !== "proposed")) {
    throw new Error("El blueprint ya tiene acciones más allá de 'proposed'; no se puede recompilar.");
  }
  if (existing.length > 0) {
    await deps.deleteProposedActionsByBlueprint(blueprintId, blueprint.workspaceId);
  }

  if (isEditDoc) {
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

  const doc = parseBlueprint(blueprint.doc);
  const compiled = compile(doc, blueprintId);

  // AI-accepted node paths live as an optional `_ai: string[]` sibling of `network`/
  // `campaign` on the RAW doc — parseBlueprint's zod schema doesn't declare it, so it's
  // stripped from the parsed result. Read it off the raw jsonb value instead. Matched
  // against CompiledAction.localRef (the only per-node identifier compile() exposes).
  const rawAi = (blueprint.doc as { _ai?: unknown } | null)?._ai;
  const aiPaths = new Set(Array.isArray(rawAi) ? rawAi.filter((p): p is string => typeof p === "string") : []);

  // Build the full row set up front, then insert it in ONE batched statement (below) —
  // not one insert per loop iteration. That makes the write all-or-nothing: a failure
  // mid-compile can no longer leave a partial action set. Combined with delete-first
  // above, the worst case is now zero actions for this blueprint, which the
  // DOUBLE-COMPILE GUARD above self-heals on the next compile attempt.
  const rows: Array<typeof ccActions.$inferInsert> = compiled.map((action) => ({
    blueprintId,
    seq: action.seq,
    localRef: action.localRef,
    recKey: action.recKey,
    workspaceId: blueprint.workspaceId,
    createdBy: blueprint.createdBy,
    network: blueprint.network,
    accountRef: blueprint.accountRef,
    connectionId: blueprint.connectionId,
    entityKind: action.entityKind,
    entityRef: action.entityRef,
    actionType: action.actionType,
    payload: action.payload,
    status: "proposed",
    source: aiPaths.has(action.localRef) ? "copiloto" : "manual",
  }));
  return deps.insertActions(rows);
}

/** Bulk-transitions this blueprint's 'proposed' actions → 'approved' (stamping approvedBy/
 * approvedAt), and the blueprint itself → 'approved'. Workspace-scoped. Returns null if the
 * blueprint isn't found in scope. Idempotent: a second call simply approves zero further
 * actions (none left in 'proposed') and re-sets the already-'approved' blueprint status.
 *
 * Ordering is deliberate: the actions UPDATE runs FIRST and the blueprint status flip to
 * 'approved' runs LAST. If a failure lands between the two writes, the blueprint is left
 * recoverable — still not 'approved' — rather than 'approved' with unapproved actions. */
export async function approveBlueprint(
  id: string, approver: string, workspaceIds: string[], deps: BlueprintRepoDeps = realDeps
): Promise<CcBlueprintRow | null> {
  const blueprint = await deps.selectBlueprint(id, workspaceIds);
  if (!blueprint) return null;
  await deps.approveProposedActions(id, blueprint.workspaceId, approver, new Date());
  return deps.updateBlueprintStatus(id, "approved", workspaceIds, null);
}

/** Small workspace-scoped setter for the execute/rollback API (Task 11) to move the
 * blueprint through executing → executed | failed. Passing `error` stamps it; omitting it
 * clears any stale error from a prior attempt (e.g. a fresh 'executing' transition). */
export async function setBlueprintStatus(
  id: string, status: CcBlueprintStatus, workspaceIds: string[], error?: string, deps: BlueprintRepoDeps = realDeps
): Promise<CcBlueprintRow | null> {
  return deps.updateBlueprintStatus(id, status, workspaceIds, error ?? null);
}
