import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { adInventory } from "@/lib/schema";
import { eq, sql } from "drizzle-orm";
import { checkDomain } from "@/lib/gdn-checker";

const CACHE_TTL_DAYS = 14;

// Auto-create table if missing
async function ensureTable() {
  try {
    await adsDb.execute(sql`
      CREATE TABLE IF NOT EXISTS ad_inventory (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        domain TEXT NOT NULL,
        has_gdn BOOLEAN DEFAULT false,
        gdn_pub_id TEXT,
        networks TEXT[],
        detection_method TEXT,
        checked_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    await adsDb.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS ad_inventory_domain_idx ON ad_inventory(domain)
    `);
  } catch {
    // table likely already exists
  }
}

let tableReady = false;

export async function POST(request: NextRequest) {
  if (!tableReady) {
    await ensureTable();
    tableReady = true;
  }

  const { domains } = (await request.json()) as { domains: string[] };

  if (!domains?.length) {
    return NextResponse.json({ error: "domains required" }, { status: 400 });
  }

  const results = [];

  for (const raw of domains.slice(0, 50)) {
    const domain = raw.replace(/^www\./, "").toLowerCase();

    // Check cache first
    try {
      const cached = await adsDb
        .select()
        .from(adInventory)
        .where(eq(adInventory.domain, domain))
        .limit(1);

      if (cached.length > 0) {
        const entry = cached[0];
        const age = Date.now() - new Date(entry.checkedAt!).getTime();
        if (age < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) {
          results.push({
            domain: entry.domain,
            hasGdn: entry.hasGdn,
            gdnPubId: entry.gdnPubId,
            networks: entry.networks,
            detectionMethod: entry.detectionMethod,
            cached: true,
          });
          continue;
        }
      }
    } catch {
      // cache miss — proceed to fresh check
    }

    // Fresh check
    const result = await checkDomain(domain);

    // Upsert to cache (best-effort)
    try {
      await adsDb
        .insert(adInventory)
        .values({
          domain: result.domain,
          hasGdn: result.hasGdn,
          gdnPubId: result.gdnPubId,
          networks: result.networks,
          detectionMethod: result.detectionMethod,
          checkedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: adInventory.domain,
          set: {
            hasGdn: result.hasGdn,
            gdnPubId: result.gdnPubId,
            networks: result.networks,
            detectionMethod: result.detectionMethod,
            checkedAt: new Date(),
          },
        });
    } catch {
      // cache write failed — not critical
    }

    results.push({ ...result, cached: false });
  }

  return NextResponse.json({ results });
}
