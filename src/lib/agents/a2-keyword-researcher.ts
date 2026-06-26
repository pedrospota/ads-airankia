// ============================================================================
// A2 — KEYWORD RESEARCHER (Investigador de keywords)
// ----------------------------------------------------------------------------
// Second agent in the Search pipeline. From the Planner's themes + geo/language
// it builds the curated keyword list (text, match type, theme mapping, intent,
// relevance + composite score, source, rationale) and a STRONG negative list
// (free_seeker, wrong_intent, wrong_geo, competitor, ...).
//
// Real metrics first: we call the Google Ads KeywordPlanIdeaService with the
// theme/brand seeds + the landing page URL. If it returns ideas, we attach the
// real avgMonthlySearches / competition / top-of-page bid micros to the LLM
// keyword list by matching text (case-insensitive) and set
// metricsSource = 'google_keyword_planner'. If it returns [] or throws, we keep
// the LLM's own estimates and set metricsSource = 'llm_estimate'.
//
// Model: Sonnet (high-volume agent). Output mirrors KeywordResearchOutput from
// the FROZEN contract EXACTLY.
//
// Persists ONE keyword_research_runs row (seeds, sources, totalIdeas, kept,
// summarized raw). It does NOT write the keywords table — A3 owns keyword rows.
// ============================================================================

import {
  type AgentDefinition,
  type AgentResult,
  type AgentHelpers,
  type RunContext,
  type KeywordResearchOutput,
  type KeywordIdea,
} from "@/lib/engine/types";
import { callStructured, LLMError, defaultAnthropicModel } from "@/lib/llm";
import { generateKeywordIdeas, type KeywordPlanIdea } from "@/lib/google-ads";
import { adsDb } from "@/lib/ads-db";
import { keywordResearchRuns } from "@/lib/schema";

const PROMPT_VERSION = "a2-keyword-researcher-v1";
const TEMPERATURE = 0.5;

// ----------------------------------------------------------------------------
// JSON schema — mirrors KeywordResearchOutput from types.ts EXACTLY.
// ----------------------------------------------------------------------------

const INTENT_ENUM = [
  "brand",
  "transactional",
  "commercial",
  "informational",
  "competitor",
  "local",
] as const;

const MATCH_TYPE_ENUM = ["EXACT", "PHRASE", "BROAD"] as const;

const COMPETITION_ENUM = ["LOW", "MEDIUM", "HIGH"] as const;

const NEGATIVE_CLASS_ENUM = [
  "free_seeker",
  "wrong_intent",
  "wrong_geo",
  "competitor",
  "brand_cross",
  "cross_group",
] as const;

const NEGATIVE_SCOPE_ENUM = ["campaign", "ad_group", "shared"] as const;

