// ============================================================================
// A3 — STRUCTURE ARCHITECT (Opus)
// ----------------------------------------------------------------------------
// Turns the planner's objective + the keyword researcher's vetted keywords into
// a tight, single-theme-per-ad-group (STAG) campaign tree, plus the negative
// keyword scaffolding that keeps each group from cannibalising the others.
//
// This agent OWNS the structure rows. For the chosen tree it persists:
//   - one ad_groups row per planned ad group  (status 'proposed')
//   - one keywords row per planned keyword     (status 'proposed')
//   - negative_keywords rows for ad-group negatives + campaign shared negatives
//
// Money is micros (USD * MICROS_PER_UNIT). Nothing here is enabled or pushed to
// Google — A3 only proposes structure. Writes go to adsDb only.
// ============================================================================

import { callStructured, LLMError, defaultAnthropicModel } from "@/lib/llm";
import { adsDb } from "@/lib/ads-db";
import { adGroups, keywords, negativeKeywords } from "@/lib/schema";
import {
  MICROS_PER_UNIT,
  type AgentDefinition,
  type RunContext,
  type AgentHelpers,
  type AgentResult,
  type StructureOutput,
  type PlannedAdGroup,
  type PlannedKeyword,
  type KeywordIdea,
  type JSONSchema,
} from "@/lib/engine/types";

const PROMPT_VERSION = "a3-structure-architect@1";
const AGENT_ID = "structure_architect" as const;

// ----------------------------------------------------------------------------
// Output JSON schema — mirrors StructureOutput EXACTLY.
// ----------------------------------------------------------------------------

const plannedKeywordSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "matchType"],
  properties: {
    text: { type: "string", description: "El término de la keyword, sin operadores de concordancia." },
    matchType: { type: "string", enum: ["EXACT", "PHRASE", "BROAD"] },
  },
};

const STRUCTURE_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["campaignName", "adGroups", "sharedNegatives", "biddingStrategy", "rationale"],
  properties: {
    campaignName: {
      type: "string",
      description:
        "Nombre claro de la campaña de Search. Patrón recomendado: 'Marca | Search | Objetivo | Geo'.",
    },
    adGroups: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      description: "Grupos de anuncios, cada uno con UN solo tema (STAG).",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "theme",
          "archetype",
          "matchTypePolicy",
          "keywords",
          "negativeKeywords",
          "landingPageUrl",
        ],
        properties: {
          name: { type: "string", description: "Nombre corto y descriptivo del grupo." },
          theme: {
            type: "string",
            description: "El único tema/intención que cubre este grupo (1 sola idea).",
          },
          archetype: {
            type: "string",
            enum: ["brand", "non_brand_stag", "dsa", "competitor", "category"],
          },
          matchTypePolicy: {
            type: "string",
            enum: ["EXACT", "PHRASE", "BROAD", "MIXED"],
          },
          keywords: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: plannedKeywordSchema,
          },
          negativeKeywords: {
            type: "array",
            description:
              "Negativas a nivel de grupo: bloquean términos de OTROS grupos (cross-group) e intenciones equivocadas.",
            items: plannedKeywordSchema,
          },
          defaultCpcUsd: {
            type: "number",
            description:
              "CPC máximo por defecto del grupo en USD (opcional). Omitir si la estrategia de puja es automática.",
          },
          landingPageUrl: {
            type: "string",
            description: "URL de destino más relevante para el tema del grupo.",
          },
        },
      },
    },
    sharedNegatives: {
      type: "array",
      description:
        "Negativas a nivel de campaña (compartidas): basura universal, intención libre/gratis, geo incorrecta, etc.",
      items: plannedKeywordSchema,
    },
    biddingStrategy: {
      type: "string",
      enum: [
        "MANUAL_CPC",
        "MAXIMIZE_CLICKS",
        "MAXIMIZE_CONVERSIONS",
        "TARGET_CPA",
        "MAXIMIZE_CONVERSION_VALUE",
        "TARGET_ROAS",
      ],
      description: "Estrategia de puja de la campaña (normalmente la que fijó el estratega A1).",
    },
    rationale: {
      type: "string",
      description:
        "Explicación breve, en español sencillo, de por qué esta estructura es la correcta.",
    },
  },
};

