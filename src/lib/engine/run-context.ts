// ============================================================================
// RunContext builder — reconstructs the accumulated, typed state every agent
// reads from. Loads the agent_runs row + all agent_steps rows, rebuilds the
// BrandSeed from the planner step's stored input, and folds each COMPLETED
// step's effective output (userOverride ?? output) into ctx by agent id.
// ============================================================================

import { adsDb } from "@/lib/ads-db";
import { agentRuns, agentSteps } from "@/lib/schema";
import { eq } from "drizzle-orm";
import type {
  RunContext,
  AgentRunRecord,
  BrandSeed,
  RunMode,
  RunStatus,
  AgentId,
  PlannerOutput,
  KeywordResearchOutput,
  StructureOutput,
  RSAOutput,
  QAOutput,
  ActivatorOutput,
} from "@/lib/engine/types";

export async function buildRunContext(runId: string): Promise<RunContext> {
  const [run] = await adsDb
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run) {
    throw new Error(`Run ${runId} no encontrado`);
  }

  const steps = await adsDb
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId));

  // BrandSeed was stored as the planner step's input at run creation.
  const plannerStep = steps.find((s) => s.agent === "planner");
  const brand = (plannerStep?.input ?? {}) as BrandSeed;

  const runRecord: AgentRunRecord = {
    id: run.id,
    campaignId: run.campaignId,
    brandId: run.brandId,
    workspaceId: run.workspaceId,
    userId: run.userId,
    flow: run.flow,
    channel: run.channel,
    mode: run.mode as RunMode,
    autoAdvance: run.autoAdvance,
    status: run.status as RunStatus,
    currentStepId: run.currentStepId,
    error: run.error,
  };

  const ctx: RunContext = {
    run: runRecord,
    brand,
    campaignId: run.campaignId ?? undefined,
  };

  // Fold each completed step's effective output into the typed context.
  for (const step of steps) {
    if (step.status !== "COMPLETED") continue;
    const effective = step.userOverride ?? step.output;
    if (effective == null) continue;

    switch (step.agent as AgentId) {
      case "planner":
        ctx.planner = effective as PlannerOutput;
        break;
      case "keyword_researcher":
        ctx.keywords = effective as KeywordResearchOutput;
        break;
      case "structure_architect":
        ctx.structure = effective as StructureOutput;
        break;
      case "rsa_copywriter":
        ctx.rsa = effective as RSAOutput;
        break;
      case "policy_qa":
        ctx.qa = effective as QAOutput;
        break;
      case "activator":
        ctx.activator = effective as ActivatorOutput;
        break;
    }
  }

  return ctx;
}
