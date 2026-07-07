// Centro de Mando v2 — Review-screen gate PREVIEW. Read-only: runs the SAME deterministic
// gates (gates.ts::runGates) the executor runs at publish time, against the account's REAL
// settings + today's executed-action count, so the operator sees whether the blueprint's
// compiled actions would clear the gates BEFORE clicking "Publicar en pausa" — not only
// reactively, after a 409 (spec §10; Task 14 shipped only the reactive panel — see
// revisar-client.tsx's `blocked` state).
//
// This module NEVER creates/mutates cc_actions and never approves/executes anything. Two
// deliberate simplifications vs. the real executor path (executor.ts prepare()):
//
// 1. Capabilities are SYNTHESIZED (see SYNTHETIC_CAPABILITIES) instead of calling the real
//    adapter.capabilities(auth) — that needs a resolved OAuth token (an async Supabase read +
//    decrypt keyed on blueprint.connectionId), which this read-only, page-load preview
//    shouldn't spend. The gate that actually matters for creates — ACTION_ALLOWED, checked
//    against the account's REAL cc_settings.allowed_action_types below — is unaffected:
//    CAPABILITY only needs to not be the thing that blocks a preview that would otherwise
//    legitimately pass at publish time.
// 2. Google's validateOnly rehearsal is left unresolved (`validateResult: null`) — it needs a
//    real resourceName that only exists AFTER creation, so it genuinely cannot run
//    pre-creation. Left as-is, gates.ts's VALIDATE_ONLY gate would show a permanent
//    false-positive block on every google_ads action, so it is explicitly excluded from the
//    aggregated `blocking` set below (it stays in the full `gates` array for transparency).
//    `validateOnlyDeferred: true` on the returned GatePreview is how the review screen tells
//    the operator "this one gate still runs for real at publish."
import { blockingFailures, runGates, type GateInput } from "../gates";
import { getBlueprint, type BlueprintRepoDeps } from "./repo";
import { parseBlueprint } from "./schema";
import { compile } from "./compile";
import type { AdapterCapabilities, CcSettingsValues, EntitySnapshot, GateResult } from "../types";

export interface GatePreviewDeps {
  /** Same shape as ExecutorDeps["settings"] (executor.ts / plan-runner.ts) — reused, not
   * reimplemented. Pass `buildExecutorDeps(...).settings` straight through. */
  settings: { get(workspaceId: string): Promise<CcSettingsValues> };
  /** Same shape as ExecutorDeps["repo"]["countExecutedToday"] — reused, not reimplemented.
   * Pass `buildExecutorDeps(...).repo` straight through (only this method is used). */
  repo: { countExecutedToday(accountRef: string): Promise<number> };
  /** Optional injectable override for the blueprint lookup, mirroring repo.ts's own
   * `BlueprintRepoDeps` pattern, so unit tests never touch adsDb. Defaults to the real,
   * DB-backed repo (getBlueprint's own default) when omitted. */
  blueprintRepo?: BlueprintRepoDeps;
}

export interface GatePreviewAction {
  seq: number;
  actionType: string;
  entityKind: string;
  /** Full runGates() output for this action — every gate, pass or fail, INCLUDING
   * VALIDATE_ONLY (which always reads "fail" here; see header comment). */
  gates: GateResult[];
  /** blockingFailures(gates) with VALIDATE_ONLY excluded — the deterministic gates that
   * genuinely block this action right now, independent of the deferred live rehearsal. */
  blocking: GateResult[];
}

export interface GatePreview {
  perAction: GatePreviewAction[];
  summary: { actions: number; gatesRun: number; blockingCount: number };
  /** Always true: Google's validateOnly rehearsal cannot run before creation (see header
   * comment) — it runs for real inside executeBlueprint at publish time. */
  validateOnlyDeferred: true;
}

const SYNTHETIC_CAPABILITIES: AdapterCapabilities = {
  read: true,
  write: true,
  actionTypes: [
    "create_budget", "create_campaign", "create_ad_group", "create_keywords", "create_ad", "remove_entity",
  ],
};

/**
 * Loads `blueprintId` (workspace-scoped), parses + compiles its doc, and runs the
 * deterministic gates for every compiled action against the account's real settings and
 * today's executed-action count. Throws if the blueprint isn't found/out of scope (mirrors
 * `compileBlueprintToActions`'s own "Blueprint no encontrado." convention in repo.ts) —
 * callers that already resolved the blueprint (e.g. the review page, which 404s first) won't
 * hit this in practice.
 */
export async function previewBlueprintGates(
  blueprintId: string,
  workspaceIds: string[],
  deps: GatePreviewDeps
): Promise<GatePreview> {
  const blueprint = deps.blueprintRepo
    ? await getBlueprint(blueprintId, workspaceIds, deps.blueprintRepo)
    : await getBlueprint(blueprintId, workspaceIds);
  if (!blueprint) throw new Error(`Blueprint no encontrado: ${blueprintId}`);

  const doc = parseBlueprint(blueprint.doc);
  const compiled = compile(doc, blueprintId);

  const settings = await deps.settings.get(blueprint.workspaceId);
  const executedTodayForAccount = await deps.repo.countExecutedToday(blueprint.accountRef);

  const perAction: GatePreviewAction[] = compiled.map((action) => {
    const before: EntitySnapshot = { entityKind: action.entityKind, entityRef: action.entityRef, status: "UNKNOWN" };
    const input: GateInput = {
      settings,
      network: "google_ads",
      action: { actionType: action.actionType, entityKind: action.entityKind, entityRef: action.entityRef, payload: action.payload },
      capabilities: SYNTHETIC_CAPABILITIES,
      before,
      expected: null,
      executedTodayForAccount,
      validateResult: null,
    };
    const gates = runGates(input);
    const blocking = blockingFailures(gates).filter((g) => g.id !== "VALIDATE_ONLY");
    return { seq: action.seq, actionType: action.actionType, entityKind: action.entityKind, gates, blocking };
  });

  const summary = {
    actions: perAction.length,
    gatesRun: perAction.reduce((sum, a) => sum + a.gates.length, 0),
    blockingCount: perAction.reduce((sum, a) => sum + a.blocking.length, 0),
  };

  return { perAction, summary, validateOnlyDeferred: true };
}