const KEYWORD_RESEARCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["keywords", "negatives", "metricsSource", "notes"],
  properties: {
    keywords: {
      type: "array",
      minItems: 1,
      description:
        "Curated keyword list across ALL planner themes (≈10-25 por tema), con tipos de concordancia mezclados.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "matchType", "theme", "intent", "source"],
        properties: {
          text: {
            type: "string",
            description:
              "El término de búsqueda en minúsculas, sin operadores de concordancia (sin comillas ni corchetes).",
          },
          matchType: {
            type: "string",
            enum: MATCH_TYPE_ENUM,
            description:
              "EXACT para términos de alta intención/marca, PHRASE para intención media, BROAD solo con Smart Bidding y vigilada con negativas.",
          },
          theme: {
            type: "string",
            description:
              "Nombre EXACTO del tema del Planner (PlannerTheme.name) al que pertenece esta keyword.",
          },
          intent: { type: "string", enum: INTENT_ENUM },
          avgMonthlySearches: {
            type: "number",
            description:
              "Búsquedas medias mensuales estimadas. Si no hay datos reales, tu mejor estimación.",
          },
          competition: {
            type: "string",
            enum: COMPETITION_ENUM,
            description: "Competencia estimada (LOW/MEDIUM/HIGH).",
          },
          topOfPageBidLowMicros: {
            type: "number",
            description: "Puja estimada parte baja del rango (en micros).",
          },
          topOfPageBidHighMicros: {
            type: "number",
            description: "Puja estimada parte alta del rango (en micros).",
          },
          relevanceScore: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description:
              "Relevancia 0..1 respecto al negocio y la landing (1 = encaje perfecto).",
          },
          score: {
            type: "number",
            description:
              "Puntuación compuesta (volumen × intención × relevancia × asequibilidad). Úsala para priorizar.",
          },
          source: {
            type: "string",
            description:
              "Origen de la idea: keyword_seed | url_seed | citation | llm | search_term | historical.",
          },
          rationale: {
            type: "string",
            description: "Una frase en español que justifica por qué entra esta keyword.",
          },
        },
      },
    },
    negatives: {
      type: "array",
      minItems: 15,
      description:
        "Lista fuerte de palabras clave negativas (≥15) para proteger el presupuesto desde el día 1.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "matchType", "negativeClass"],
        properties: {
          text: {
            type: "string",
            description: "Término negativo en minúsculas (sin operadores).",
          },
          matchType: {
            type: "string",
            enum: MATCH_TYPE_ENUM,
            description:
              "Tipo de concordancia de la negativa (normalmente PHRASE o EXACT).",
          },
          negativeClass: {
            type: "string",
            enum: NEGATIVE_CLASS_ENUM,
            description:
              "Por qué es negativa: free_seeker (gratis/barato), wrong_intent, wrong_geo, competitor, brand_cross, cross_group.",
          },
          scope: {
            type: "string",
            enum: NEGATIVE_SCOPE_ENUM,
            description:
              "Alcance sugerido: campaign (recomendado para la mayoría), ad_group o shared.",
          },
        },
      },
    },
    metricsSource: {
      type: "string",
      enum: ["google_keyword_planner", "llm_estimate"],
      description:
        "Pon SIEMPRE 'llm_estimate'. El código lo cambia a 'google_keyword_planner' si adjunta métricas reales.",
    },
    notes: {
      type: "string",
      description:
        "Notas en español sencillo para el dueño del negocio: lógica de selección, riesgos y recomendaciones.",
    },
  },
};

// ----------------------------------------------------------------------------
// Seeds — derive keyword seeds for the Keyword Planner from the planner output.
// ----------------------------------------------------------------------------

function buildKeywordSeeds(ctx: RunContext): string[] {
  const seeds = new Set<string>();
  const planner = ctx.planner;
  if (planner) {
    for (const theme of planner.themes) {
      const name = theme.name?.trim();
      if (name) seeds.add(name.toLowerCase());
    }
  }
  const brandName = ctx.brand.brandName?.trim();
  if (brandName) seeds.add(brandName.toLowerCase());
  return [...seeds];
}

function landingSeed(ctx: RunContext): string | undefined {
  return (
    ctx.brand.landingPageUrl?.trim() ||
    ctx.brand.brandWebsite?.trim() ||
    undefined
  );
}

// ----------------------------------------------------------------------------
// Attach real Keyword Planner metrics to the LLM keyword list by text match.
// ----------------------------------------------------------------------------

