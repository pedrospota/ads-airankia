// Scrape brand website to extract: logo, colors, description, OG images

export interface BrandProfile {
  title: string;
  description: string;
  ogImage: string | null;
  logo: string | null;
  favicon: string | null;
  colors: string[];
  keywords: string[];
}

export async function scrapeBrandWebsite(url: string): Promise<BrandProfile> {
  const profile: BrandProfile = {
    title: "", description: "", ogImage: null, logo: null, favicon: null, colors: [], keywords: [],
  };

  try {
    const base = url.startsWith("http") ? url : `https://${url}`;
    const resp = await fetch(base, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      redirect: "follow",
    });

    if (!resp.ok) return profile;
    const html = await resp.text();
    const origin = new URL(base).origin;

    // Title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) profile.title = titleMatch[1].trim();

    // Meta description
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    if (descMatch) profile.description = descMatch[1].trim();

    // OG image
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch) {
      profile.ogImage = ogMatch[1].startsWith("http") ? ogMatch[1] : `${origin}${ogMatch[1]}`;
    }

    // OG description fallback
    if (!profile.description) {
      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
      if (ogDesc) profile.description = ogDesc[1].trim();
    }

    // Logo - look for common patterns
    const logoPatterns = [
      /<img[^>]+class=["'][^"']*logo[^"']*["'][^>]+src=["']([^"']+)["']/i,
      /<img[^>]+alt=["'][^"']*logo[^"']*["'][^>]+src=["']([^"']+)["']/i,
      /<img[^>]+src=["']([^"']+logo[^"']+)["']/i,
      /<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/i,
    ];
    for (const pattern of logoPatterns) {
      const match = html.match(pattern);
      if (match) {
        const src = match[1];
        profile.logo = src.startsWith("http") ? src : `${origin}${src.startsWith("/") ? "" : "/"}${src}`;
        break;
      }
    }

    // Favicon
    const faviconMatch = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i);
    if (faviconMatch) {
      const src = faviconMatch[1];
      profile.favicon = src.startsWith("http") ? src : `${origin}${src.startsWith("/") ? "" : "/"}${src}`;
    }

    // Extract colors from inline styles and CSS
    const colorMatches = html.matchAll(/#[0-9a-fA-F]{6}\b/g);
    const colorSet = new Set<string>();
    for (const m of colorMatches) {
      colorSet.add(m[0].toUpperCase());
      if (colorSet.size >= 10) break;
    }
    profile.colors = [...colorSet];

    // Keywords
    const kwMatch = html.match(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']+)["']/i);
    if (kwMatch) profile.keywords = kwMatch[1].split(",").map((k) => k.trim()).filter(Boolean).slice(0, 10);

  } catch {
    // scraping failed — return empty profile
  }

  return profile;
}
