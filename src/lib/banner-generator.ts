// Banner generation via Gemini API — generates GDN-compliant display ad banners

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_MODEL = "gemini-2.5-flash-preview-04-17";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Standard GDN banner sizes (width x height)
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
  logoUrl?: string;
  colorScheme?: string;
  style?: string;
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
  const style = req.style || "clean, modern, corporate";

  return `Create a professional Google Display Network banner advertisement.

EXACT REQUIREMENTS:
- This is a ${size.width}x${size.height} pixel banner ad (${size.name} format)
- Brand name: "${req.brandName}" — must be clearly visible and prominent
- Tagline: "${tagline}" — smaller text below or near the brand name
- CTA button: "${cta}" — a clear call-to-action button
- Color scheme: ${colors}
- Style: ${style}
- The banner must look like a real professional display ad, NOT a photo or illustration
- Clean typography, no clutter
- The brand name should be the focal point
- Include a subtle border or edge definition so the ad is distinguishable on any background
- DO NOT include any placeholder logos or stock imagery — text-based design only
- Make it look like it was designed by a professional advertising agency`;
}

// Map GDN size to closest Gemini aspect ratio
function getGeminiAspect(size: typeof GDN_SIZES[number]): string {
  const ratio = size.width / size.height;
  if (ratio >= 7) return "8:1";
  if (ratio >= 3) return "4:1";
  if (ratio >= 1.7) return "16:9";
  if (ratio >= 1.3) return "4:3";
  if (ratio >= 0.9) return "1:1";
  if (ratio >= 0.6) return "3:4";
  if (ratio >= 0.3) return "1:4";
  return "1:4";
}

export async function generateBanner(
  req: BannerRequest,
  size: typeof GDN_SIZES[number]
): Promise<GeneratedBanner> {
  const prompt = buildPrompt(req, size);
  const aspect = getGeminiAspect(size);

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio: aspect,
          imageSize: "1K",
        },
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];

  for (const part of parts) {
    if (part.inlineData) {
      return {
        width: size.width,
        height: size.height,
        name: size.name,
        base64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || "image/png",
      };
    }
  }

  throw new Error("Gemini did not return an image");
}

// Generate all standard GDN banner sizes
export async function generateAllBanners(
  req: BannerRequest,
  sizes?: typeof GDN_SIZES[number][]
): Promise<GeneratedBanner[]> {
  const targetSizes = sizes || [...GDN_SIZES];
  const results: GeneratedBanner[] = [];

  // Generate sequentially to avoid rate limits
  for (const size of targetSizes) {
    try {
      const banner = await generateBanner(req, size);
      results.push(banner);
    } catch (e) {
      console.error(`Failed to generate ${size.name}:`, e);
      // Continue with other sizes
    }
  }

  return results;
}