function attachMetrics(
  keywords: KeywordIdea[],
  ideas: KeywordPlanIdea[]
): { keywords: KeywordIdea[]; matched: number } {
  const byText = new Map<string, KeywordPlanIdea>();
  for (const idea of ideas) {
    byText.set(idea.text.trim().toLowerCase(), idea);
  }

  let matched = 0;
  const enriched = keywords.map((kw) => {
    const hit = byText.get(kw.text.trim().toLowerCase());
    if (!hit) return kw;
    matched++;
    const competition =
      hit.competition === "LOW" ||
      hit.competition === "MEDIUM" ||
      hit.competition === "HIGH"
        ? hit.competition
        : kw.competition;
    return {
      ...kw,
      avgMonthlySearches: hit.avgMonthlySearches,
      competition,
      topOfPageBidLowMicros:
        hit.topOfPageBidLowMicros ?? kw.topOfPageBidLowMicros,
      topOfPageBidHighMicros:
        hit.topOfPageBidHighMicros ?? kw.topOfPageBidHighMicros,
      source: "keyword_seed",
    } satisfies KeywordIdea;
  });

  return { keywords: enriched, matched };
}

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "Eres el mejor especialista en Google Ads (Search) del mundo para investigación",
    "de palabras clave, con dominio nativo del español y de cómo busca de verdad la",
    "gente en España y Latinoamérica. Piensas como un estratega senior de PPC que",
    "defiende cada keyword (y cada negativa) ante el dueño del negocio.",
    "",
    "Tu trabajo: a partir de los TEMAS del plan (cada tema = un futuro grupo de",
    "anuncios de intención única) y de la marca, construir:",
    "1. Una lista CURADA de keywords por tema (≈10-25 por tema), con tipos de",
    "   concordancia mezclados y bien razonados.",
    "2. Una lista FUERTE de negativas (≥15) que proteja el presupuesto desde el día 1.",
    "",
    "PRINCIPIOS QUE SIEMPRE APLICAS:",
    "1. INTENCIÓN ANTE TODO. Prioriza términos con intención comercial/transaccional",
    "   real. La gente que va a contratar/comprar busca distinto a la que solo se",
    "   informa. Mapea cada keyword al tema correcto (theme = PlannerTheme.name EXACTO).",
    "2. CONCORDANCIAS con criterio:",
    "   - EXACT para términos de marca y de altísima intención (presupuesto fino).",
    "   - PHRASE para el grueso de intención media-alta (control + alcance).",
    "   - BROAD solo cuando tenga sentido con Smart Bidding, y SIEMPRE acompañada de",
    "     negativas que la contengan. No abuses de BROAD.",
    "3. NEGATIVAS como arma. Mínimo 15. Cubre al menos:",
    "   - free_seeker: 'gratis', 'gratuito', 'barato', 'segunda mano', 'opiniones',",
    "     'curso', 'pdf', 'plantilla', 'cómo hacer'... (quien no va a pagar).",
    "   - wrong_intent: búsquedas informativas/DIY que NO convierten.",
    "   - wrong_geo: zonas o países fuera del objetivo.",
    "   - competitor: marcas de la competencia (salvo estrategia de competidores).",
    "   Usa la clase correcta en negativeClass y un scope sensato (campaign por defecto).",
    "4. RELEVANCIA: relevanceScore 0..1 según el encaje real con el negocio y la",
    "   landing. Penaliza términos ambiguos o tangenciales.",
    "5. SCORE compuesto: combina volumen × intención × relevancia × asequibilidad",
    "   (pujas) para que A3 pueda priorizar. Más alto = mejor candidata.",
    "6. SIN operadores en 'text': nada de comillas ni corchetes; el matchType ya",
    "   indica la concordancia. Todo en minúsculas.",
    "",
    "MÉTRICAS: pon metricsSource = 'llm_estimate' y rellena avgMonthlySearches /",
    "competition / pujas con tu MEJOR estimación. Si el sistema dispone de datos",
    "reales del Planificador de Palabras Clave, el código los adjuntará después y",
    "cambiará metricsSource a 'google_keyword_planner'. Aun así, da siempre tu",
    "estimación para no dejar huecos.",
    "",
    "TONO DE LOS TEXTOS PARA EL USUARIO (rationale de cada keyword y notes):",
    "español sencillo, cercano y claro, para un dueño de negocio NO técnico. Sin",
    "jerga ni anglicismos innecesarios. Frases cortas.",
    "",
    "Devuelve EXCLUSIVAMENTE la herramienta estructurada. No añadas texto libre.",
  ].join("\n");
}