// ----------------------------------------------------------------------------
// Prompt builders
// ----------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "Eres un especialista senior en Google Ads (Search) con 15 años optimizando cuentas de PPC.",
    "Tu trabajo es diseñar la ESTRUCTURA de una campaña de Búsqueda: el árbol campaña → grupos de anuncios,",
    "y el andamiaje de palabras clave negativas que mantiene cada grupo limpio y enfocado.",
    "",
    "PRINCIPIOS QUE DEFIENDES SIEMPRE:",
    "1. STAG (Single Theme Ad Group): cada grupo cubre UNA sola intención/tema. Si dos keywords",
    "   pedirían anuncios distintos, van en grupos distintos. Grupos enfocados = anuncios más relevantes",
    "   = mejor Quality Score = menor CPC.",
    "2. Mezcla sensata de concordancias. Por defecto prioriza PHRASE y EXACT para control de intención;",
    "   usa BROAD solo cuando la estrategia de puja es automática (Smart Bidding) y con buenas negativas.",
    "   Marca el matchTypePolicy del grupo como MIXED si combinas tipos, o el tipo concreto si es uno solo.",
    "3. Deduplica. Una misma keyword nunca debe aparecer en dos grupos: causa competencia interna.",
    "4. Negativas cruzadas (cross-group): añade como negativas de grupo los términos núcleo de los OTROS",
    "   grupos, para que cada búsqueda caiga en el grupo correcto. Esto es obligatorio en estructuras STAG.",
    "5. Negativas compartidas de campaña: bloquea ruido universal (gratis, empleo, 'cómo se hace', PDF,",
    "   ubicaciones fuera del geo objetivo, marcas que no quieres pujar) según el objetivo del negocio.",
    "6. Archetipos: usa 'brand' para términos de la propia marca, 'competitor' para competidores,",
    "   'category'/'non_brand_stag' para términos genéricos de producto/servicio, 'dsa' solo si procede.",
    "7. Nombres consistentes y legibles para humanos. La campaña sigue el patrón 'Marca | Search | Objetivo | Geo'.",
    "",
    "REGLAS DURAS:",
    "- Usa SOLO las keywords aportadas por la investigación (A2). No inventes keywords nuevas.",
    "- Cada keyword va exactamente en UN grupo (el más relevante por su tema/intención).",
    "- defaultCpcUsd es opcional: inclúyelo solo si la puja es manual; si es automática, omítelo.",
    "- landingPageUrl de cada grupo debe ser una URL real del sitio de la marca (usa la de destino por defecto si no hay una mejor).",
    "- Devuelve la estructura mediante la herramienta estructurada; no escribas texto libre fuera de ella.",
    "- Todos los textos visibles (nombres, rationale) en español claro y sencillo.",
  ].join("\n");
}

