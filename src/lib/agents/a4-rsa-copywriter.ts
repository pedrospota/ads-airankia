// ============================================================================
// A4 — RSA COPYWRITER
// ----------------------------------------------------------------------------
// Turns the campaign structure (A3) + the strategy (A1) into Responsive Search
// Ads: for EACH ad group, exactly 15 headlines (<= 30 chars) and 4 descriptions
// (<= 90 chars), with varied angles and sparing pinning.
//
// Google Ads char limits are HARD. We ask the model to respect them, then we
// ENFORCE them in code after the call (truncating at word boundaries) so a
// rogue character count can never reach the Activator.
//
// Persists one `search_ads` row per ad group (this agent OWNS ad copy rows).
// ============================================================================

import { adsDb } from "@/lib/ads-db";
import { adGroups, searchAds } from "@/lib/schema";
import { and, eq } from "drizzle-orm";
import { callStructured, LLMError, defaultAnthropicModel } from "@/lib/llm";
import {
  AGENT_TITLES,
  RSA_LIMITS,
  type AdGroupAds,
  type AgentDefinition,
  type AgentHelpers,
  type DescriptionPin,
  type HeadlinePin,
  type JSONSchema,
  type PlannedAdGroup,
  type RSADescription,
  type RSAHeadline,
  type RSAOutput,
  type RunContext,
} from "@/lib/engine/types";

const PROMPT_VERSION = "a4-rsa-copywriter@1";

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------

const SYSTEM_PROMPT = `Eres un redactor publicitario senior y estratega de Google Ads de clase mundial, especializado en anuncios de búsqueda responsivos (RSA). Has gestionado millones de euros en inversión y conoces al dedillo las políticas de Google y lo que de verdad mueve el CTR y la conversión.

Tu trabajo: escribir, para CADA grupo de anuncios, un RSA impecable.

REGLAS DURAS DE GOOGLE (innegociables, son límites de caracteres reales):
- Exactamente 15 títulos (headlines). Cada título <= 30 caracteres, contando espacios.
- Exactamente 4 descripciones. Cada descripción <= 90 caracteres, contando espacios.
- path1 y path2 (rutas de la URL visible) son opcionales; si los usas, cada uno <= 15 caracteres, una sola palabra o término corto, sin espacios, sin barras, sin URL.
- Cuenta los caracteres tú mismo antes de enviar. Si dudas, acórtalo. Nunca te pases.

CALIDAD (lo que defiende un PPC senior):
- Variedad de ÁNGULOS entre los 15 títulos: beneficio, característica/diferenciador, llamada a la acción (CTA), prueba social/confianza, urgencia/escasez, y marca. No repitas la misma idea con otras palabras.
- Que ningún par de títulos sea casi idéntico: Google rota los activos, necesita combinaciones que tengan sentido juntas.
- Incluye al menos 2-3 títulos con una keyword principal del grupo (relevancia = Quality Score), pero escritos de forma natural, no forzada.
- Incluye CTAs claros ("Pide cita hoy", "Reserva ahora", "Pide presupuesto").
- Las 4 descripciones deben ampliar el valor, no repetir los títulos: una de beneficio, una de prueba/confianza, una con CTA, una con oferta/diferenciador.
- Tono según la marca y el mercado. Por defecto, español neutro, claro y cercano. Usa inglés SOLO si la marca/geo es claramente angloparlante.
- Nada de superlativos prohibidos ni promesas sin respaldo ("el mejor", "garantizado al 100%", "nº1"), ni MAYÚSCULAS sostenidas, ni símbolos/emoji raros, ni signos de exclamación repetidos. Cumple políticas de Google.

ANCLAJE (pinning): ánclalo con MUCHA moderación. Como mucho 1-2 títulos anclados en total (típicamente la marca en HEADLINE_1 o un CTA), y normalmente 0 descripciones. Anclar de más mata la optimización de Google. Deja la inmensa mayoría sin anclar (pinnedField = null).

Devuelve TODOS los grupos de anuncios que te den. Para cada grupo usa su landingPageUrl tal cual como finalUrl. Añade un rationale corto explicando tu enfoque de copy.`;

