import { NextRequest, NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { adInventory } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { checkDomain } from "@/lib/gdn-checker";

const CACHE_TTL_DAYS = 14;

export async function POST(request: NextRequest) {
  const { domains } = (await request.json()) as { domains: string[] };

  if (!domains?.length) {
    return NextResponse.json({ error: "domains required" }, { status: 400 });
  }

  const results = [];

  for (const raw of domains.slice(0, 50)) {
    const domain = raw.replace(/^www\./, "").toLowerCase();

    // Check cache first
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

    // Fresh check
    const result = await checkDomain(domain);

    // Upsert to cache
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

    results.push({ ...result, cached: false });
  }

  return NextResponse.json({ results });
}
