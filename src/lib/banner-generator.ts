// Banner generation via Gemini API with multi-modal support (text + uploaded images)

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_MODEL = "gemini-2.5-flash-preview-04-17";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export const GDN_SIZES = [
  { width: 300, height: 250, name: "Medium Rectangle", aspect: "6:5" },
  { width: 336, height: 280, name: "Large Rectangle", aspect: "6:5" },
  { width: 728, height: 90, name: "Leaderboard", aspect: "8:1" },
  { width: 160, height: 600, name: "Wide Skyscraper", aspect: "1:4" },
  { width: 320, height: 50, name: "Mobile Leaderboard", aspect: "16:9" },
] as const;

export interface BannerRequest {
  brandName: string;
  brandWebsite: string;
  tagline?: string;
  ctaText?: string;
  colorScheme?: string;
  style?: string;
  images?: { base64: string; mimeType: string }[]; // uploaded brand assets
}

export interface GeneratedBanner {
  width: number;
  height: number;
  name: string;
  base64: string;
  mimeType: string;
}

function buildPrompt(req: BannerRequest, size: typeof GDN_SIZES[number]): string {
  const cta = req.ctaText || "Learn More";
  const tagline = req.tagline || `Discover ${req.brandName}`;
  const colors = req.colorScheme || "professional dark theme with brand colors";
  const hasImages = req.images && req.images.length > 0;

  return `Create a professional Google Display Network banner advertisement.

EXACT REQUIREMENTS:
- This is a ${size.width}x${size.height} pixel banner ad (${size.name} format)
- Brand name: "${req.brandName}" — must be clearly visible and prominent
- Tagline: "${tagline}" — smaller text below or near the brand name
- CTA button: "${cta}" — a clear call-to-action button
- Color scheme: ${colors}
- The banner must look like a real professional display ad
- Clean typography, no clutter
- The brand name should be the focal point
- Include a subtle border so the ad is distinguishable on any background
${hasImages ? "- IMPORTANT: Use the provided brand images/logo in the banner design. Incorporate the logo prominently." : "- Text-based design, no placeholder imagery"}
- Make it look like it was designed by a professional advertising agency`;
}

function getGeminiAspect(size: typeof GDN_SIZES[number]): string {
  const ratio = size.width / size.height;
  if (ratio >= 7) return "8:1";
  if (ratio >= 3) return "4:1";
  if (ratio >= 1.7) return "16:9";
  if (ratio >= 1.3) return "4:3";
  if (ratio >= 0.9) return "1:1";
  if (ratio >= 0.6) return "3:4";
  return "1:4";
}

export async function generateBanner(
  req: BannerRequest,
  size: typeof GDN_SIZES[number]
): Promise<GeneratedBanner> {
  const prompt = buildPrompt(req, size);
  const aspect = getGeminiAspect(size);

  // Build parts: text prompt + any uploaded images
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];

  // Add uploaded images as multi-modal input
  if (req.images?.length) {
    for (const img of req.images.slice(0, 3)) { // max 3 images
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
  }

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: aspect, imageSize: "1K" },
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const resParts = data.candidates?.[0]?.content?.parts || [];

  for (const part of resParts) {
    if (part.inlineData) {
      return {
        width: size.width, height: size.height, name: size.name,
        base64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || "image/png",
      };
    }
  }

  throw new Error("Gemini did not return an image");
}

// Generate one specific size
export async function generateSingleBanner(
  req: BannerRequest,
  sizeId: string
): Promise<GeneratedBanner> {
  const size = GDN_SIZES.find((s) => `${s.width}x${s.height}` === sizeId);
  if (!size) throw new Error(`Unknown size: ${sizeId}`);
  return generateBanner(req, size);
}

// Generate multiple sizes
export async function generateAllBanners(
  req: BannerRequest,
  sizes?: typeof GDN_SIZES[number][]
): Promise<GeneratedBanner[]> {
  const targetSizes = sizes || [...GDN_SIZES];
  const results: GeneratedBanner[] = [];
  for (const size of targetSizes) {
    try {
      const banner = await generateBanner(req, size);
      results.push(banner);
    } catch (e) {
      console.error(`Failed to generate ${size.name}:`, e);
    }
  }
  return results;
}
