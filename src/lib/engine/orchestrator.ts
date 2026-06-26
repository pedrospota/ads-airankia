// ============================================================================
// Engine orchestrator — "un motor, dos caras".
// The single driver for the 6-agent Search-build pipeline. A run's `autoAdvance`
// flag decides the face:
//   - MODO AUTO     → runs straight through, stopping only at the ACTIVATION gate
//                     (or a QA block).
//   - MODO ASISTIDO → runs exactly one step per advance, then waits for approval.
//
// SAFETY INVARIANTS (must never be violated):
//   - The activator is an ACTIVATION GATE: advanceRun NEVER auto-runs it.
//   - The activator pushes the campaign to Google ALWAYS PAUSED. Nothing here
//     enables a campaign — enabling lives behind the dedicated /enable route.
//
// All writes go to adsDb (Postgres) only. Supabase is never written here.
// ============================================================================

import { getAgent } from "@/lib/agents/registry";
import { adsDb } from "@/lib/ads-db";
import { agentRuns, agentSteps, campaigns } from "@/lib/schema";
import { eq, and, sql } from "drizzle-orm";
import { MODELS } from "@/lib/anthropic";
import {
  emitEvent,
  readEventsSince,
  type EngineEvent,
} from "@/lib/engine/events";
import { buildRunContext } from "@/lib/engine/run-context";
import {
  PIPELINE,
  AGENT_TITLES,
  type AgentId,
  type RunMode,
  type RunStatus,
  type StepStatus,
  type BrandSeed,
  type RunStateDTO,
  type StepDTO,
  type AdvanceRequest,
  type AgentHelpers,
  type AgentEventType,
  type QAOutput,
} from "@/lib/engine/types";

// Re-export the event-tailing surface so API routes (SSE stream, poll) import a
// single engine entrypoint instead of reaching into events.ts directly.
export { readEventsSince };
export type { EngineEvent };

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const OPUS_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>([
  "planner",
  "structure_architect",
  "policy_qa",
]);

function modelForAgent(id: AgentId): string | null {
  if (id === "activator") return null;
  return OPUS_AGENTS.has(id) ? MODELS.opus : MODELS.sonnet;
}

function kindForAgent(id: AgentId): "llm" | "code" {
  return id === "activator" ? "code" : "llm";
}

/** Order index of an agent within the canonical pipeline. */
function pipelineIndex(agent: string): number {
  const idx = PIPELINE.indexOf(agent as AgentId);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

type StepRow = typeof agentSteps.$inferSelect;
type RunRow = typeof agentRuns.$inferSelect;

async function loadRun(runId: string): Promise<RunRow> {
  const [run] = await adsDb
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) throw new Error(`Run ${runId} no encontrado`);
  return run;
}

/** All steps for a run, ordered by the canonical pipeline order. */
async function loadSteps(runId: string): Promise<StepRow[]> {
  const rows = await adsDb
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId));
  return rows.sort((a, b) => pipelineIndex(a.agent) - pipelineIndex(b.agent));
}

/** First NOT_STARTED step in pipeline order, or null if none remain. */
function firstNotStarted(steps: StepRow[]): StepRow | null {
  return steps.find((s) => s.status === "NOT_STARTED") ?? null;
}

// ----------------------------------------------------------------------------
// createRun
// ----------------------------------------------------------------------------

export async function createRun(input: {
  brandId: string;
  workspaceId: string;
  userId: string;
  mode: RunMode;
  seed: BrandSeed;
}): Promise<{ runId: string; campaignId: string }> {
  const { brandId, workspaceId, userId, mode, seed } = input;

  // (1) Draft Search campaign row.
  const [campaign] = await adsDb
    .insert(campaigns)
    .values({
      brandId,
      workspaceId,
      userId,
      campaignType: "search",
      status: "draft",
      landingPageUrl: seed.landingPageUrl ?? seed.brandWebsite,
      brandName: seed.brandName,
      brandWebsite: seed.brandWebsite,
    })
    .returning();
  const campaignId = campaign.id;

  // (2) The run.
  const [run] = await adsDb
    .insert(agentRuns)
    .values({
      campaignId,
      brandId,
      workspaceId,
      userId,
      flow: "search_build",
      channel: "search",
      mode,
      autoAdvance: mode === "auto",
      status: "queued",
    })
    .returning();
  const runId = run.id;

  // (3) One step per pipeline agent. The planner step carries the seed as input.
  let plannerStepId: string | null = null;
  for (const id of PIPELINE) {
    const [step] = await adsDb
      .insert(agentSteps)
      .values({
        runId,
        agent: id,
        kind: kindForAgent(id),
        status: "NOT_STARTED",
        model: modelForAgent(id),
        input: id === "planner" ? (seed as unknown as object) : null,
      })
      .returning();
    if (id === "planner") plannerStepId = step.id;
  }

  // Point the run at the planner step as the current step.
  if (plannerStepId) {
    await adsDb
      .update(agentRuns)
      .set({ currentStepId: plannerStepId, updatedAt: new Date() })
      .where(eq(agentRuns.id, runId));
  }

  // (4) First lifecycle event.
  await emitEvent(runId, null, "run_status", { status: "queued" });

  return { runId, campaignId };
}

