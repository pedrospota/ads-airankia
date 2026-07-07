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
import { and, eq, inArray } from "drizzle-orm";
import { adsDb } from "@/lib/ads-db";
import { ccActions, ccBlueprints } from "@/lib/schema";
import { createAction, listActionsByBlueprint, type CcActionRow } from "../actions-repo";
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
  deleteProposedActionsByBlueprint(blueprintId: string): Promise<void>;
  insertAction(values: typeof ccActions.$inferInsert): Promise<CcActionRow>;
  approveProposedActions(blueprintId: string, approver: string, now: Date): Promise<CcActionRow[]>;
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
  async deleteProposedActionsByBlueprint(blueprintId) {
    await adsDb.delete(ccActions)
      .where(and(eq(ccActions.blueprintId, blueprintId), eq(ccActions.status, "proposed")));
  },
  insertAction: (values) => createAction(values),
  async approveProposedActions(blueprintId, approver, now) {
    return adsDb.update(ccActions)
      .set({ status: "approved", approvedBy: approver, approvedAt: now, updatedAt: now })
      .where(and(eq(ccActions.blueprintId, blueprintId), eq(ccActions.status, "proposed")))
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

  const existing = await deps.listActionsByBlueprint(blueprintId);
  if (existing.some((a) => a.status !== "proposed")) {
    throw new Error("El blueprint ya tiene acciones más allá de 'proposed'; no se puede recompilar.");
  }
  if (existing.length > 0) {
    await deps.deleteProposedActionsByBlueprint(blueprintId);
  }

  const doc = parseBlueprint(blueprint.doc);
  const compiled = compile(doc, blueprintId);

  // AI-accepted node paths live as an optional `_ai: string[]` sibling of `network`/
  // `campaign` on the RAW doc — parseBlueprint's zod schema doesn't declare it, so it's
  // stripped from the parsed result. Read it off the raw jsonb value instead. Matched
  // against CompiledAction.localRef (the only per-node identifier compile() exposes).
  const rawAi = (blueprint.doc as { _ai?: unknown } | null)?._ai;
  const aiPaths = new Set(Array.isArray(rawAi) ? rawAi.filter((p): p is string => typeof p === "string") : []);

  const inserted: CcActionRow[] = [];
  for (const action of compiled) {
    const row = await deps.insertAction({
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
    });
    inserted.push(row);
  }
  return inserted;
}

/** Bulk-transitions this blueprint's 'proposed' actions → 'approved' (stamping approvedBy/
 * approvedAt), and the blueprint itself → 'approved'. Workspace-scoped. Returns null if the
 * blueprint isn't found in scope. Idempotent: a second call simply approves zero further
 * actions (none left in 'proposed') and re-sets the already-'approved' blueprint status. */
export async function approveBlueprint(
  id: string, approver: string, workspaceIds: string[], deps: BlueprintRepoDeps = realDeps
): Promise<CcBlueprintRow | null> {
  const blueprint = await deps.selectBlueprint(id, workspaceIds);
  if (!blueprint) return null;
  await deps.approveProposedActions(id, approver, new Date());
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
