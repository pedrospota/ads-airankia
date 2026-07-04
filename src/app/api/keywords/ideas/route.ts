import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import {
  generateKeywordIdeas,
  type KeywordPlanIdea,
  type KeywordPlannerError,
} from "@/lib/google-ads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Countries offered by the PPC Keyword Tool. Every code exists in the
// GEO_TARGET_CONSTANTS map inside google-ads.ts; validating here means an
// unsupported code fails loudly instead of silently falling back to Spain.
const SUPPORTED_COUNTRIES = new Set(["MX", "ES", "US", "AR", "CO", "CL", "PE"]);

const MAX_SEEDS = 20; // KeywordPlanIdeaService caps keyword seeds at 20

// Readable Spanish warning for the UI when neither Google's Keyword Planner
// nor the DataForSEO fallback could serve metrics (results may be empty).
function warningFor(e: KeywordPlannerError): string {
  switch (e.kind) {
    case "access":
      return "La API de Google Ads aún no tiene acceso al Keyword Planner y el proveedor alternativo no devolvió datos. Los resultados pueden estar vacíos o incompletos.";
    case "quota":
      return "Se alcanzó la cuota diaria del Keyword Planner y el proveedor alternativo no devolvió datos. Vuelve a intentarlo cuando se restablezca la cuota.";
    case "network":
      return "No se pudo conectar con el Keyword Planner. Los resultados pueden estar vacíos o incompletos — inténtalo de nuevo en unos minutos.";
    default:
      return "La consulta al Keyword Planner falló. Los resultados pueden estar vacíos o incompletos.";
  }
}

// POST /api/keywords/ideas
// Body: { seeds?: string[], url?: string, language?: "es"|"en", country?: string }
// → { ideas: KeywordPlanIdea[], warning?: string }
// Ideas come from the Keyword Planner credential (with a silent DataForSEO
// fallback) — see generateKeywordIdeas in @/lib/google-ads. Nothing about the
// credentials is ever exposed to the client.
export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "Inicia sesión para usar esta herramienta." },
      { status: 401 }
    );
  }

  let body: {
    seeds?: unknown;
    url?: unknown;
    language?: unknown;
    country?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "El cuerpo de la petición no es JSON válido." },
      { status: 400 }
    );
  }

  // Seeds: array of non-empty strings, deduped case-insensitively.
  if (body.seeds !== undefined && !Array.isArray(body.seeds)) {
    return NextResponse.json(
      { error: "`seeds` debe ser una lista de palabras clave." },
      { status: 400 }
    );
  }
  const seen = new Set<string>();
  const seeds = (Array.isArray(body.seeds) ? body.seeds : [])
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (seeds.length > MAX_SEEDS) {
    return NextResponse.json(
      { error: `Máximo ${MAX_SEEDS} palabras clave semilla — el Keyword Planner no admite más.` },
      { status: 400 }
    );
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (seeds.length === 0 && !url) {
    return NextResponse.json(
      { error: "Escribe al menos una palabra clave semilla o una URL para empezar." },
      { status: 400 }
    );
  }

  // Language: this tool offers Spanish (default) and English only.
  let language: "es" | "en" = "es";
  if (body.language !== undefined) {
    if (body.language !== "es" && body.language !== "en") {
      return NextResponse.json(
        { error: 'Idioma no soportado — usa "es" o "en".' },
        { status: 400 }
      );
    }
    language = body.language;
  }

  // Country: default México; must be one of the supported markets.
  let country = "MX";
  if (typeof body.country === "string" && body.country.trim()) {
    const c = body.country.trim().toUpperCase();
    if (!SUPPORTED_COUNTRIES.has(c)) {
      return NextResponse.json(
        { error: `País no soportado: ${c}. Usa uno de: ${[...SUPPORTED_COUNTRIES].join(", ")}.` },
        { status: 400 }
      );
    }
    country = c;
  }

  // Capture planner errors via the callback. An array (instead of a `let`)
  // keeps TypeScript's narrowing honest after the closure assignment.
  // onError only fires when neither Google's planner nor the DataForSEO
  // fallback could serve data — generateKeywordIdeas never throws to us.
  const plannerErrors: KeywordPlannerError[] = [];
  let ideas: KeywordPlanIdea[] = [];
  try {
    ideas = await generateKeywordIdeas({
      keywordSeeds: seeds.length > 0 ? seeds : undefined,
      urlSeed: url || undefined,
      languageCode: language,
      countryCodes: [country],
      costContext: { userId: user.id },
      onError: (e) => plannerErrors.push(e),
    });
  } catch {
    // Defensive: never leak provider internals to the client.
    return NextResponse.json(
      { error: "No se pudieron obtener ideas de palabras clave en este momento." },
      { status: 502 }
    );
  }

  const plannerError = plannerErrors[0];
  return NextResponse.json({
    ideas,
    ...(plannerError ? { warning: warningFor(plannerError) } : {}),
  });
}