// ----------------------------------------------------------------------------
// getRunState
// ----------------------------------------------------------------------------

export async function getRunState(runId: string): Promise<RunStateDTO> {
  const run = await loadRun(runId);
  const steps = await loadSteps(runId);

  // Left-join campaigns for the published google campaign id (if any).
  let googleCampaignId: string | null = null;
  if (run.campaignId) {
    const [camp] = await adsDb
      .select({ googleCampaignId: campaigns.googleCampaignId })
      .from(campaigns)
      .where(eq(campaigns.id, run.campaignId))
      .limit(1);
    googleCampaignId =
      camp?.googleCampaignId != null ? String(camp.googleCampaignId) : null;
  }

  const stepDtos: StepDTO[] = steps.map((s) => ({
    id: s.id,
    agent: s.agent as AgentId,
    title: AGENT_TITLES[s.agent as AgentId] ?? s.agent,
    kind: s.kind as "llm" | "code",
    status: s.status as StepStatus,
    model: s.model,
    output: s.output,
    userOverride: s.userOverride,
    rationale: s.rationale,
    startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
    finishedAt: s.finishedAt ? new Date(s.finishedAt).toISOString() : null,
  }));

  return {
    run: {
      id: run.id,
      status: run.status as RunStatus,
      mode: run.mode as RunMode,
      autoAdvance: run.autoAdvance,
      campaignId: run.campaignId,
      googleCampaignId,
      error: run.error,
    },
    steps: stepDtos,
  };
}

// ----------------------------------------------------------------------------
// runStep — execute exactly one step (idempotent on COMPLETED)
// ----------------------------------------------------------------------------

