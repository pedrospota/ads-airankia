import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { generateBanner, generateAllBanners, GDN_SIZES, type BannerRequest } from "@/lib/banner-generator";
import { adsDb } from "@/lib/ads-db";
import { bannerAssets } from "@/lib/schema";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const { brandName, brandWebsite, tagline, ctaText, colorScheme, style, campaignId, sizes } = body as {
    brandName: string;
    brandWebsite: string;
    tagline?: string;
    ctaText?: string;
    colorScheme?: string;
    style?: string;
    campaignId?: string;
    sizes?: string[]; // e.g. ["300x250", "728x90"]
  };

  if (!brandName) {
    return NextResponse.json({ error: "brandName is required" }, { status: 400 });
  }

  const req: BannerRequest = { brandName, brandWebsite, tagline, ctaText, colorScheme, style };

  // Filter to requested sizes or use all
  let targetSizes = [...GDN_SIZES];
  if (sizes?.length) {
    targetSizes = GDN_SIZES.filter((s) =>
      sizes.includes(`${s.width}x${s.height}`)
    );
    if (targetSizes.length === 0) targetSizes = [...GDN_SIZES];
  }

  try {
    const banners = await generateAllBanners(req, targetSizes);

    // Save to DB if campaignId provided
    if (campaignId) {
      for (const banner of banners) {
        await adsDb.insert(bannerAssets).values({
          campaignId,
          format: `${banner.width}x${banner.height}`,
          r2Url: `data:${banner.mimeType};base64,${banner.base64.slice(0, 50)}...`, // placeholder until R2
          width: banner.width,
          height: banner.height,
          status: "generated",
          promptUsed: `${brandName} - ${banner.name}`,
        });
      }
    }

    return NextResponse.json({
      banners: banners.map((b) => ({
        width: b.width,
        height: b.height,
        name: b.name,
        dataUrl: `data:${b.mimeType};base64,${b.base64}`,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Banner generation failed" },
      { status: 500 }
    );
  }
}

// Get generated banners for a campaign
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get("campaignId");

  if (!campaignId) {
    return NextResponse.json({ error: "campaignId required" }, { status: 400 });
  }

  const assets = await adsDb
    .select()
    .from(bannerAssets)
    .where(eq(bannerAssets.campaignId, campaignId));

  return NextResponse.json({ banners: assets });
}
