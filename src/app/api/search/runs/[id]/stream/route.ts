import type { NextRequest } from "next/server";
import {
  readEventsSince,
  getRunState,
  type EngineEvent,
} from "@/lib/engine/orchestrator";
import type { RunStatus } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "failed",
  "aborted",
]);

const POLL_MS = 600;

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

// GET: Server-Sent Events stream of a run's event log. Tails agent_events from
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
          // (1) Drain any new events since the last seq.
          let events: EngineEvent[] = [];
          try {
            events = await readEventsSince(id, lastSeq);
          } catch {
            // Run/table read hiccup — emit nothing and retry next tick.
            events = [];
          }

          for (const ev of events) {
            send(`data: ${JSON.stringify(ev)}\n\n`);
            lastSeq = ev.seq;
          }

          // (2) Check terminal status; emit a final run_status and close.
          let status: RunStatus | null = null;
          try {
            const state = await getRunState(id);
            status = state.run.status;
          } catch {
            status = null;
          }

          if (status && TERMINAL.has(status)) {
            // Drain anything that arrived between the last read and now.
            try {
              const tail = await readEventsSince(id, lastSeq);
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

          // (3) Keep-alive comment when idle so proxies don't drop us.
          if (events.length === 0) {
            send(`: ping\n\n`);
          }

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
