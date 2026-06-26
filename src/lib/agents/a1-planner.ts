// ============================================================================
// A1 — PLANNER (Estratega)
// ----------------------------------------------------------------------------
// First agent in the Search pipeline. From the raw brand seed (name, website,
// landing page + plain-language hints about objective / geo / budget) it decides
// the campaign foundations: objective, geo & language, daily budget, bidding
// strategy and 3-6 single-intent themes (STAG) that become ad groups downstream.
//
// Model: Opus (this is a "thinking" agent — the strategy everything else builds
// on). Output mirrors PlannerOutput from the FROZEN contract EXACTLY.
//
// Persists one campaign_plans row (version 1, status 'active').
// ============================================================================

import {
  type AgentDefinition,
  type AgentResult,
  type AgentHelpers,
  type RunContext,
  type PlannerOutput,
  BUDGET,
} from "@/lib/engine/types";
import { callStructured, LLMError, defaultAnthropicModel } from "@/lib/llm";
import { adsDb } from "@/lib/ads-db";
import { campaignPlans } from "@/lib/schema";

const PROMPT_VERSION = "a1-planner-v1";
const TEMPERATURE = 0.3;

// ----------------------------------------------------------------------------
// JSON schema — mirrors PlannerOutput from types.ts EXACTLY.
// ----------------------------------------------------------------------------

const INTENT_ENUM = [
  "brand",
  "transactional",
  "commercial",
  "informational",
  "competitor",
  "local",
] as const;

const OBJECTIVE_ENUM = [
  "leads",
  "sales",
  "traffic",
  "calls",
  "awareness",
] as const;

const BIDDING_ENUM = [
  "MANUAL_CPC",
  "MAXIMIZE_CLICKS",
  "MAXIMIZE_CONVERSIONS",
  "TARGET_CPA",
  "MAXIMIZE_CONVERSION_VALUE",
  "TARGET_ROAS",
] as const;

const PLANNER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "objectiveType",
    "objectiveSummary",
    "geo",
    "budget",
    "biddingStrategy",
    "themes",
    "kpis",
    "brandSummary",
    "rationale",
  ],
  properties: {
    objectiveType: {
      type: "string",
      enum: OBJECTIVE_ENUM,
      description: "Primary campaign objective inferred from the brand seed.",
    },
    objectiveSummary: {
      type: "string",
      description:
        "One plain-Spanish sentence summarising the objective for the user.",
    },
    geo: {
      type: "object",
      additionalProperties: false,
      required: ["locations", "countryCodes", "languageCode", "presenceOnly"],
      properties: {
        locations: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Human-readable target locations (cities/regions/countries).",
        },
        countryCodes: {
          type: "array",
          items: { type: "string", minLength: 2, maxLength: 2 },
          minItems: 1,
          description: "ISO-3166 alpha-2 country codes, uppercase (e.g. ES, MX).",
        },
        languageCode: {
          type: "string",
          description: "ISO-639-1 language code, e.g. 'es' or 'en'.",
        },
        presenceOnly: {
          type: "boolean",
          description:
            "true = target people physically IN the location (recommended). Always true here.",
        },
      },
    },
    budget: {
      type: "object",
      additionalProperties: false,
      required: ["dailyUsd", "rationale"],
      properties: {
        dailyUsd: {
          type: "number",
          minimum: BUDGET.minDailyUsd,
          description: "Daily budget in USD. Never below the $1/day minimum.",
        },
        rationale: {
          type: "string",
          description: "Plain-Spanish justification of the daily budget.",
        },
      },
    },
    biddingStrategy: {
      type: "string",
      enum: BIDDING_ENUM,
      description:
        "Default MAXIMIZE_CONVERSIONS for a fresh campaign with conversion tracking.",
    },
    targetCpaUsd: {
      type: "number",
      description: "Only if biddingStrategy is TARGET_CPA.",
    },
    targetRoas: {
      type: "number",
      description: "Only if biddingStrategy is TARGET_ROAS (e.g. 4.0 = 400%).",
    },
    themes: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      description:
        "3-6 single-intent themes; each becomes one tight STAG ad group.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "intent", "description"],
        properties: {
          name: {
            type: "string",
            description: "Short theme name (becomes the ad group name).",
          },
          intent: { type: "string", enum: INTENT_ENUM },
          description: {
            type: "string",
            description:
              "What searcher need this theme captures, in plain Spanish.",
          },
        },
      },
    },
    kpis: {
      type: "array",
      minItems: 1,
      description: "Primary KPIs with concrete targets.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["primary", "target"],
        properties: {
          primary: { type: "string", description: "KPI name." },
          target: { type: "string", description: "Concrete target value." },
        },
      },
    },
    conversionActionResourceName: {
      type: "string",
      description:
        "Chosen primary conversion action resource name, if one applies.",
    },
    brandSummary: {
      type: "string",
      description:
        "2-4 sentence plain-Spanish summary of what the brand offers and to whom.",
    },
    rationale: {
      type: "string",
      description:
        "Plain-Spanish explanation of the whole plan for a non-technical owner.",
    },
  },
};

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "Eres un estratega senior de Google Ads (Search) con 15 años de experiencia",
    "creando campañas de búsqueda rentables para PYMES. Piensas como un consultor",
    "que defiende cada decisión ante el dueño del negocio.",
    "",
    "Tu trabajo: a partir de la información de la marca, definir los CIMIENTOS de",
    "una campaña de Search nueva (objetivo, geo/idioma, presupuesto diario,",
    "estrategia de puja y 3-6 temas de intención única que se convertirán en grupos",
    "de anuncios).",
    "",
    "PRINCIPIOS QUE SIEMPRE APLICAS:",
    "1. STAG (Single Theme Ad Group): cada tema captura UNA sola intención de",
    "   búsqueda, clara y acotada. Nada de temas-cajón de sastre. Si dudas entre",
    "   meter dos ideas juntas, sepáralas. Entre 3 y 6 temas.",
    "2. Estrategia de puja por defecto: MAXIMIZE_CONVERSIONS. Asumimos seguimiento",
    "   de conversiones maduro y CERO historial de anuncios. NO necesitamos un",
    "   arranque con Maximizar Clics. Solo te desvías de MAXIMIZE_CONVERSIONS si la",
    "   información de la marca lo justifica de forma explícita (p. ej. objetivo de",
    "   ventas con valor por conversión claro → MAXIMIZE_CONVERSION_VALUE).",
    "3. Geo: presenceOnly SIEMPRE true (personas que están FÍSICAMENTE en la zona,",
    "   no las que solo muestran interés). countryCodes en ISO-2 MAYÚSCULAS.",
    "4. Idioma: usa el idioma real de la audiencia objetivo y de la landing.",
    "5. Presupuesto: el mínimo es 1 USD/día. Si el usuario da una pista de",
    "   presupuesto, respétala (nunca por debajo del mínimo). Si NO da pista,",
    "   propón un diario razonable (~20-50 USD) coherente con el objetivo y",
    "   justifícalo. El dinero NO se expresa en micros aquí: usa dólares.",
    "6. Objetivo: elige el más cercano a la intención del negocio (leads, sales,",
    "   traffic, calls, awareness). La mayoría de PYMES de servicios = leads o calls.",
    "7. KPIs: define métricas con objetivos concretos y medibles.",
    "",
    "TONO DE LOS TEXTOS PARA EL USUARIO (objectiveSummary, budget.rationale,",
    "themes.description, brandSummary, rationale): español sencillo, cercano y",
    "claro, pensado para un dueño de negocio que NO es técnico. Sin jerga, sin",
    "anglicismos innecesarios. Frases cortas.",
    "",
    "Devuelve EXCLUSIVAMENTE la herramienta estructurada. No añadas texto libre.",
  ].join("\n");
}

