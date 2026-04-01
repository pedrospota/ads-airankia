// Known ad exchange names for display
const EXCHANGE_LABELS: Record<string, string> = {
  "google.com": "Google",
  "appnexus.com": "AppNexus",
  "openx.com": "OpenX",
  "rubiconproject.com": "Rubicon",
  "pubmatic.com": "PubMatic",
  "indexexchange.com": "Index Exchange",
  "amazon-adsystem.com": "Amazon",
  "criteo.com": "Criteo",
  "smartadserver.com": "Smart AdServer",
  "sovrn.com": "Sovrn",
  "triplelift.com": "TripleLift",
  "mediavine.com": "Mediavine",
  "sharethrough.com": "Sharethrough",
  "33across.com": "33Across",
  "yahoo.com": "Yahoo",
  "media.net": "Media.net",
  "outbrain.com": "Outbrain",
  "taboola.com": "Taboola",
  "spotxchange.com": "SpotX",
  "adcolony.com": "AdColony",
  "fyber.com": "Fyber",
  "conversantmedia.com": "Conversant",
  "contextweb.com": "PulsePoint",
  "rhythmone.com": "RhythmOne",
  "yieldmo.com": "Yieldmo",
  "improvedigital.com": "Improve Digital",
  "adform.com": "Adform",
  "teads.tv": "Teads",
  "verizonmedia.com": "Verizon Media",
  "freewheel.tv": "FreeWheel",
  "gumgum.com": "GumGum",
  "kargo.com": "Kargo",
  "undertone.com": "Undertone",
};

export interface AdInventoryResult {
  domain: string;
  hasGdn: boolean;
  gdnPubId: string | null;
  networks: string[];
  detectionMethod: "ads_txt" | "scraping" | "both" | "none";
}

// Parse ads.txt content and extract exchanges
function parseAdsTxt(content: string): { exchanges: Set<string>; gdnPubId: string | null } {
  const exchanges = new Set<string>();
  let gdnPubId: string | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 3) continue;

    const exchange = parts[0].toLowerCase();
    const pubId = parts[1];
    const relationship = parts[2].toUpperCase();

    if (relationship !== "DIRECT" && relationship !== "RESELLER") continue;

    // Map to known label or use raw exchange domain
    const label = EXCHANGE_LABELS[exchange] || exchange;
    exchanges.add(label);

    // Check for Google specifically
    if (exchange === "google.com" && pubId.startsWith("pub-")) {
      gdnPubId = pubId;
    }
  }

  return { exchanges, gdnPubId };
}

// Detect Google ad tags in HTML
function detectAdTagsInHtml(html: string): { hasGoogleAds: boolean; networks: Set<string> } {
  const networks = new Set<string>();
  let hasGoogleAds = false;

  const googlePatterns = [
    "adsbygoogle.js",
    "googletag.js",
    "gpt.js",
    "securepubads.g.doubleclick.net",
    "pagead2.googlesyndication.com",
    "googleads.g.doubleclick.net",
  ];

  for (const pattern of googlePatterns) {
    if (html.includes(pattern)) {
      hasGoogleAds = true;
      networks.add("Google");
      break;
    }
  }

  // Check for other common ad networks in HTML
  const htmlPatterns: [string, string][] = [
    ["amazon-adsystem.com", "Amazon"],
    ["criteo.com/js", "Criteo"],
    ["outbrain.com/outbrain", "Outbrain"],
    ["cdn.taboola.com", "Taboola"],
    ["media.net/dmedianet", "Media.net"],
    ["pubmatic.com", "PubMatic"],
    ["rubiconproject.com", "Rubicon"],
  ];

  for (const [pattern, label] of htmlPatterns) {
    if (html.includes(pattern)) {
      networks.add(label);
    }
  }

  // Extract Google pub ID from HTML
  const pubMatch = html.match(/ca-pub-(\d+)/);

  return { hasGoogleAds, networks };
}

