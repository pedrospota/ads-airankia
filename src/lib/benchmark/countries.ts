// ============================================================================
// Country + language catalogue for the Competitor Benchmark Lab.
//
// Each country carries everything the real backend (Oxylabs + SerpApi) needs:
//   - geo:    Oxylabs `geo_location` (country NAME, e.g. "United States")
//   - region: SerpApi Transparency Center `region` (Google geo-target id)
//   - lang:   the sensible default language for that market
//
// Shared by client (the config form) and server (the proxy). No secrets here.
// ============================================================================

export type Country = {
  code: string; // ISO-2
  name: string; // English display name
  geo: string; // Oxylabs geo_location
  region: string; // SerpApi region (Google geo target constant)
  lang: string; // default language code
  flag: string; // emoji flag for the UI
};

export const COUNTRIES: Country[] = [
  { code: "US", name: "United States", geo: "United States", region: "2840", lang: "en", flag: "🇺🇸" },
  { code: "ES", name: "Spain", geo: "Spain", region: "2724", lang: "es", flag: "🇪🇸" },
  { code: "MX", name: "Mexico", geo: "Mexico", region: "2484", lang: "es", flag: "🇲🇽" },
  { code: "GB", name: "United Kingdom", geo: "United Kingdom", region: "2826", lang: "en", flag: "🇬🇧" },
  { code: "CA", name: "Canada", geo: "Canada", region: "2124", lang: "en", flag: "🇨🇦" },
  { code: "AU", name: "Australia", geo: "Australia", region: "2036", lang: "en", flag: "🇦🇺" },
  { code: "FR", name: "France", geo: "France", region: "2250", lang: "fr", flag: "🇫🇷" },
  { code: "DE", name: "Germany", geo: "Germany", region: "2276", lang: "de", flag: "🇩🇪" },
  { code: "IT", name: "Italy", geo: "Italy", region: "2380", lang: "it", flag: "🇮🇹" },
  { code: "PT", name: "Portugal", geo: "Portugal", region: "2620", lang: "pt", flag: "🇵🇹" },
  { code: "NL", name: "Netherlands", geo: "Netherlands", region: "2528", lang: "nl", flag: "🇳🇱" },
  { code: "AR", name: "Argentina", geo: "Argentina", region: "2032", lang: "es", flag: "🇦🇷" },
  { code: "CO", name: "Colombia", geo: "Colombia", region: "2170", lang: "es", flag: "🇨🇴" },
  { code: "CL", name: "Chile", geo: "Chile", region: "2152", lang: "es", flag: "🇨🇱" },
  { code: "BR", name: "Brazil", geo: "Brazil", region: "2076", lang: "pt", flag: "🇧🇷" },
];

export type Language = { code: string; name: string };

export const LANGUAGES: Language[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "nl", name: "Nederlands" },
];

export const DEFAULT_COUNTRY = "US";

export function findCountry(code: string | null | undefined): Country {
  const hit = COUNTRIES.find((c) => c.code === (code || "").toUpperCase());
  return hit ?? COUNTRIES[0];
}

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase();
}
