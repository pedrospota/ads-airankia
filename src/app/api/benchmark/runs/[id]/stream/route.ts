import type { NextRequest } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { benchmarkRuns } from "@/lib/schema";
import { eq } from "drizzle-orm";
import {
  readBenchmarkEventsSince,
  type BenchmarkEvent,
} from "@/lib/benchmark/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TERMINAL = new Set(["completed", "failed"]);
const POLL_MS = 700;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

// GET: SSE stream of one benchmark run's event log. Tails benchmark_events from
// `?after` (or 0), emits each event, and closes once the run is terminal.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const afterParam = request.nextUrl.searchParams.get("after");
  let lastSeq = afterParam ? Number(afterParam) : 0;
  if (!Number.isFinite(lastSeq) || lastSeq < 0) lastSeq = 0;

  const encoder = new TextEncoder();
  const signal = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* controller already closed */
        }
      };

      try {
        while (!signal.aborted) {
          let events: BenchmarkEvent[] = [];
          try {
            events = await readBenchmarkEventsSince(id, lastSeq);
          } catch {
            events = [];
          }

          for (const ev of events) {
            send(`data: ${JSON.stringify(ev)}\n\n`);
            lastSeq = ev.seq;
          }

          let status: string | null = null;
          try {
            const [row] = await adsDb
              .select({ status: benchmarkRuns.status })
              .from(benchmarkRuns)
              .where(eq(benchmarkRuns.id, id))
              .limit(1);
            status = row?.status ?? null;
          } catch {
            status = null;
          }

          if (status && TERMINAL.has(status)) {
            try {
              const tail = await readBenchmarkEventsSince(id, lastSeq);
              for (const ev of tail) {
                send(`data: ${JSON.stringify(ev)}\n\n`);
                lastSeq = ev.seq;
              }
            } catch {
              /* best effort */
            }
            send(`data: ${JSON.stringify({ type: "run_status", status })}\n\n`);
            break;
          }

          if (events.length === 0) send(`: ping\n\n`);
          await sleep(POLL_MS, signal);
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
