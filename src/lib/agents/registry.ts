import planner from "./a1-planner";
import keywordResearcher from "./a2-keyword-researcher";
import structureArchitect from "./a3-structure-architect";
import rsaCopywriter from "./a4-rsa-copywriter";
import policyQa from "./a5-policy-qa";
import activator from "./a6-activator";
import type { AgentDefinition, AgentId } from "@/lib/engine/types";

export const AGENTS: Record<AgentId, AgentDefinition> = {
  planner,
  keyword_researcher: keywordResearcher,
  structure_architect: structureArchitect,
  rsa_copywriter: rsaCopywriter,
  policy_qa: policyQa,
  activator,
};

export function getAgent(id: AgentId): AgentDefinition {
  const a = AGENTS[id];
  if (!a) throw new Error("Unknown agent: " + id);
  return a;
}