// Detect YouTube URL type
export function parseYouTubeUrl(url: string): { type: "video" | "short" | "channel" | "none"; id: string | null } {
  const u = url.toLowerCase();
  // Video: youtube.com/watch?v=XXX or youtu.be/XXX
  const videoMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/i);
  if (videoMatch) return { type: "video", id: videoMatch[1] };
  // Shorts: youtube.com/shorts/XXX
  const shortsMatch = url.match(/youtube\.com\/shorts\/([\w-]+)/i);
  if (shortsMatch) return { type: "short", id: shortsMatch[1] };
  // Channel: youtube.com/@handle or /channel/XXX or /c/XXX
  const channelMatch = url.match(/youtube\.com\/(?:@|channel\/|c\/)([\w-]+)/i);
  if (channelMatch) return { type: "channel", id: channelMatch[1] };
  return { type: "none", id: null };
}

export function isYouTubeDomain(domain: string): boolean {
  const d = domain.replace(/^www\./, "").replace(/^m\./, "").toLowerCase();
  return d === "youtube.com" || d === "youtu.be";
}

// Check a single domain for ad inventory
export async function checkDomain(domain: string): Promise<AdInventoryResult> {
  const clean = domain.replace(/^www\./, "").replace(/^m\./, "").toLowerCase();

  // YouTube is ALWAYS targetable — skip ads.txt check entirely
  if (isYouTubeDomain(clean)) {
    return {
      domain: clean,
      hasGdn: true,
      gdnPubId: null,
      networks: ["YouTube", "Google"],
      detectionMethod: "ads_txt", // known
    };
  }

  let gdnPubId: string | null = null;
  let allNetworks = new Set<string>();
  let method: AdInventoryResult["detectionMethod"] = "none";
  let hasGdn = false;
  let adsTxtWorked = false;

  // Step 1: Try ads.txt
  for (const prefix of [`https://${clean}`, `https://www.${clean}`]) {
    try {
      const resp = await fetch(`${prefix}/ads.txt`, {
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AdsAirankiaBot/1.0)" },
        redirect: "follow",
      });

      if (resp.ok) {
        const text = await resp.text();
        // Basic sanity check — ads.txt should be text, not HTML
        if (!text.includes("<html") && !text.includes("<!DOCTYPE")) {
          const { exchanges, gdnPubId: pubId } = parseAdsTxt(text);
          if (exchanges.size > 0) {
            adsTxtWorked = true;
            allNetworks = exchanges;
            if (pubId) {
              gdnPubId = pubId;
              hasGdn = true;
            }
            method = "ads_txt";
            break;
          }
        }
      }
    } catch {
      // timeout or network error — continue to fallback
    }
  }

  // Step 2: Fallback — scrape homepage for ad tags
  if (!adsTxtWorked) {
    try {
      const resp = await fetch(`https://${clean}`, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
        redirect: "follow",
      });

      if (resp.ok) {
        const html = await resp.text();
        const { hasGoogleAds, networks } = detectAdTagsInHtml(html);
        if (hasGoogleAds || networks.size > 0) {
          hasGdn = hasGoogleAds;
          allNetworks = networks;
          method = adsTxtWorked ? "both" : "scraping";

          // Try to extract pub ID from HTML
          const pubMatch = html.match(/ca-pub-(\d+)/);
          if (pubMatch) gdnPubId = `pub-${pubMatch[1]}`;
        }
      }
    } catch {
      // timeout or network error
    }
  }

  return {
    domain: clean,
    hasGdn,
    gdnPubId,
    networks: Array.from(allNetworks).sort(),
    detectionMethod: method,
  };
}

// Check multiple domains in parallel
export async function checkDomains(domains: string[]): Promise<AdInventoryResult[]> {
  const unique = [...new Set(domains.map((d) => d.replace(/^www\./, "").toLowerCase()))];
  const results = await Promise.allSettled(unique.map(checkDomain));
  return results
    .filter((r): r is PromiseFulfilledResult<AdInventoryResult> => r.status === "fulfilled")
    .map((r) => r.value);
}
