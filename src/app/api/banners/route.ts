import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { generateSingleBanner, generateAllBanners, GDN_SIZES, type BannerRequest } from "@/lib/banner-generator";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const { brandName, brandWebsite, tagline, ctaText, colorScheme, style, sizes, singleSize, images } = body as {
    brandName: string;
    brandWebsite: string;
    tagline?: string;
    ctaText?: string;
    colorScheme?: string;
    style?: string;
    sizes?: string[];
    singleSize?: string; // e.g. "300x250" — regenerate just this one
    images?: { base64: string; mimeType: string }[];
  };

  if (!brandName) {
    return NextResponse.json({ error: "brandName is required" }, { status: 400 });
  }

  const req: BannerRequest = { brandName, brandWebsite, tagline, ctaText, colorScheme, style, images };

  try {
    // Single banner regeneration
    if (singleSize) {
      const banner = await generateSingleBanner(req, singleSize);
      return NextResponse.json({
        banners: [{
          width: banner.width, height: banner.height, name: banner.name,
          dataUrl: `data:${banner.mimeType};base64,${banner.base64}`,
        }],
      });
    }

    // Multiple banners
    let targetSizes = [...GDN_SIZES];
    if (sizes?.length) {
      targetSizes = GDN_SIZES.filter((s) => sizes.includes(`${s.width}x${s.height}`));
      if (targetSizes.length === 0) targetSizes = [...GDN_SIZES];
    }

    const banners = await generateAllBanners(req, targetSizes);

    return NextResponse.json({
      banners: banners.map((b) => ({
        width: b.width, height: b.height, name: b.name,
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