function buildUserPrompt(ctx: RunContext): string {
  const { brand, planner, structure } = ctx;

  const brandBlock = [
    `Marca: ${brand.brandName}`,
    brand.brandWebsite ? `Web: ${brand.brandWebsite}` : null,
    brand.description ? `Descripción: ${brand.description}` : null,
    brand.geoHint ? `Geo (pista): ${brand.geoHint}` : null,
    brand.languageHint ? `Idioma (pista): ${brand.languageHint}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const planBlock = planner
    ? [
        `Objetivo: ${planner.objectiveType} — ${planner.objectiveSummary}`,
        `Geo: ${planner.geo.locations.join(", ")} (idioma ${planner.geo.languageCode})`,
        `Resumen de marca: ${planner.brandSummary}`,
        planner.kpis.length
          ? `KPIs: ${planner.kpis.map((k) => `${k.primary} → ${k.target}`).join("; ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "(sin plan disponible)";

  const groupsBlock = (structure?.adGroups ?? [])
    .map((g, i) => formatAdGroup(g, i))
    .join("\n\n");

  return `Escribe los anuncios RSA para esta campaña.

== CONTEXTO DE MARCA ==
${brandBlock}

== ESTRATEGIA (A1) ==
${planBlock}

== ESTRUCTURA (A3) — ${structure?.campaignName ?? "campaña"} ==
Genera un RSA para CADA UNO de estos ${structure?.adGroups.length ?? 0} grupos. Usa el campo "name" exactamente como adGroupName y la "landingPageUrl" exactamente como finalUrl.

${groupsBlock}

Recuerda: por grupo, 15 títulos (<=30 caracteres cada uno) y 4 descripciones (<=90 caracteres cada una), ángulos variados, anclaje mínimo, español claro salvo que la marca/geo sea claramente angloparlante.`;
}

function formatAdGroup(g: PlannedAdGroup, index: number): string {
  const kws = g.keywords
    .slice(0, 12)
    .map((k) => `${k.text} [${k.matchType}]`)
    .join(", ");
  return [
    `Grupo ${index + 1}: "${g.name}"`,
    `  Tema/intención: ${g.theme} (${g.archetype})`,
    `  Landing (finalUrl): ${g.landingPageUrl}`,
    kws ? `  Keywords clave: ${kws}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ----------------------------------------------------------------------------
// JSON schema — mirrors RSAOutput exactly
// ----------------------------------------------------------------------------

const HEADLINE_PINS: HeadlinePin[] = ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3", null];
const DESCRIPTION_PINS: DescriptionPin[] = ["DESCRIPTION_1", "DESCRIPTION_2", null];

const OUTPUT_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ads", "rationale"],
  properties: {
    ads: {
      type: "array",
      description: "Un RSA por cada grupo de anuncios recibido.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["adGroupName", "headlines", "descriptions", "finalUrl"],
        properties: {
          adGroupName: {
            type: "string",
            description: "Nombre EXACTO del grupo (campo name de la estructura).",
          },
          headlines: {
            type: "array",
            description: "Exactamente 15 títulos, cada uno <= 30 caracteres.",
            minItems: RSA_LIMITS.minHeadlines,
            maxItems: RSA_LIMITS.maxHeadlines,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text"],
              properties: {
                text: { type: "string", maxLength: RSA_LIMITS.headlineMaxChars },
                pinnedField: {
                  type: ["string", "null"],
                  enum: HEADLINE_PINS,
                  description: "Anclaje opcional; usar con mucha moderación.",
                },
              },
            },
          },
          descriptions: {
            type: "array",
            description: "Exactamente 4 descripciones, cada una <= 90 caracteres.",
            minItems: RSA_LIMITS.minDescriptions,
            maxItems: RSA_LIMITS.maxDescriptions,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text"],
              properties: {
                text: { type: "string", maxLength: RSA_LIMITS.descriptionMaxChars },
                pinnedField: {
                  type: ["string", "null"],
                  enum: DESCRIPTION_PINS,
                  description: "Anclaje opcional; normalmente null.",
                },
              },
            },
          },
          path1: {
            type: "string",
            maxLength: RSA_LIMITS.path1MaxChars,
            description: "Ruta visible 1, opcional, <= 15 caracteres, sin espacios.",
          },
          path2: {
            type: "string",
            maxLength: RSA_LIMITS.path2MaxChars,
            description: "Ruta visible 2, opcional, <= 15 caracteres, sin espacios.",
          },
          finalUrl: {
            type: "string",
            description: "URL de destino = landingPageUrl del grupo.",
          },
        },
      },
    },
    rationale: {
      type: "string",
      description: "Explicación breve del enfoque de copy (en español).",
    },
  },
};

// ----------------------------------------------------------------------------
// Enforcement helpers (Google limits are hard — never trust the LLM blindly)
// ----------------------------------------------------------------------------

/** Truncate to maxChars at a word boundary; falls back to a hard cut. */
function truncateAtWord(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const candidate = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  // Drop trailing punctuation/space left by the cut.
  return candidate.replace(/[\s,;:.!¡¿?-]+$/u, "").trim() || cut.trim();
}

/** Path segments: no spaces, no slashes, <= maxChars. */
function sanitizePath(raw: string | undefined, maxChars: number): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/[\s/\\]+/g, "").replace(/[{}]/g, "");
  if (!cleaned) return undefined;
  return cleaned.slice(0, maxChars);
}

interface EnforceResult {
  ad: AdGroupAds;
  truncations: number;
}

/**
 * Validate + repair one ad group's RSA against Google's hard limits and our
 * policy (max items, pin caps, char limits). Records how many fields were
 * truncated so we can surface it.
 */
function enforceAdGroup(ad: AdGroupAds, fallbackFinalUrl: string): EnforceResult {
  let truncations = 0;

  // --- Headlines ---
  const seenHeadlines = new Set<string>();
  let pinnedHeadlines = 0;
  const headlines: RSAHeadline[] = [];
  for (const h of ad.headlines ?? []) {
    if (headlines.length >= RSA_LIMITS.maxHeadlines) break;
    const original = (h?.text ?? "").trim();
    if (!original) continue;
    const text = truncateAtWord(original, RSA_LIMITS.headlineMaxChars);
    if (text.length < original.length) truncations += 1;
    const key = text.toLowerCase();
    if (!text || seenHeadlines.has(key)) continue;
    seenHeadlines.add(key);

    // Cap total pins at 2 across the whole RSA's headlines.
    let pinnedField: HeadlinePin = isHeadlinePin(h?.pinnedField) ? h.pinnedField : null;
    if (pinnedField !== null) {
      if (pinnedHeadlines >= 2) pinnedField = null;
      else pinnedHeadlines += 1;
    }
    headlines.push(pinnedField ? { text, pinnedField } : { text });
  }

  // --- Descriptions ---
  const seenDescriptions = new Set<string>();
  let pinnedDescriptions = 0;
  const descriptions: RSADescription[] = [];
  for (const d of ad.descriptions ?? []) {
    if (descriptions.length >= RSA_LIMITS.maxDescriptions) break;
    const original = (d?.text ?? "").trim();
    if (!original) continue;
    const text = truncateAtWord(original, RSA_LIMITS.descriptionMaxChars);
    if (text.length < original.length) truncations += 1;
    const key = text.toLowerCase();
    if (!text || seenDescriptions.has(key)) continue;
    seenDescriptions.add(key);

    let pinnedField: DescriptionPin = isDescriptionPin(d?.pinnedField)
      ? d.pinnedField
      : null;
    if (pinnedField !== null) {
      if (pinnedDescriptions >= 1) pinnedField = null;
      else pinnedDescriptions += 1;
    }
    descriptions.push(pinnedField ? { text, pinnedField } : { text });
  }

  const path1 = sanitizePath(ad.path1, RSA_LIMITS.path1MaxChars);
  const path2 = sanitizePath(ad.path2, RSA_LIMITS.path2MaxChars);
  const finalUrl = (ad.finalUrl ?? "").trim() || fallbackFinalUrl;

  const repaired: AdGroupAds = {
    adGroupName: ad.adGroupName,
    headlines,
    descriptions,
    finalUrl,
    ...(path1 ? { path1 } : {}),
    ...(path2 ? { path2 } : {}),
  };

  return { ad: repaired, truncations };
}

function isHeadlinePin(v: unknown): v is Exclude<HeadlinePin, null> {
  return v === "HEADLINE_1" || v === "HEADLINE_2" || v === "HEADLINE_3";
}

function isDescriptionPin(v: unknown): v is Exclude<DescriptionPin, null> {
  return v === "DESCRIPTION_1" || v === "DESCRIPTION_2";
}

// ----------------------------------------------------------------------------
// Agent definition
// ----------------------------------------------------------------------------

const a4RsaCopywriter: AgentDefinition<RSAOutput> = {
  id: "rsa_copywriter",
  title: AGENT_TITLES.rsa_copywriter,
  model: defaultAnthropicModel("rsa_copywriter"),
  kind: "llm",
  promptVersion: PROMPT_VERSION,

  async execute(ctx: RunContext, helpers: AgentHelpers) {
    if (!ctx.structure || ctx.structure.adGroups.length === 0) {
      const message =
        "No hay estructura de campaña: el redactor de anuncios necesita los grupos del Arquitecto (A3) antes de escribir.";
      await helpers.emit("error", { agent: "rsa_copywriter", message });
      throw new LLMError(message);
    }

    const system = SYSTEM_PROMPT;
    const prompt = buildUserPrompt(ctx);

    let result;
    try {
      result = await callStructured<RSAOutput>({
        agentId: "rsa_copywriter",
        system,
        prompt,
        schema: OUTPUT_SCHEMA,
        toolName: "submit_rsa_ads",
        toolDescription:
          "Devuelve los anuncios RSA (15 títulos + 4 descripciones por grupo) respetando los límites de caracteres de Google.",
        temperature: 0.8,
        maxTokens: 8192,
        signal: helpers.signal,
      });
    } catch (err) {
      if (err instanceof LLMError) {
        await helpers.emit("error", {
          agent: "rsa_copywriter",
          message: err.message,
        });
      }
      throw err;
    }

    const raw = result.data;

    // Build a lookup so every structure group is matched even if the model
    // re-orders, renames slightly, or drops one.
    const byName = new Map<string, PlannedAdGroup>(
      ctx.structure.adGroups.map((g) => [g.name.toLowerCase(), g])
    );
    const rawByName = new Map<string, AdGroupAds>(
      (raw.ads ?? []).map((a) => [(a.adGroupName ?? "").toLowerCase(), a])
    );

    // ENFORCE limits in code for every planned ad group (source of truth = A3).
    let totalTruncations = 0;
    const enforcedAds: AdGroupAds[] = [];
    for (const group of ctx.structure.adGroups) {
      const proposed = rawByName.get(group.name.toLowerCase());
      if (!proposed) continue; // model skipped this group; cannot fabricate copy.
      const { ad, truncations } = enforceAdGroup(
        { ...proposed, adGroupName: group.name, finalUrl: group.landingPageUrl },
        group.landingPageUrl
      );
      // Only keep ads that still satisfy the minimums after repair.
      if (
        ad.headlines.length >= RSA_LIMITS.minHeadlines &&
        ad.descriptions.length >= RSA_LIMITS.minDescriptions
      ) {
        enforcedAds.push(ad);
        totalTruncations += truncations;
      }
    }

    const output: RSAOutput = {
      ads: enforcedAds,
      rationale: raw.rationale ?? "",
    };

    // ------------------------------------------------------------------
    // Persist: one search_ads row per ad group (this agent OWNS ad copy).
    // ------------------------------------------------------------------
    const campaignId = ctx.campaignId;
    let persisted = 0;
    if (campaignId) {
      for (const ad of output.ads) {
        const group = byName.get(ad.adGroupName.toLowerCase());
        const [row] = await adsDb
          .select({ id: adGroups.id })
          .from(adGroups)
          .where(
            and(
              eq(adGroups.campaignId, campaignId),
              eq(adGroups.name, ad.adGroupName)
            )
          )
          .limit(1);
        if (!row) continue;

        await adsDb.insert(searchAds).values({
          adGroupId: row.id,
          campaignId,
          headlines: ad.headlines,
          descriptions: ad.descriptions,
          finalUrls: [ad.finalUrl || group?.landingPageUrl || ""],
          path1: ad.path1 ?? null,
          path2: ad.path2 ?? null,
          status: "draft",
        });
        persisted += 1;
      }
    }

    await helpers.emit("decision", {
      agent: "rsa_copywriter",
      summary: `Escribí anuncios para ${output.ads.length} grupo(s): ${RSA_LIMITS.maxHeadlines} títulos y ${RSA_LIMITS.maxDescriptions} descripciones por grupo.${
        totalTruncations > 0
          ? ` Ajusté ${totalTruncations} texto(s) para respetar los límites de caracteres.`
          : ""
      }${persisted > 0 ? ` Guardé ${persisted} anuncio(s).` : ""}`,
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

export default a4RsaCopywriter;