export async function runStep(runId: string, stepId: string): Promise<void> {
  const [step] = await adsDb
    .select()
    .from(agentSteps)
    .where(and(eq(agentSteps.id, stepId), eq(agentSteps.runId, runId)))
    .limit(1);
  if (!step) throw new Error(`Step ${stepId} no encontrado en run ${runId}`);

  // Idempotent: a completed step is never re-run.
  if (step.status === "COMPLETED") return;

  const agent = step.agent as AgentId;

  // Mark RUNNING.
  await adsDb
    .update(agentSteps)
    .set({ status: "RUNNING", startedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentSteps.id, stepId));
  await emitEvent(runId, stepId, "step_started", { agent });

  try {
    const ctx = await buildRunContext(runId);
    const def = getAgent(agent);

    const helpers: AgentHelpers = {
      emit: (type: AgentEventType, data: unknown) =>
        emitEvent(runId, stepId, type, data),
      stepId,
      signal: undefined,
    };

    const result = await def.execute(ctx, helpers);

    await adsDb
      .update(agentSteps)
      .set({
        output: (result.output ?? null) as object | null,
        rationale: result.rationale ?? null,
        model: result.model ?? step.model,
        tokensIn: result.tokensIn ?? 0,
        tokensOut: result.tokensOut ?? 0,
        costMicrosLlm: result.costMicros ?? 0,
        status: "COMPLETED",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentSteps.id, stepId));

    // Bump the run's running LLM cost total.
    if (result.costMicros) {
      await adsDb
        .update(agentRuns)
        .set({
          costMicrosLlm: sql`${agentRuns.costMicrosLlm} + ${result.costMicros}`,
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
    }

    await emitEvent(runId, stepId, "step_completed", {
      agent,
      output: result.output,
      rationale: result.rationale,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Fallo del agente";

    await adsDb
      .update(agentSteps)
      .set({
        status: "FAILED",
        error: message,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentSteps.id, stepId));

    await adsDb
      .update(agentRuns)
      .set({ status: "failed", error: message, updatedAt: new Date() })
      .where(eq(agentRuns.id, runId));

    await emitEvent(runId, stepId, "error", { agent, message });

    throw e;
  }
}

// ----------------------------------------------------------------------------
// advanceRun — the driver
// ----------------------------------------------------------------------------

export async function advanceRun(
  runId: string,
  opts?: AdvanceRequest
): Promise<RunStateDTO> {
  // (a) Persist a sticky user override on the named step, if provided.
  if (opts?.stepId && opts.userOverride !== undefined) {
    await adsDb
      .update(agentSteps)
      .set({
        userOverride: (opts.userOverride ?? null) as object | null,
        updatedAt: new Date(),
      })
      .where(and(eq(agentSteps.id, opts.stepId), eq(agentSteps.runId, runId)));
    await emitEvent(runId, opts.stepId, "decision", {
      stepId: opts.stepId,
      accepted: true,
    });
  }

  const run = await loadRun(runId);
  let steps = await loadSteps(runId);

  // (b) Next runnable step = first NOT_STARTED. Activator is a gate (never
  // auto-run here).
  let next = firstNotStarted(steps);

  // (c) Mark the run running.
  await adsDb
    .update(agentRuns)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(agentRuns.id, runId));
  await emitEvent(runId, null, "run_status", { status: "running" });

  if (run.autoAdvance) {
    // ---- (d) MODO AUTO ----------------------------------------------------
    while (next && (next.agent as AgentId) !== "activator") {
      const stepId = next.id;
      const agent = next.agent as AgentId;

      await runStep(runId, stepId);

      // Reload after the step ran.
      steps = await loadSteps(runId);
      const ran = steps.find((s) => s.id === stepId);

      // If it failed, runStep already set run.status = 'failed'.
      if (ran?.status === "FAILED") {
        return getRunState(runId);
      }

      // QA block → hard stop at an approval gate.
      if (agent === "policy_qa") {
        const qa = (ran?.userOverride ?? ran?.output) as QAOutput | null;
        if (qa?.verdict === "block") {
          await adsDb
            .update(agentRuns)
            .set({ status: "awaiting_approval", updatedAt: new Date() })
            .where(eq(agentRuns.id, runId));
          await emitEvent(runId, stepId, "gate", { reason: "qa_block" });
          return getRunState(runId);
        }
      }

      next = firstNotStarted(steps);
    }

    // After the loop: either the activator remains (ready to activate) or
    // nothing remains (everything but activation is done).
    if (next && (next.agent as AgentId) === "activator") {
      await adsDb
        .update(agentRuns)
        .set({
          status: "awaiting_approval",
          currentStepId: next.id,
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
      await emitEvent(runId, next.id, "gate", { reason: "ready_to_activate" });
    } else if (!next) {
      await adsDb
        .update(agentRuns)
        .set({
          status: "completed",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
    }

    return getRunState(runId);
  }

  // ---- (e) MODO ASISTIDO --------------------------------------------------
  if (!next) {
    // Nothing left to run; nothing to do but report current state.
    return getRunState(runId);
  }

  if ((next.agent as AgentId) === "activator") {
    // Only the activator remains: it is a gate, not an assisted step.
    await adsDb
      .update(agentRuns)
      .set({
        status: "awaiting_approval",
        currentStepId: next.id,
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));
    await emitEvent(runId, next.id, "gate", { reason: "ready_to_activate" });
    return getRunState(runId);
  }

  // Run exactly ONE non-activator step.
  const ranStepId = next.id;
  await runStep(runId, ranStepId);

  steps = await loadSteps(runId);
  const ran = steps.find((s) => s.id === ranStepId);
  if (ran?.status === "FAILED") {
    return getRunState(runId);
  }

  await adsDb
    .update(agentRuns)
    .set({
      status: "awaiting_approval",
      currentStepId: ranStepId,
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
  await emitEvent(runId, ranStepId, "gate", {
    reason: "awaiting_step_approval",
    stepId: ranStepId,
  });

  // If the only thing left is the activator, also signal ready-to-activate.
  const remaining = firstNotStarted(steps);
  if (remaining && (remaining.agent as AgentId) === "activator") {
    await emitEvent(runId, remaining.id, "gate", {
      reason: "ready_to_activate",
    });
  }

  return getRunState(runId);
}

// ----------------------------------------------------------------------------
// runActivatorStep — the ONLY caller is the dedicated /activate route.
// Pushes the campaign to Google (ALWAYS PAUSED). Does NOT enable anything.
// ----------------------------------------------------------------------------

export async function runActivatorStep(runId: string): Promise<RunStateDTO> {
  const steps = await loadSteps(runId);
  const activator = steps.find((s) => (s.agent as AgentId) === "activator");
  if (!activator) {
    throw new Error(`Run ${runId} no tiene paso de activación`);
  }

  // SAFETY GATE: never push a campaign to Google before the final review has
  // finished, and never if that review BLOCKED the plan. This is the
  // authoritative server-side check — the UI mirrors it, but this is the line
  // that actually protects the user's Google Ads account.
  const qaStep = steps.find((s) => (s.agent as AgentId) === "policy_qa");
  if (!qaStep || qaStep.status !== "COMPLETED") {
    throw new Error(
      "Todavía no hemos terminado de revisar la campaña. Espera a que acabe la revisión final antes de activar.",
    );
  }
  const qa = (qaStep.userOverride ?? qaStep.output) as QAOutput | null;
  if (qa?.verdict === "block") {
    throw new Error(
      "La revisión final encontró algo que hay que corregir antes de publicar. Revisa los avisos y vuelve a generar la campaña.",
    );
  }

  // Pushes to Google PAUSED + persists google ids (inside the agent).
  await runStep(runId, activator.id);

  const refreshed = await loadSteps(runId);
  const ran = refreshed.find((s) => s.id === activator.id);
  if (ran?.status === "FAILED") {
    // runStep already set run.status = 'failed'.
    return getRunState(runId);
  }

  await adsDb
    .update(agentRuns)
    .set({
      status: "completed",
      currentStepId: activator.id,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
  await emitEvent(runId, activator.id, "run_status", { status: "completed" });

  return getRunState(runId);
}
