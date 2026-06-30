// ============================================================================
// Country + language catalogue for the Competitor Benchmark Lab.
//
// Each country carries everything the real backend (Oxylabs + SerpApi) needs:
//   - geo:    Oxylabs `geo_location` (country NAME, e.g. "United States") — this
//             decides WHICH country's Google Search SERP is scraped (keyword /
//             extended modes). Changing it changes WHO advertises.
//   - region: SerpApi Transparency Center `region` = the Google geo-target id.
//             VERIFIED LIVE: SerpApi rejects ISO codes ("US" → error) and only
//             accepts the numeric id, which is exactly 2000 + the ISO-3166-1
//             numeric country code (e.g. Brazil 076 → 2076, Japan 392 → 2392).
//             The Transparency lookup is GLOBAL by default (no region sent); the
//             region only filters the company/domain modes when explicitly set.
//   - lang:   the sensible default language for that market (drives the AI report
//             output language; Transparency itself is not language-filtered).
//
// Shared by client (the config form) and server (the proxy). No secrets here.
// ============================================================================

export type Country = {
  code: string; // ISO-2
  name: string; // English display name
  geo: string; // Oxylabs geo_location
  region: string; // SerpApi region (Google geo target constant = 2000 + ISO numeric)
  lang: string; // default language code
  flag: string; // emoji flag for the UI
};

