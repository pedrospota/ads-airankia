// ============================================================================
// Benchmark event log — append-only, tailed by the SSE stream → suite UI.
// Same contract as the engine's agent_events: `seq` is the monotonic cursor a
// reader follows. Writes go ONLY to adsDb. Emitting never throws (best-effort).
// ============================================================================

import { adsDb } from "@/lib/ads-db";
import { benchmarkEvents } from "@/lib/schema";
import { eq, and, gt, asc } from "drizzle-orm";

export type BenchmarkEventType =
  | "stage" // a new stage started (data: { stage, progress })
  | "progress" // progress tick (data: { progress, note })
  | "partial" // a chunk of the report is ready (data: { ... })
  | "done" // run finished (data: { status })
  | "error"; // fatal error (data: { message })

export interface BenchmarkEvent {
  seq: number;
  type: string;
  data: unknown;
  createdAt: string;
}

export async function emitBenchmarkEvent(
  runId: string,
  type: BenchmarkEventType,
  data: unknown
): Promise<void> {
  try {
    await adsDb.insert(benchmarkEvents).values({ runId, type, data });
  } catch (e) {
    console.error(
      "[benchmark] failed to emit event:",
      e instanceof Error ? e.message : e
    );
  }
}

export async function readBenchmarkEventsSince(
  runId: string,
  afterSeq: number,
  limit = 200
): Promise<BenchmarkEvent[]> {
  const rows = await adsDb
    .select({
      seq: benchmarkEvents.seq,
      type: benchmarkEvents.type,
      data: benchmarkEvents.data,
      createdAt: benchmarkEvents.createdAt,
    })
    .from(benchmarkEvents)
    .where(and(eq(benchmarkEvents.runId, runId), gt(benchmarkEvents.seq, afterSeq)))
    .orderBy(asc(benchmarkEvents.seq))
    .limit(limit);

  return rows.map((r) => ({
    seq: Number(r.seq),
    type: r.type,
    data: r.data,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : "",
  }));
}
