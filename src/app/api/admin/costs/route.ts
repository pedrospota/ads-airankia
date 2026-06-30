// ============================================================================
// GET /api/admin/costs — cost-observability rollups for the /admin Costs panel.
//
// Reads the unified `cost_events` ledger and returns per-day / per-user /
// per-provider / per-model breakdowns plus grand totals, over a window of the
// last N days (?days=, default 30, clamped 1..365). Admin-gated; never touches
// the original Supabase. All money is in micros (1e-6 of the account currency);
// the client formats it.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin";
import { adsDb } from "@/lib/ads-db";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  // drizzle node-postgres returns a pg QueryResult ({ rows }).
  const res = (await adsDb.execute(query)) as unknown as { rows?: T[] };
  return res.rows ?? [];
}

export async function GET(request: NextRequest) {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const daysParam = Number(request.nextUrl.searchParams.get("days"));
  const days = Number.isFinite(daysParam)
    ? Math.min(365, Math.max(1, Math.round(daysParam)))
    : 30;
  const since = sql`now() - (${days} || ' days')::interval`;

  try {
    const [totals, byDay, byProvider, byCategory, byModel, byUser, recent, byTool] =
      await Promise.all([
        rows<{
          cost_micros: number;
          tokens_in: number;
          tokens_out: number;
          events: number;
          users: number;
          runs: number;
        }>(sql`
          SELECT
            COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
            COALESCE(SUM(tokens_in), 0)::float8 AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::float8 AS tokens_out,
            COUNT(*)::int AS events,
            COUNT(DISTINCT user_id)::int AS users,
            COUNT(DISTINCT run_id)::int AS runs
          FROM cost_events
          WHERE occurred_at >= ${since}
        `),
        rows<{
          day: string;
          cost_micros: number;
          tokens_in: number;
          tokens_out: number;
          events: number;
        }>(sql`
          SELECT
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
            COALESCE(SUM(tokens_in), 0)::float8 AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::float8 AS tokens_out,
            COUNT(*)::int AS events
          FROM cost_events
          WHERE occurred_at >= ${since}
          GROUP BY day
          ORDER BY day DESC
        `),
        rows<{ provider: string | null; cost_micros: number; events: number }>(sql`
          SELECT provider,
                 COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
                 COUNT(*)::int AS events
          FROM cost_events
          WHERE occurred_at >= ${since}
          GROUP BY provider
          ORDER BY cost_micros DESC
        `),
        rows<{ category: string; cost_micros: number; events: number }>(sql`
          SELECT category,
                 COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
                 COUNT(*)::int AS events
          FROM cost_events
          WHERE occurred_at >= ${since}
          GROUP BY category
          ORDER BY cost_micros DESC
        `),
        rows<{
          resource: string | null;
          provider: string | null;
          cost_micros: number;
          tokens_in: number;
          tokens_out: number;
          events: number;
        }>(sql`
          SELECT resource, provider,
                 COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
                 COALESCE(SUM(tokens_in), 0)::float8 AS tokens_in,
                 COALESCE(SUM(tokens_out), 0)::float8 AS tokens_out,
                 COUNT(*)::int AS events
          FROM cost_events
          WHERE occurred_at >= ${since} AND category = 'llm'
          GROUP BY resource, provider
          ORDER BY cost_micros DESC
          LIMIT 20
        `),
        rows<{
          user_id: string | null;
          cost_micros: number;
          tokens_in: number;
          tokens_out: number;
          events: number;
          runs: number;
        }>(sql`
          SELECT user_id,
                 COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
                 COALESCE(SUM(tokens_in), 0)::float8 AS tokens_in,
                 COALESCE(SUM(tokens_out), 0)::float8 AS tokens_out,
                 COUNT(*)::int AS events,
                 COUNT(DISTINCT run_id)::int AS runs
          FROM cost_events
          WHERE occurred_at >= ${since}
          GROUP BY user_id
          ORDER BY cost_micros DESC
          LIMIT 25
        `),
        rows<{
          occurred_at: string;
          category: string;
          provider: string | null;
          resource: string | null;
          cost_micros: number;
          tokens_in: number;
          tokens_out: number;
          units: number;
          user_id: string | null;
          run_id: string | null;
        }>(sql`
          SELECT occurred_at, category, provider, resource,
                 cost_micros::float8 AS cost_micros,
                 tokens_in::float8 AS tokens_in,
                 tokens_out::float8 AS tokens_out,
                 units::float8 AS units,
                 user_id, run_id
          FROM cost_events
          WHERE occurred_at >= ${since}
          ORDER BY occurred_at DESC
          LIMIT 40
        `),
        // Per-tool spend — what each feature/tool consumes (from meta.module/tool),
        // so spend is observable down to "spy/keyword_spend", "benchmark/report", etc.
        rows<{
          module: string | null;
          tool: string | null;
          cost_micros: number;
          tokens_in: number;
          tokens_out: number;
          events: number;
        }>(sql`
          SELECT
            meta->>'module' AS module,
            COALESCE(meta->>'tool', meta->>'stage', resource) AS tool,
            COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
            COALESCE(SUM(tokens_in), 0)::float8 AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::float8 AS tokens_out,
            COUNT(*)::int AS events
          FROM cost_events
          WHERE occurred_at >= ${since}
          GROUP BY module, tool
          ORDER BY cost_micros DESC, events DESC
          LIMIT 40
        `),
      ]);

    return NextResponse.json({
      days,
      currency: process.env.GOOGLE_ADS_CURRENCY ?? "USD",
      totals: totals[0] ?? {
        cost_micros: 0,
        tokens_in: 0,
        tokens_out: 0,
        events: 0,
        users: 0,
        runs: 0,
      },
      byDay,
      byProvider,
      byCategory,
      byModel,
      byTool,
      byUser,
      recent,
    });
  } catch (e) {
    // Most likely the table doesn't exist yet (run /api/migrate). Return a
    // clear, non-leaky error so the panel can prompt to migrate.
    const message = e instanceof Error ? e.message : "query failed";
    return NextResponse.json(
      { error: "cost_query_failed", detail: message },
      { status: 500 }
    );
  }
}
