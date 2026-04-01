import { NextRequest, NextResponse } from "next/server";
import { scrapeBrandWebsite } from "@/lib/brand-scraper";

export async function POST(request: NextRequest) {
  const { url } = await request.json() as { url: string };
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  const profile = await scrapeBrandWebsite(url);
  return NextResponse.json(profile);
}
