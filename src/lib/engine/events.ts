// ============================================================================
// Engine event log — append-only, tailed by the SSE stream → run UI.
// Writes go ONLY to adsDb (Postgres). `seq` is the monotonic cursor a reader
// follows; `emitEvent` appends, `readEventsSince` tails everything after a seq.
// ============================================================================

import { adsDb } from "@/lib/ads-db";
import { agentEvents } from "@/lib/schema";
import { eq, and, gt, asc } from "drizzle-orm";
import type { AgentEventType } from "@/lib/engine/types";

/** Append one event to the run's log. Never throws on shape (data is jsonb). */
export async function emitEvent(
  runId: string,
  stepId: string | null,
  type: AgentEventType,
  data: unknown
): Promise<void> {
  await adsDb.insert(agentEvents).values({
    runId,
    stepId,
    type,
    data,
  });
}

export interface EngineEvent {
  seq: number;
  type: string;
  stepId: string | null;
  data: unknown;
  createdAt: string;
}

/** Read events for a run after `afterSeq` (exclusive), oldest first. */
export async function readEventsSince(
  runId: string,
  afterSeq: number,
  limit = 200
): Promise<EngineEvent[]> {
  const rows = await adsDb
    .select({
      seq: agentEvents.seq,
      type: agentEvents.type,
      stepId: agentEvents.stepId,
      data: agentEvents.data,
      createdAt: agentEvents.createdAt,
    })
    .from(agentEvents)
    .where(and(eq(agentEvents.runId, runId), gt(agentEvents.seq, afterSeq)))
    .orderBy(asc(agentEvents.seq))
    .limit(limit);

  return rows.map((r) => ({
    seq: Number(r.seq),
    type: r.type,
    stepId: r.stepId,
    data: r.data,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : "",
  }));
}
