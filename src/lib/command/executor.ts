// Centro de Mando — THE SINGLE EXECUTION CHOKEPOINT.
// No other module may call adapter.execute(). All writes flow through
// executeAction/rollbackAction: gates → ledger(pending) → network call →
// ledger(done|failed) → action status. Deps are injectable for tests.
import { blockingFailures, runGates } from "./gates";
import { requestHash } from "./request-hash";
import type {
  AdapterAuth, CcActionInput, CcEntityKind, CcInternalActionType, CcNetwork,
  CcPayload, CcSettingsValues, EntitySnapshot, GateResult, NetworkAdapter, RollbackRecipe,
} from "./types";
import type { CcActionRow, CcExecutionRow } from "./actions-repo";

export interface ExecutorRepo {
  getAction(id: string, workspaceIds: string[]): Promise<CcActionRow | null>;
  transitionAction(row: CcActionRow, to: string, patch?: Record<string, unknown>): Promise<void>;
  insertExecution(values: Record<string, unknown>): Promise<CcExecutionRow>;
  updateExecution(id: string, patch: Record<string, unknown>): Promise<void>;
  countExecutedToday(accountRef: string): Promise<number>;
  latestDoneExecution(actionId: string): Promise<CcExecutionRow | null>;
  createAction(values: Record<string, unknown>): Promise<CcActionRow>;
}

export interface ExecutorDeps {
  repo: ExecutorRepo;
  adapters: { for(network: CcNetwork): NetworkAdapter };
  settings: { get(workspaceId: string): Promise<CcSettingsValues> };
  auth: { resolve(action: CcActionRow): Promise<AdapterAuth> };
  dryRun: boolean;
  now(): Date;
}

export interface ExecOutcome {
  ok: boolean;
  blocked?: GateResult[];
  dryRun?: boolean;
  error?: string;
  executionId?: string;
}

function toInput(row: CcActionRow, override?: CcActionInput): CcActionInput {
  if (override) return override;
  return {
    actionType: row.actionType as CcInternalActionType,
    entityKind: row.entityKind as CcEntityKind,
    entityRef: row.entityRef,
    payload: (row.payload ?? {}) as CcPayload,
  };
}

async function prepare(row: CcActionRow, input: CcActionInput, deps: ExecutorDeps) {
  const adapter = deps.adapters.for(row.network as CcNetwork);
  const auth = await deps.auth.resolve(row);
  const capabilities = adapter.capabilities(auth);
  const before = capabilities.read
    ? await adapter.snapshot(auth, row.accountRef, input.entityKind, input.entityRef)
    : ({ entityKind: input.entityKind, entityRef: input.entityRef, status: "UNKNOWN" } as EntitySnapshot);
  const settings = await deps.settings.get(row.workspaceId);
  const executedTodayForAccount = await deps.repo.countExecutedToday(row.accountRef);
  const validateResult =
    row.network === "google_ads" && adapter.validate && capabilities.write
      ? await adapter.validate(auth, row.accountRef, input, before)
      : null;
  const gates = runGates({
    settings,
    network: row.network as CcNetwork,
    action: input,
    capabilities,
    before,
    expected: (row.expected ?? null) as Partial<EntitySnapshot> | null,
    executedTodayForAccount,
    validateResult,
  });
  return { adapter, auth, before, gates, validateResult };
}

async function performWrite(opts: {
  row: CcActionRow; input: CcActionInput; adapter: NetworkAdapter; auth: AdapterAuth;
  before: EntitySnapshot; gates: GateResult[]; actor: string; deps: ExecutorDeps;
  recipe: RollbackRecipe | null;
}): Promise<{ ok: boolean; executionId?: string; error?: string }> {
  const { row, input, adapter, auth, before, gates, actor, deps, recipe } = opts;
  const hash = requestHash({ network: row.network, accountRef: row.accountRef, input });
  const ledger = await deps.repo.insertExecution({
    actionId: row.id, network: row.network, accountRef: row.accountRef,
    operation: `${input.actionType}:${input.entityKind}:${input.entityRef}`,
    requestHash: hash, validateOnly: false, before,
    rollbackRecipe: recipe, status: "pending", actor,
  });
  try {
    const exec = await adapter.execute(auth, row.accountRef, input, before);
    let after: EntitySnapshot | null = null;
    try { after = await adapter.snapshot(auth, row.accountRef, input.entityKind, input.entityRef); } catch { /* verificación opcional */ }
    const finalRecipe = adapter.buildRollback(input, before, exec) ?? recipe;
    await deps.repo.updateExecution(ledger.id, {
      operation: exec.operation, request: exec.request, response: exec.response,
      after, rollbackRecipe: finalRecipe, status: "done",
    });
    return { ok: true, executionId: ledger.id };
  } catch (e) {
    const message = e instanceof Error ? e.message : "error de red desconocido";
    await deps.repo.updateExecution(ledger.id, { status: "failed", response: { error: message } });
    void gates;
    return { ok: false, executionId: ledger.id, error: message };
  }
}