function buildUserPrompt(ctx: RunContext): string {
  const b = ctx.brand;
  const landing = b.landingPageUrl ?? b.brandWebsite ?? "(no indicada)";
  const lines: string[] = [
    "Información de la marca para planificar la campaña de Search:",
    "",
    `- Nombre de la marca: ${b.brandName}`,
    `- Sitio web: ${b.brandWebsite ?? "(no indicado)"}`,
    `- Landing (a donde apuntarán los anuncios): ${landing}`,
  ];
  if (b.description) lines.push(`- Descripción del negocio: ${b.description}`);
  lines.push(
    `- Objetivo (en sus palabras): ${b.objectiveHint ?? "(no indicado)"}`,
    `- Zona geográfica (en sus palabras): ${b.geoHint ?? "(no indicada)"}`,
    `- Idioma (pista): ${b.languageHint ?? "(no indicada)"}`,
    `- Presupuesto diario sugerido (USD): ${
      b.budgetHintUsd !== undefined ? b.budgetHintUsd : "(no indicado)"
    }`,
    "",
    "Instrucciones:",
    `- El presupuesto diario mínimo es ${BUDGET.minDailyUsd} USD/día.`,
    b.budgetHintUsd !== undefined
      ? `- Respeta el presupuesto sugerido (${b.budgetHintUsd} USD/día) salvo que esté por debajo del mínimo.`
      : "- No hay pista de presupuesto: propón un diario razonable (~20-50 USD/día) y justifícalo.",
    "- Define 3-6 temas de intención única (STAG) bien acotados.",
    "- Usa MAXIMIZE_CONVERSIONS salvo justificación explícita en contra.",
    "- presenceOnly = true. countryCodes en ISO-2 mayúsculas.",
    "- Escribe todos los textos para el usuario en español sencillo y claro.",
  );
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Agent
// ----------------------------------------------------------------------------

const a1Planner: AgentDefinition<PlannerOutput> = {
  id: "planner",
  title: "Estratega",
  model: defaultAnthropicModel("planner"),
  kind: "llm",
  promptVersion: PROMPT_VERSION,

  async execute(
    ctx: RunContext,
    helpers: AgentHelpers
  ): Promise<AgentResult<PlannerOutput>> {
    const system = buildSystemPrompt();
    const prompt = buildUserPrompt(ctx);

    let result;
    try {
      result = await callStructured<PlannerOutput>({
        agentId: "planner",
        system,
        prompt,
        schema: PLANNER_SCHEMA,
        toolName: "submit_plan",
        toolDescription:
          "Entrega el plan estratégico de la campaña de Search como objeto estructurado.",
        temperature: TEMPERATURE,
        signal: helpers.signal,
      });
    } catch (err) {
      if (err instanceof LLMError) {
        await helpers.emit("error", { agent: "planner", message: err.message });
      }
      throw err;
    }

    const output = result.data;

    // Persist the versioned plan blob (version 1, active).
    await adsDb.insert(campaignPlans).values({
      campaignId: ctx.campaignId ?? null,
      runId: ctx.run.id,
      version: 1,
      plan: output,
      status: "active",
    });

    await helpers.emit("decision", {
      agent: "planner",
      summary: `Objetivo "${output.objectiveType}" · ${output.themes.length} temas · ${output.budget.dailyUsd} USD/día · puja ${output.biddingStrategy} · ${output.geo.locations.join(", ")} (${output.geo.languageCode}).`,
    });
    await helpers.emit("artifact", { output });

    return {
      output,
      rationale: output.rationale,
      model: result.model,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      costMicros: result.costMicros,
    };
  },
};

export default a1Planner;
