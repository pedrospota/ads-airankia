// ============================================================================
// Page fetch + tracking/UTM extraction (FREE — just fetching a public page and
// parsing the HTML we already have). Used to tear down a competitor's landing
// page: we hand the visible text to the LLM and mine the raw HTML for the
// marketing stack (pixels, GTM/GA/Ads ids) and any UTM-tagged links.
// ============================================================================

import type { TrackingStack } from "./types";

export interface FetchedPage {
  url: string;
  status: number | null;
  ok: boolean;
  title: string;
  html: string;
  /** Visible text, tag-stripped and collapsed, capped for prompt safety. */
  text: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function toDomain(input: string): string | null {
  try {
    const u = new URL(input.startsWith("http") ? input : `https://${input}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The brand's competitor list for the benchmark. PREFERS `brand_project
 * .competitor_profiles` (jsonb of {name, domain, source}) — the structured,
 * domain-bearing list the main app keeps current from its audit — and falls back
 * to the legacy free-text `competitors` array only when profiles are absent.
 * Returns the best identifier per competitor (its domain when present, else name).
 */
export function brandCompetitorList(
  competitorProfiles: unknown,
  competitorsArray: unknown
): string[] {
  if (Array.isArray(competitorProfiles) && competitorProfiles.length) {
    const out = competitorProfiles
      .map((c) => {
        if (c && typeof c === "object") {
          const o = c as Record<string, unknown>;
          const domain = typeof o.domain === "string" ? o.domain.trim() : "";
          const name = typeof o.name === "string" ? o.name.trim() : "";
          return domain || name;
        }
        return typeof c === "string" ? c.trim() : "";
      })
      .filter(Boolean);
    if (out.length) return [...new Set(out)];
  }
  return Array.isArray(competitorsArray)
    ? [
        ...new Set(
          competitorsArray
            .map((c) => (typeof c === "string" ? c.trim() : ""))
            .filter(Boolean)
        ),
      ]
    : [];
}

export function toUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return u.toString();
  } catch {
    return null;
  }
}

/** Fetch a page with a hard timeout. Never throws — returns ok:false on failure. */
export async function fetchPage(
  input: string,
  timeoutMs = 12000
): Promise<FetchedPage> {
  const url = toUrl(input);
  const base: FetchedPage = {
    url: url ?? input,
    status: null,
    ok: false,
    title: "",
    html: "",
    text: "",
  };
  if (!url) return base;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      redirect: "follow",
    });
    base.status = resp.status;
    base.ok = resp.ok;
    if (!resp.ok) return base;

    const html = await resp.text();
    base.html = html;

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) base.title = decodeEntities(titleMatch[1].trim());

    base.text = htmlToText(html).slice(0, 9000);
    return base;
  } catch {
    return base; // timeout / DNS / TLS — caller treats as a soft miss
  }
}

/** Crude but dependency-free: drop script/style, strip tags, collapse space. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * Mine the raw HTML for the marketing/analytics stack and any UTM-tagged links.
 * Pure string scanning over already-fetched bytes — no extra requests, no cost.
 */
export function extractTracking(html: string): TrackingStack {
  const pixels: string[] = [];

  const gtmIds = uniq([...html.matchAll(/GTM-[A-Z0-9]{4,9}/g)].map((m) => m[0]));
  // GA4 (G-XXXX) + legacy UA (UA-XXXX-Y) + Ads conversion (AW-XXXX).
  const gaIds = uniq([
    ...[...html.matchAll(/\bG-[A-Z0-9]{6,12}\b/g)].map((m) => m[0]),
    ...[...html.matchAll(/\bUA-\d{4,12}-\d{1,4}\b/g)].map((m) => m[0]),
  ]);
  const adsConversionIds = uniq(
    [...html.matchAll(/\bAW-\d{6,14}\b/g)].map((m) => m[0])
  );

  if (gtmIds.length) pixels.push("Google Tag Manager");
  if (gaIds.length || /gtag\(/.test(html) || /googletagmanager\.com\/gtag/.test(html))
    pixels.push("Google Analytics / gtag");
  if (adsConversionIds.length || /googleadservices\.com|google_conversion/.test(html))
    pixels.push("Google Ads conversion");
  if (/connect\.facebook\.net|fbq\(|facebook\.com\/tr/.test(html))
    pixels.push("Meta Pixel");
  if (/analytics\.tiktok\.com|ttq\./.test(html)) pixels.push("TikTok Pixel");
  if (/snap\.licdn\.com|_linkedin_partner_id/.test(html))
    pixels.push("LinkedIn Insight");
  if (/static\.hotjar\.com|hj\(/.test(html)) pixels.push("Hotjar");
  if (/clarity\.ms/.test(html)) pixels.push("Microsoft Clarity");
  if (/cdn\.segment\.com|analytics\.track/.test(html)) pixels.push("Segment");
  if (/sc-static\.net|snaptr\(/.test(html)) pixels.push("Snap Pixel");

  // UTM params on any href in the page (key → first sample value seen).
  const utmMap = new Map<string, string>();
  for (const m of html.matchAll(/[?&](utm_[a-z]+)=([^"'&\s>]+)/gi)) {
    const key = m[1].toLowerCase();
    if (!utmMap.has(key)) {
      try {
        utmMap.set(key, decodeURIComponent(m[2]).slice(0, 60));
      } catch {
        utmMap.set(key, m[2].slice(0, 60));
      }
    }
  }
  const utmParams = [...utmMap.entries()].map(([key, value]) => ({ key, value }));

  return {
    utmParams,
    pixels: uniq(pixels),
    hasGtm: gtmIds.length > 0,
    gtmIds,
    gaIds,
    adsConversionIds,
  };
}