function buildUserPrompt(ctx: RunContext): string {
  const b = ctx.brand;
  const planner = ctx.planner;
  const landing = landingSeed(ctx) ?? "(no indicada)";

  const lines: string[] = [
    "Contexto para la investigación de palabras clave:",
    "",
    `- Marca: ${b.brandName}`,
    `- Sitio web: ${b.brandWebsite ?? "(no indicado)"}`,
    `- Landing (a donde apuntarán los anuncios): ${landing}`,
  ];
  if (b.description) lines.push(`- Descripción del negocio: ${b.description}`);

  if (planner) {
    lines.push(
      "",
      `- Objetivo: ${planner.objectiveType} — ${planner.objectiveSummary}`,
      `- Geo: ${planner.geo.locations.join(", ")} (países: ${planner.geo.countryCodes.join(", ")})`,
      `- Idioma: ${planner.geo.languageCode}`,
      `- Resumen de marca: ${planner.brandSummary}`,
      "",
      "TEMAS DEL PLAN (cada uno = un grupo de anuncios de intención única).",
      "Usa el 'name' EXACTO en el campo 'theme' de cada keyword:"
    );
    for (const theme of planner.themes) {
      lines.push(
        `  • ${theme.name} [intención: ${theme.intent}] — ${theme.description}`
      );
    }
  } else {
    lines.push(
      "",
      "- (No hay salida del Planner disponible; infiere temas razonables a partir de la marca.)"
    );
  }

  lines.push(
    "",
    "Instrucciones:",
    "- Genera ≈10-25 keywords por tema, con concordancias mezcladas y bien razonadas.",
    "- Mapea cada keyword a su tema con el nombre EXACTO del tema.",
    "- 'text' en minúsculas y SIN operadores (sin comillas ni corchetes).",
    "- Crea al menos 15 negativas fuertes (free_seeker, wrong_intent, wrong_geo, competitor).",
    "- Da tu mejor estimación de volumen, competencia y pujas (metricsSource = 'llm_estimate').",
    "- Escribe los textos para el usuario en español sencillo y claro.",
    `- Idioma de las keywords: ${planner?.geo.languageCode ?? b.languageHint ?? "es"}.`
  );

  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Agent
// ----------------------------------------------------------------------------

const a2KeywordResearcher: AgentDefinition<KeywordResearchOutput> = {
  id: "keyword_researcher",
  title: "Investigador de keywords",
  model: defaultAnthropicModel("keyword_researcher"),
  kind: "llm",
  promptVersion: PROMPT_VERSION,

  async execute(
    ctx: RunContext,
    helpers: AgentHelpers
  ): Promise<AgentResult<KeywordResearchOutput>> {
    const system = buildSystemPrompt();
    const prompt = buildUserPrompt(ctx);

    // --- 1) Try REAL metrics from the Keyword Planner (best-effort) ----------
    const keywordSeeds = buildKeywordSeeds(ctx);
    const urlSeed = landingSeed(ctx);
    const languageCode = ctx.planner?.geo.languageCode ?? "es";
    const countryCodes = ctx.planner?.geo.countryCodes ?? [];

    let plannerIdeas: KeywordPlanIdea[] = [];
    try {
      plannerIdeas = await generateKeywordIdeas({
        keywordSeeds,
        urlSeed,
        languageCode,
        countryCodes,
      });
    } catch {
      plannerIdeas = [];
    }

    // --- 2) Curate the list with the LLM -------------------------------------
    let result;
    try {
      result = await callStructured<KeywordResearchOutput>({
        agentId: "keyword_researcher",
        system,
        prompt,
        schema: KEYWORD_RESEARCH_SCHEMA,
        toolName: "submit_keyword_research",
        toolDescription:
          "Entrega la investigación de palabras clave (keywords curadas + negativas) como objeto estructurado.",
        temperature: TEMPERATURE,
        signal: helpers.signal,
      });
    } catch (err) {
      if (err instanceof LLMError) {
        await helpers.emit("error", {
          agent: "keyword_researcher",
          message: err.message,
        });
      }
      throw err;
    }

    const llmOutput = result.data;

    // --- 3) Attach real metrics if we have them ------------------------------
    let keywords = llmOutput.keywords;
    let metricsSource: KeywordResearchOutput["metricsSource"] = "llm_estimate";
    let matched = 0;
    if (plannerIdeas.length > 0) {
      const attached = attachMetrics(keywords, plannerIdeas);
      keywords = attached.keywords;
      matched = attached.matched;
      if (matched > 0) metricsSource = "google_keyword_planner";
    }

    const output: KeywordResearchOutput = {
      ...llmOutput,
      keywords,
      metricsSource,
    };

    // --- 4) Persist ONE keyword_research_runs row (NOT the keywords table) ----
    const sources = Array.from(
      new Set(output.keywords.map((k) => k.source).filter(Boolean))
    );
    await adsDb.insert(keywordResearchRuns).values({
      campaignId: ctx.campaignId ?? null,
      runId: ctx.run.id,
      seeds: { keywordSeeds, urlSeed: urlSeed ?? null, languageCode, countryCodes },
      sources,
      rounds: 1,
      totalIdeas: output.keywords.length + plannerIdeas.length,
      kept: output.keywords.length,
      raw: {
        metricsSource,
        plannerIdeasReturned: plannerIdeas.length,
        plannerIdeasMatched: matched,
        keywords: output.keywords,
        negatives: output.negatives,
        notes: output.notes,
      },
    });

    // --- 5) Emit + return -----------------------------------------------------
    const metricsLabel =
      metricsSource === "google_keyword_planner"
        ? `métricas reales del Planner (${matched} coincidencias)`
        : "métricas estimadas";
    await helpers.emit("decision", {
      agent: "keyword_researcher",
      summary: `${output.keywords.length} keywords · ${output.negatives.length} negativas · ${metricsLabel}.`,
    });
    await helpers.emit("artifact", { output });

    return {
      output,
      rationale: output.notes,
      model: result.model,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      costMicros: result.costMicros,
    };
  },
};

export default a2KeywordResearcher;