export async function executeAction(
  actionId: string, actor: string, workspaceIds: string[], deps: ExecutorDeps
): Promise<ExecOutcome> {
  const row = await deps.repo.getAction(actionId, workspaceIds);
  if (!row) return { ok: false, error: "Acción no encontrada." };
  if (row.status !== "approved") return { ok: false, error: "La acción debe estar aprobada antes de ejecutarse." };
  if (!row.approvedBy) return { ok: false, error: "Falta aprobación registrada (dos pasos requeridos)." };

  const input = toInput(row);
  const { adapter, auth, before, gates } = await prepare(row, input, deps);
  const blocking = blockingFailures(gates);
  if (blocking.length > 0) {
    await deps.repo.transitionAction(row, "approved", { gateResults: gates }).catch(() => undefined);
    return { ok: false, blocked: gates };
  }

  if (deps.dryRun) {
    const hash = requestHash({ network: row.network, accountRef: row.accountRef, input, dryRun: true });
    await deps.repo.insertExecution({
      actionId: row.id, network: row.network, accountRef: row.accountRef,
      operation: `dry-run:${input.actionType}:${input.entityRef}`,
      requestHash: hash, validateOnly: true, before,
      rollbackRecipe: null, status: "done", actor,
    });
    return { ok: true, dryRun: true };
  }

  await deps.repo.transitionAction(row, "executing", { gateResults: gates });
  let result: { ok: boolean; executionId?: string; error?: string };
  try {
    const recipe = adapter.buildRollback(input, before, { operation: "", request: null, response: null }) ?? null;
    result = await performWrite({ row, input, adapter, auth, before, gates, actor, deps, recipe });
  } catch (e) {
    // Safety net: performWrite only PROPAGATES throws from its pre-network portion
    // (the pending-ledger insert / request hashing) — a post-mutation failure is
    // caught inside performWrite and returned. So an exception here means no live
    // change landed; force the action out of the 'executing' limbo to 'failed'
    // rather than stranding it (which would need manual DB repair).
    const message = e instanceof Error ? e.message : "error antes de ejecutar la mutación";
    await deps.repo
      .transitionAction({ ...row, status: "executing" } as CcActionRow, "failed", { error: message })
      .catch(() => undefined);
    return { ok: false, error: message };
  }
  // The mutation decision is made; the ledger row is the source of truth. Guard the
  // status-flag write so a post-mutation DB blip can't throw and strand the action.
  if (result.ok) {
    await deps.repo
      .transitionAction({ ...row, status: "executing" } as CcActionRow, "executed", { executedAt: deps.now(), error: null })
      .catch(() => undefined);
    return { ok: true, executionId: result.executionId };
  }
  await deps.repo
    .transitionAction({ ...row, status: "executing" } as CcActionRow, "failed", { error: result.error })
    .catch(() => undefined);
  return { ok: false, error: result.error, executionId: result.executionId };
}

export async function rollbackAction(
  actionId: string, actor: string, workspaceIds: string[], deps: ExecutorDeps
): Promise<ExecOutcome> {
  const row = await deps.repo.getAction(actionId, workspaceIds);
  if (!row) return { ok: false, error: "Acción no encontrada." };
  if (row.status !== "executed" && row.status !== "verified") {
    return { ok: false, error: "Solo se puede revertir una acción ejecutada." };
  }
  const lastExec = await deps.repo.latestDoneExecution(row.id);
  const recipe = (lastExec?.rollbackRecipe ?? null) as RollbackRecipe | null;
  if (!recipe) return { ok: false, error: "Esta acción no tiene receta de rollback registrada." };

  const input = recipe.action;
  const { adapter, auth, before, gates } = await prepare(row, input, deps);
  // Rollback bypasses BUDGET_DELTA/BLAST_RADIUS/DRIFT by design: restoring a
  // prior state must always be possible. Only hard operational gates apply.
  const hardBlockers = blockingFailures(gates).filter((g) =>
    ["KILL_SWITCH", "CAPABILITY", "CURRENCY_SANITY", "VALIDATE_ONLY"].includes(g.id)
  );
  if (hardBlockers.length > 0) return { ok: false, blocked: gates };

  const result = await performWrite({ row, input, adapter, auth, before, gates, actor, deps, recipe: null });
  if (!result.ok) return { ok: false, error: result.error, executionId: result.executionId };
  await deps.repo.transitionAction(row, "rolled_back", { error: null });
  return { ok: true, executionId: result.executionId };
}