function buildUserPrompt(ctx: RunContext): string {
  const { brand, planner, keywords: kw } = ctx;

  const landingDefault =
    brand.landingPageUrl ?? brand.brandWebsite ?? "(sin URL — usa la del sitio de la marca)";

  const themesBlock =
    planner?.themes
      .map((t, i) => `  ${i + 1}. ${t.name} [${t.intent}] — ${t.description}`)
      .join("\n") ?? "  (el estratega no aportó temas)";

  const kpisBlock =
    planner?.kpis.map((k) => `  - ${k.primary}: ${k.target}`).join("\n") ?? "  (sin KPIs)";

  // Compact keyword table so the model can assign every keyword to a group.
  const kwBlock =
    kw?.keywords
      .map((k) => {
        const vol = k.avgMonthlySearches != null ? `~${k.avgMonthlySearches}/mes` : "vol?";
        const comp = k.competition ? k.competition : "comp?";
        const rel = k.relevanceScore != null ? `rel ${k.relevanceScore.toFixed(2)}` : "rel?";
        return `  - "${k.text}" [${k.matchType}] tema=${k.theme} intención=${k.intent} ${vol} ${comp} ${rel}`;
      })
      .join("\n") ?? "  (sin keywords del investigador)";

  const negBlock =
    kw?.negatives && kw.negatives.length > 0
      ? kw.negatives
          .map((n) => `  - "${n.text}" [${n.matchType}] clase=${n.negativeClass} scope=${n.scope ?? "?"}`)
          .join("\n")
      : "  (el investigador no propuso negativas; deriva las necesarias del contexto)";

  return [
    "Diseña la estructura de la campaña de Search con la información siguiente.",
    "",
    "=== MARCA ===",
    `Nombre: ${brand.brandName}`,
    `Web: ${brand.brandWebsite ?? "(no informada)"}`,
    `URL de destino por defecto: ${landingDefault}`,
    brand.description ? `Descripción: ${brand.description}` : "",
    "",
    "=== PLAN DEL ESTRATEGA (A1) ===",
    planner ? `Objetivo: ${planner.objectiveType} — ${planner.objectiveSummary}` : "(sin plan)",
    planner
      ? `Geo: ${planner.geo.locations.join(", ")} (${planner.geo.countryCodes.join(", ")}) idioma=${planner.geo.languageCode}`
      : "",
    planner ? `Presupuesto diario: $${planner.budget.dailyUsd}` : "",
    planner ? `Estrategia de puja elegida: ${planner.biddingStrategy}` : "",
    planner?.targetCpaUsd != null ? `Target CPA: $${planner.targetCpaUsd}` : "",
    planner?.targetRoas != null ? `Target ROAS: ${planner.targetRoas}` : "",
    "Temas semilla (se convierten en grupos):",
    themesBlock,
    "KPIs:",
    kpisBlock,
    "",
    "=== KEYWORDS APROBADAS POR EL INVESTIGADOR (A2) — usa SOLO estas ===",
    kwBlock,
    "",
    "=== NEGATIVAS SUGERIDAS POR EL INVESTIGADOR (A2) ===",
    negBlock,
    "",
    "=== TU TAREA ===",
    "1. Agrupa las keywords en grupos STAG (una sola intención por grupo). Deduplica: cada keyword en UN grupo.",
    "2. Asigna a cada grupo un matchTypePolicy coherente con su mezcla de concordancias.",
    "3. Para cada grupo, añade negativas cruzadas (los términos núcleo de los OTROS grupos) más las del A2 que apliquen.",
    "4. Define sharedNegatives a nivel de campaña con el ruido universal y lo que el objetivo del negocio exige excluir.",
    `5. Mantén la estrategia de puja del estratega (${planner?.biddingStrategy ?? "la del plan"}) salvo que haya una razón fuerte para cambiarla; explícala si la cambias.`,
    "6. Pon a cada grupo una landingPageUrl real y relevante (usa la de destino por defecto si no hay una mejor).",
    "7. Nombra la campaña con el patrón 'Marca | Search | Objetivo | Geo'.",
    "Devuelve TODO mediante la herramienta estructurada.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ----------------------------------------------------------------------------
// Persistence helpers
// ----------------------------------------------------------------------------

function usdToMicros(usd: number | undefined): number | null {
  if (usd == null || !Number.isFinite(usd)) return null;
  return Math.round(usd * MICROS_PER_UNIT);
}

/** numeric(.,.) columns are strings in drizzle/pg; null stays null. */
function numericStr(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return String(value);
}

/** Index A2 keywords by normalised text+matchType so we can carry their metrics. */
function indexKeywordIdeas(ideas: KeywordIdea[] | undefined): Map<string, KeywordIdea> {
  const map = new Map<string, KeywordIdea>();
  for (const idea of ideas ?? []) {
    map.set(`${idea.text.trim().toLowerCase()}|${idea.matchType}`, idea);
  }
  return map;
}

function ideaFor(
  index: Map<string, KeywordIdea>,
  pk: PlannedKeyword
): KeywordIdea | undefined {
  return (
    index.get(`${pk.text.trim().toLowerCase()}|${pk.matchType}`) ??
    // Fall back to text-only match if the architect changed the match type.
    [...index.values()].find(
      (i) => i.text.trim().toLowerCase() === pk.text.trim().toLowerCase()
    )
  );
}

/**
 * Persist the proposed structure tree to adsDb. Owns ad_groups + keywords +
 * negative_keywords rows. No-op (skips DB) when there is no campaignId yet.
 */
async function persistStructure(
  campaignId: string,
  output: StructureOutput,
  ctx: RunContext
): Promise<void> {
  const ideaIndex = indexKeywordIdeas(ctx.keywords?.keywords);

  for (const group of output.adGroups) {
    const [adGroupRow] = await adsDb
      .insert(adGroups)
      .values({
        campaignId,
        name: group.name,
        theme: group.theme,
        archetype: group.archetype,
        matchTypePolicy: group.matchTypePolicy,
        defaultCpcMicros: usdToMicros(group.defaultCpcUsd),
        landingPageUrl: group.landingPageUrl,
        status: "proposed",
      })
      .returning({ id: adGroups.id });

    const adGroupId = adGroupRow.id;

    // Keywords for this group, carrying A2 metrics where available.
    if (group.keywords.length > 0) {
      await adsDb.insert(keywords).values(
        group.keywords.map((pk) => {
          const idea = ideaFor(ideaIndex, pk);
          return {
            adGroupId,
            campaignId,
            text: pk.text,
            matchType: pk.matchType,
            intent: idea?.intent ?? null,
            avgMonthlySearches: idea?.avgMonthlySearches ?? null,
            competition: idea?.competition ?? null,
            topOfPageBidMicros: idea?.topOfPageBidHighMicros ?? null,
            lowTopOfPageBidMicros: idea?.topOfPageBidLowMicros ?? null,
            relevanceScore: numericStr(idea?.relevanceScore),
            score: numericStr(idea?.score),
            source: idea?.source ?? "llm",
            rationale: idea?.rationale ?? null,
            status: "proposed",
          };
        })
      );
    }

    // Ad-group-level (cross-group / intent) negatives.
    if (group.negativeKeywords.length > 0) {
      await adsDb.insert(negativeKeywords).values(
        group.negativeKeywords.map((nk) => ({
          campaignId,
          adGroupId,
          text: nk.text,
          matchType: nk.matchType,
          negativeClass: "cross_group",
          scope: "ad_group" as const,
        }))
      );
    }
  }

  // Campaign-level shared negatives.
  if (output.sharedNegatives.length > 0) {
    await adsDb.insert(negativeKeywords).values(
      output.sharedNegatives.map((nk) => ({
        campaignId,
        adGroupId: null,
        text: nk.text,
        matchType: nk.matchType,
        negativeClass: "campaign",
        scope: "campaign" as const,
      }))
    );
  }
}

// ----------------------------------------------------------------------------
// Agent
// ----------------------------------------------------------------------------

const a3StructureArchitect: AgentDefinition<StructureOutput> = {
  id: AGENT_ID,
  title: "Arquitecto de estructura",
  model: defaultAnthropicModel("structure_architect"),
  kind: "llm",
  promptVersion: PROMPT_VERSION,

  async execute(
    ctx: RunContext,
    helpers: AgentHelpers
  ): Promise<AgentResult<StructureOutput>> {
    const system = buildSystemPrompt();
    const prompt = buildUserPrompt(ctx);

    let result;
    try {
      result = await callStructured<StructureOutput>({
        agentId: "structure_architect",
        system,
        prompt,
        schema: STRUCTURE_SCHEMA,
        toolName: "submit_structure",
        toolDescription:
          "Devuelve la estructura completa de la campaña de Search (campaña, grupos STAG, keywords, negativas y estrategia de puja).",
        temperature: 0.3,
        maxTokens: 8192,
        signal: helpers.signal,
      });
    } catch (e) {
      if (e instanceof LLMError) {
        await helpers.emit("error", { agent: AGENT_ID, message: e.message });
      }
      throw e;
    }

    const output = result.data;

    // Carry the planner's bidding strategy if the model left it blank.
    if (!output.biddingStrategy && ctx.planner?.biddingStrategy) {
      output.biddingStrategy = ctx.planner.biddingStrategy;
    }

    // Persist the structure tree (ad groups + keywords + negatives) to adsDb.
    if (ctx.campaignId) {
      await persistStructure(ctx.campaignId, output, ctx);
    }

    const totalKeywords = output.adGroups.reduce(
      (sum: number, g: PlannedAdGroup) => sum + g.keywords.length,
      0
    );
    const totalGroupNegatives = output.adGroups.reduce(
      (sum: number, g: PlannedAdGroup) => sum + g.negativeKeywords.length,
      0
    );

    await helpers.emit("decision", {
      agent: AGENT_ID,
      summary: `Campaña "${output.campaignName}": ${output.adGroups.length} grupos, ${totalKeywords} keywords, ${
        totalGroupNegatives + output.sharedNegatives.length
      } negativas. Puja: ${output.biddingStrategy}.`,
      campaignName: output.campaignName,
      adGroups: output.adGroups.length,
      keywords: totalKeywords,
      negatives: totalGroupNegatives + output.sharedNegatives.length,
      biddingStrategy: output.biddingStrategy,
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

export default a3StructureArchitect;