export const COUNTRIES: Country[] = [
  { code: "AF", name: "Afghanistan", geo: "Afghanistan", region: "2004", lang: "en", flag: "🇦🇫" },
  { code: "AL", name: "Albania", geo: "Albania", region: "2008", lang: "en", flag: "🇦🇱" },
  { code: "DZ", name: "Algeria", geo: "Algeria", region: "2012", lang: "ar", flag: "🇩🇿" },
  { code: "AO", name: "Angola", geo: "Angola", region: "2024", lang: "pt", flag: "🇦🇴" },
  { code: "AR", name: "Argentina", geo: "Argentina", region: "2032", lang: "es", flag: "🇦🇷" },
  { code: "AM", name: "Armenia", geo: "Armenia", region: "2051", lang: "en", flag: "🇦🇲" },
  { code: "AU", name: "Australia", geo: "Australia", region: "2036", lang: "en", flag: "🇦🇺" },
  { code: "AT", name: "Austria", geo: "Austria", region: "2040", lang: "de", flag: "🇦🇹" },
  { code: "AZ", name: "Azerbaijan", geo: "Azerbaijan", region: "2031", lang: "en", flag: "🇦🇿" },
  { code: "BH", name: "Bahrain", geo: "Bahrain", region: "2048", lang: "ar", flag: "🇧🇭" },
  { code: "BD", name: "Bangladesh", geo: "Bangladesh", region: "2050", lang: "en", flag: "🇧🇩" },
  { code: "BY", name: "Belarus", geo: "Belarus", region: "2112", lang: "ru", flag: "🇧🇾" },
  { code: "BE", name: "Belgium", geo: "Belgium", region: "2056", lang: "fr", flag: "🇧🇪" },
  { code: "BO", name: "Bolivia", geo: "Bolivia", region: "2068", lang: "es", flag: "🇧🇴" },
  { code: "BA", name: "Bosnia and Herzegovina", geo: "Bosnia and Herzegovina", region: "2070", lang: "en", flag: "🇧🇦" },
  { code: "BR", name: "Brazil", geo: "Brazil", region: "2076", lang: "pt", flag: "🇧🇷" },
  { code: "BG", name: "Bulgaria", geo: "Bulgaria", region: "2100", lang: "bg", flag: "🇧🇬" },
  { code: "KH", name: "Cambodia", geo: "Cambodia", region: "2116", lang: "en", flag: "🇰🇭" },
  { code: "CM", name: "Cameroon", geo: "Cameroon", region: "2120", lang: "fr", flag: "🇨🇲" },
  { code: "CA", name: "Canada", geo: "Canada", region: "2124", lang: "en", flag: "🇨🇦" },
  { code: "CL", name: "Chile", geo: "Chile", region: "2152", lang: "es", flag: "🇨🇱" },
  { code: "CN", name: "China", geo: "China", region: "2156", lang: "zh", flag: "🇨🇳" },
  { code: "CO", name: "Colombia", geo: "Colombia", region: "2170", lang: "es", flag: "🇨🇴" },
  { code: "CR", name: "Costa Rica", geo: "Costa Rica", region: "2188", lang: "es", flag: "🇨🇷" },
  { code: "CI", name: "Cote d'Ivoire", geo: "Cote d'Ivoire", region: "2384", lang: "fr", flag: "🇨🇮" },
  { code: "HR", name: "Croatia", geo: "Croatia", region: "2191", lang: "hr", flag: "🇭🇷" },
  { code: "CU", name: "Cuba", geo: "Cuba", region: "2192", lang: "es", flag: "🇨🇺" },
  { code: "CY", name: "Cyprus", geo: "Cyprus", region: "2196", lang: "el", flag: "🇨🇾" },
  { code: "CZ", name: "Czechia", geo: "Czechia", region: "2203", lang: "cs", flag: "🇨🇿" },
  { code: "DK", name: "Denmark", geo: "Denmark", region: "2208", lang: "da", flag: "🇩🇰" },
  { code: "DO", name: "Dominican Republic", geo: "Dominican Republic", region: "2214", lang: "es", flag: "🇩🇴" },
  { code: "EC", name: "Ecuador", geo: "Ecuador", region: "2218", lang: "es", flag: "🇪🇨" },
  { code: "EG", name: "Egypt", geo: "Egypt", region: "2818", lang: "ar", flag: "🇪🇬" },
  { code: "SV", name: "El Salvador", geo: "El Salvador", region: "2222", lang: "es", flag: "🇸🇻" },
  { code: "EE", name: "Estonia", geo: "Estonia", region: "2233", lang: "et", flag: "🇪🇪" },
  { code: "ET", name: "Ethiopia", geo: "Ethiopia", region: "2231", lang: "en", flag: "🇪🇹" },
  { code: "FI", name: "Finland", geo: "Finland", region: "2246", lang: "fi", flag: "🇫🇮" },
  { code: "FR", name: "France", geo: "France", region: "2250", lang: "fr", flag: "🇫🇷" },
  { code: "GE", name: "Georgia", geo: "Georgia", region: "2268", lang: "en", flag: "🇬🇪" },
  { code: "DE", name: "Germany", geo: "Germany", region: "2276", lang: "de", flag: "🇩🇪" },
  { code: "GH", name: "Ghana", geo: "Ghana", region: "2288", lang: "en", flag: "🇬🇭" },
  { code: "GR", name: "Greece", geo: "Greece", region: "2300", lang: "el", flag: "🇬🇷" },
  { code: "GT", name: "Guatemala", geo: "Guatemala", region: "2320", lang: "es", flag: "🇬🇹" },
  { code: "HN", name: "Honduras", geo: "Honduras", region: "2340", lang: "es", flag: "🇭🇳" },
  { code: "HK", name: "Hong Kong", geo: "Hong Kong", region: "2344", lang: "zh", flag: "🇭🇰" },
  { code: "HU", name: "Hungary", geo: "Hungary", region: "2348", lang: "hu", flag: "🇭🇺" },
  { code: "IS", name: "Iceland", geo: "Iceland", region: "2352", lang: "en", flag: "🇮🇸" },
  { code: "IN", name: "India", geo: "India", region: "2356", lang: "en", flag: "🇮🇳" },
  { code: "ID", name: "Indonesia", geo: "Indonesia", region: "2360", lang: "id", flag: "🇮🇩" },
  { code: "IQ", name: "Iraq", geo: "Iraq", region: "2368", lang: "ar", flag: "🇮🇶" },
  { code: "IE", name: "Ireland", geo: "Ireland", region: "2372", lang: "en", flag: "🇮🇪" },
  { code: "IL", name: "Israel", geo: "Israel", region: "2376", lang: "he", flag: "🇮🇱" },
  { code: "IT", name: "Italy", geo: "Italy", region: "2380", lang: "it", flag: "🇮🇹" },
  { code: "JM", name: "Jamaica", geo: "Jamaica", region: "2388", lang: "en", flag: "🇯🇲" },
  { code: "JP", name: "Japan", geo: "Japan", region: "2392", lang: "ja", flag: "🇯🇵" },
  { code: "JO", name: "Jordan", geo: "Jordan", region: "2400", lang: "ar", flag: "🇯🇴" },
  { code: "KZ", name: "Kazakhstan", geo: "Kazakhstan", region: "2398", lang: "ru", flag: "🇰🇿" },
  { code: "KE", name: "Kenya", geo: "Kenya", region: "2404", lang: "en", flag: "🇰🇪" },
  { code: "KW", name: "Kuwait", geo: "Kuwait", region: "2414", lang: "ar", flag: "🇰🇼" },
  { code: "LV", name: "Latvia", geo: "Latvia", region: "2428", lang: "lv", flag: "🇱🇻" },
  { code: "LB", name: "Lebanon", geo: "Lebanon", region: "2422", lang: "ar", flag: "🇱🇧" },
  { code: "LT", name: "Lithuania", geo: "Lithuania", region: "2440", lang: "lt", flag: "🇱🇹" },
  { code: "LU", name: "Luxembourg", geo: "Luxembourg", region: "2442", lang: "fr", flag: "🇱🇺" },
  { code: "MY", name: "Malaysia", geo: "Malaysia", region: "2458", lang: "ms", flag: "🇲🇾" },
  { code: "MT", name: "Malta", geo: "Malta", region: "2470", lang: "en", flag: "🇲🇹" },
  { code: "MX", name: "Mexico", geo: "Mexico", region: "2484", lang: "es", flag: "🇲🇽" },
  { code: "MD", name: "Moldova", geo: "Moldova", region: "2498", lang: "ro", flag: "🇲🇩" },
  { code: "MC", name: "Monaco", geo: "Monaco", region: "2492", lang: "fr", flag: "🇲🇨" },
  { code: "MA", name: "Morocco", geo: "Morocco", region: "2504", lang: "ar", flag: "🇲🇦" },
  { code: "NP", name: "Nepal", geo: "Nepal", region: "2524", lang: "en", flag: "🇳🇵" },
  { code: "NL", name: "Netherlands", geo: "Netherlands", region: "2528", lang: "nl", flag: "🇳🇱" },
  { code: "NZ", name: "New Zealand", geo: "New Zealand", region: "2554", lang: "en", flag: "🇳🇿" },
  { code: "NI", name: "Nicaragua", geo: "Nicaragua", region: "2558", lang: "es", flag: "🇳🇮" },
  { code: "NG", name: "Nigeria", geo: "Nigeria", region: "2566", lang: "en", flag: "🇳🇬" },
  { code: "NO", name: "Norway", geo: "Norway", region: "2578", lang: "no", flag: "🇳🇴" },
  { code: "OM", name: "Oman", geo: "Oman", region: "2512", lang: "ar", flag: "🇴🇲" },
  { code: "PK", name: "Pakistan", geo: "Pakistan", region: "2586", lang: "en", flag: "🇵🇰" },
  { code: "PA", name: "Panama", geo: "Panama", region: "2591", lang: "es", flag: "🇵🇦" },
  { code: "PY", name: "Paraguay", geo: "Paraguay", region: "2600", lang: "es", flag: "🇵🇾" },
  { code: "PE", name: "Peru", geo: "Peru", region: "2604", lang: "es", flag: "🇵🇪" },
  { code: "PH", name: "Philippines", geo: "Philippines", region: "2608", lang: "en", flag: "🇵🇭" },
  { code: "PL", name: "Poland", geo: "Poland", region: "2616", lang: "pl", flag: "🇵🇱" },
  { code: "PT", name: "Portugal", geo: "Portugal", region: "2620", lang: "pt", flag: "🇵🇹" },
  { code: "PR", name: "Puerto Rico", geo: "Puerto Rico", region: "2630", lang: "es", flag: "🇵🇷" },
  { code: "QA", name: "Qatar", geo: "Qatar", region: "2634", lang: "ar", flag: "🇶🇦" },
  { code: "RO", name: "Romania", geo: "Romania", region: "2642", lang: "ro", flag: "🇷🇴" },
  { code: "RU", name: "Russia", geo: "Russia", region: "2643", lang: "ru", flag: "🇷🇺" },
  { code: "SA", name: "Saudi Arabia", geo: "Saudi Arabia", region: "2682", lang: "ar", flag: "🇸🇦" },
  { code: "SN", name: "Senegal", geo: "Senegal", region: "2686", lang: "fr", flag: "🇸🇳" },
  { code: "RS", name: "Serbia", geo: "Serbia", region: "2688", lang: "sr", flag: "🇷🇸" },
  { code: "SG", name: "Singapore", geo: "Singapore", region: "2702", lang: "en", flag: "🇸🇬" },
  { code: "SK", name: "Slovakia", geo: "Slovakia", region: "2703", lang: "sk", flag: "🇸🇰" },
  { code: "SI", name: "Slovenia", geo: "Slovenia", region: "2705", lang: "sl", flag: "🇸🇮" },
  { code: "ZA", name: "South Africa", geo: "South Africa", region: "2710", lang: "en", flag: "🇿🇦" },
  { code: "KR", name: "South Korea", geo: "South Korea", region: "2410", lang: "ko", flag: "🇰🇷" },
  { code: "ES", name: "Spain", geo: "Spain", region: "2724", lang: "es", flag: "🇪🇸" },
  { code: "LK", name: "Sri Lanka", geo: "Sri Lanka", region: "2144", lang: "en", flag: "🇱🇰" },
  { code: "SE", name: "Sweden", geo: "Sweden", region: "2752", lang: "sv", flag: "🇸🇪" },
  { code: "CH", name: "Switzerland", geo: "Switzerland", region: "2756", lang: "de", flag: "🇨🇭" },
  { code: "TW", name: "Taiwan", geo: "Taiwan", region: "2158", lang: "zh", flag: "🇹🇼" },
  { code: "TZ", name: "Tanzania", geo: "Tanzania", region: "2834", lang: "en", flag: "🇹🇿" },
  { code: "TH", name: "Thailand", geo: "Thailand", region: "2764", lang: "th", flag: "🇹🇭" },
  { code: "TN", name: "Tunisia", geo: "Tunisia", region: "2788", lang: "ar", flag: "🇹🇳" },
  { code: "TR", name: "Turkey", geo: "Turkey", region: "2792", lang: "tr", flag: "🇹🇷" },
  { code: "UG", name: "Uganda", geo: "Uganda", region: "2800", lang: "en", flag: "🇺🇬" },
  { code: "UA", name: "Ukraine", geo: "Ukraine", region: "2804", lang: "uk", flag: "🇺🇦" },
  { code: "AE", name: "United Arab Emirates", geo: "United Arab Emirates", region: "2784", lang: "ar", flag: "🇦🇪" },
  { code: "GB", name: "United Kingdom", geo: "United Kingdom", region: "2826", lang: "en", flag: "🇬🇧" },
  { code: "US", name: "United States", geo: "United States", region: "2840", lang: "en", flag: "🇺🇸" },
  { code: "UY", name: "Uruguay", geo: "Uruguay", region: "2858", lang: "es", flag: "🇺🇾" },
  { code: "UZ", name: "Uzbekistan", geo: "Uzbekistan", region: "2860", lang: "ru", flag: "🇺🇿" },
  { code: "VE", name: "Venezuela", geo: "Venezuela", region: "2862", lang: "es", flag: "🇻🇪" },
  { code: "VN", name: "Vietnam", geo: "Vietnam", region: "2704", lang: "vi", flag: "🇻🇳" },
  { code: "ZM", name: "Zambia", geo: "Zambia", region: "2894", lang: "en", flag: "🇿🇲" },
  { code: "ZW", name: "Zimbabwe", geo: "Zimbabwe", region: "2716", lang: "en", flag: "🇿🇼" },
];

export type Language = { code: string; name: string };

export const LANGUAGES: Language[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "pt", name: "Português" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
  { code: "nl", name: "Nederlands" },
  { code: "ar", name: "العربية" },
  { code: "zh", name: "中文" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "ru", name: "Русский" },
  { code: "tr", name: "Türkçe" },
  { code: "pl", name: "Polski" },
  { code: "sv", name: "Svenska" },
  { code: "da", name: "Dansk" },
  { code: "fi", name: "Suomi" },
  { code: "no", name: "Norsk" },
  { code: "el", name: "Ελληνικά" },
  { code: "cs", name: "Čeština" },
  { code: "hu", name: "Magyar" },
  { code: "ro", name: "Română" },
  { code: "th", name: "ไทย" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "ms", name: "Bahasa Melayu" },
  { code: "he", name: "עברית" },
  { code: "uk", name: "Українська" },
  { code: "bg", name: "Български" },
  { code: "hr", name: "Hrvatski" },
  { code: "sk", name: "Slovenčina" },
  { code: "sl", name: "Slovenščina" },
  { code: "et", name: "Eesti" },
  { code: "lv", name: "Latviešu" },
  { code: "lt", name: "Lietuvių" },
  { code: "sr", name: "Srpski" },
];

export const DEFAULT_COUNTRY = "US";

export function findCountry(code: string | null | undefined): Country {
  const hit = COUNTRIES.find((c) => c.code === (code || "").toUpperCase());
  return hit ?? COUNTRIES.find((c) => c.code === DEFAULT_COUNTRY) ?? COUNTRIES[0];
}

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase();
}
