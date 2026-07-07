// ============================================================================
// Per-field AI suggest — Command Center v2 blueprint editor.
// ----------------------------------------------------------------------------
// Given ONE field the operator is filling in (an ad-group name, a batch of
// keywords, an RSA headline or an RSA description), ask the AI for a value
// that ALREADY respects Google's limits (grounded in RSA_SPEC), then
// re-validate + CLAMP the result in code. The AI never gets the final word on
// what ships — a value that violates the field's limits is truncated/repaired
// here and a GateResult warning documents exactly what changed. The human
// operator still has to accept the suggestion; nothing here executes anything.
// ============================================================================

import { z } from "zod";
import { callStructured } from "@/lib/llm";
import type { UnifiedStructuredParams, UnifiedStructuredResult } from "@/lib/llm";
import { RSA_SPEC } from "../knowledge";
import type { GateResult } from "../types";

export type SuggestKind = "group_name" | "keywords" | "headline" | "description";

export interface SuggestInput {
  kind: SuggestKind;
  /** Free-form grounding context supplied by the caller (business, theme, ad group, etc). */
  context?: string;
}

export interface KeywordSuggestion {
  text: string;
  matchType: "EXACT" | "PHRASE" | "BROAD";
}

export type SuggestValue = string | KeywordSuggestion[];

export interface SuggestOutput {
  value: SuggestValue;
  warnings: GateResult[];
}

/** Same call shape as `callStructured` — the real function is the default. */
type CallFn = <T>(p: UnifiedStructuredParams) => Promise<UnifiedStructuredResult<T>>;

export interface SuggestDeps {
  call?: CallFn;
}

// ----------------------------------------------------------------------------
// Field limits. Headline/description/path come straight from RSA_SPEC (the
// same constant the blueprint Zod schema and Google's own API enforce). Group
// names and keyword text don't have a published RSA_SPEC entry, so we use a
// conservative, generous operational cap — well above what a good name/keyword
// ever needs — purely so a misbehaving model can never smuggle through
// something unbounded.
// ----------------------------------------------------------------------------
const GROUP_NAME_MAX = 80;
const KEYWORD_TEXT_MAX = 80;
const KEYWORD_COUNT = { min: 1, max: 10 } as const;

const MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"] as const;
const matchTypeSchema = z.enum(MATCH_TYPES);

const groupNameSchema = z.string().trim().min(1).max(GROUP_NAME_MAX);
const headlineSchema = z.string().trim().min(1).max(RSA_SPEC.headline.maxLen);
const descriptionSchema = z.string().trim().min(1).max(RSA_SPEC.description.maxLen);
const keywordsSchema = z
  .array(z.object({ text: z.string().trim().min(1).max(KEYWORD_TEXT_MAX), matchType: matchTypeSchema }))
  .min(KEYWORD_COUNT.min)
  .max(KEYWORD_COUNT.max);

function isMatchType(v: unknown): v is (typeof MATCH_TYPES)[number] {
  return typeof v === "string" && (MATCH_TYPES as readonly string[]).includes(v);
}

// ----------------------------------------------------------------------------
// Enforcement helpers — mirror a4-rsa-copywriter.ts's word-boundary truncation
// so clamped text never reads as if it was cut mid-word.
// ----------------------------------------------------------------------------

/** Truncate to maxChars at a word boundary; falls back to a hard cut. Never empty for non-empty input. */
function truncateAtWord(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const candidate = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return candidate.replace(/[\s,;:.!¡¿?-]+$/u, "").trim() || cut.trim();
}

function gateWarning(id: string, evidence: string): GateResult {
  return { id, severity: "warning", status: "fail", evidence };
}

/**
 * Clamp a single free-text field (group name / headline / description) to
 * maxLen at a word boundary. Falls back to `fallback` when the AI returned
 * nothing usable. Returns the clamped value plus any warnings documenting
 * what had to change.
 */
function clampBoundedString(
  kindLabel: string,
  raw: unknown,
  maxLen: number,
  fallback: string
): { value: string; warnings: GateResult[] } {
  const warnings: GateResult[] = [];
  const original = typeof raw === "string" ? raw.trim() : "";

  if (!original) {
    warnings.push(
      gateWarning(
        `SUGGEST_${kindLabel}_EMPTY`,
        `La IA no devolvió texto utilizable para "${kindLabel}"; se usó un valor de reserva.`
      )
    );
  }

  const source = original || fallback;
  const value = truncateAtWord(source, maxLen);

  if (original && value.length < original.length) {
    warnings.push(
      gateWarning(
        `SUGGEST_${kindLabel}_CLAMPED`,
        `"${kindLabel}" recortado de ${original.length} a ${value.length} caracteres (límite ${maxLen}).`
      )
    );
  }

  return { value, warnings };
}

/** Clamp a keyword-suggestion array: cap count, cap each text's length, dedupe, never empty. */
function clampKeywords(
  raw: unknown,
  contextHint: string
): { value: KeywordSuggestion[]; warnings: GateResult[] } {
  const warnings: GateResult[] = [];
  const list = Array.isArray(raw) ? raw : [];

  const seen = new Set<string>();
  let anyClamped = false;
  const items: KeywordSuggestion[] = [];

  for (const entry of list) {
    if (items.length >= KEYWORD_COUNT.max) break;
    const e = entry as { text?: unknown; matchType?: unknown } | null;
    const original = typeof e?.text === "string" ? e.text.trim() : "";
    if (!original) continue;

    const text = truncateAtWord(original, KEYWORD_TEXT_MAX);
    if (text.length < original.length) anyClamped = true;

    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);

    items.push({ text, matchType: isMatchType(e?.matchType) ? e.matchType : "PHRASE" });
  }

  if (Array.isArray(raw) && raw.length > items.length && !anyClamped) {
    // Items were dropped for being empty/duplicate/over the count cap, not clamped for length.
    anyClamped = true;
  }
  if (anyClamped) {
    warnings.push(
      gateWarning(
        "SUGGEST_KEYWORDS_CLAMPED",
        `Se ajustaron las keywords al límite (máx ${KEYWORD_COUNT.max} términos, ${KEYWORD_TEXT_MAX} caracteres cada uno).`
      )
    );
  }

  if (items.length === 0) {
    const fallbackText = truncateAtWord(contextHint || "servicio principal", KEYWORD_TEXT_MAX) || "servicio principal";
    items.push({ text: fallbackText, matchType: "PHRASE" });
    warnings.push(
      gateWarning("SUGGEST_KEYWORDS_EMPTY", "La IA no devolvió keywords válidas; se usó un valor de reserva.")
    );
  }

  return { value: items, warnings };
}

// ----------------------------------------------------------------------------
// Prompts — Spanish (es-MX), grounded in RSA_SPEC + the caller's context.
// ----------------------------------------------------------------------------

function contextBlock(context: string): string {
  return context ? `Contexto del negocio/tema:\n${context}` : "Contexto del negocio/tema: (ninguno proporcionado)";
}

const GROUP_NAME_SYSTEM =
  "Eres un estratega senior de Google Ads en español (es-MX). Propones nombres de grupos de anuncios claros, " +
  "específicos y fáciles de auditar por un humano (reflejan el tema/intención del grupo, no genéricos como " +
  "\"Grupo 1\"). Nada de emojis, mayúsculas sostenidas ni caracteres especiales innecesarios.";

function groupNamePrompt(context: string): string {
  return [
    `Propón UN nombre de grupo de anuncios de Google Ads, de máximo ${GROUP_NAME_MAX} caracteres.`,
    "Debe ser descriptivo del tema/intención del grupo (p. ej. por producto, servicio o intención de búsqueda).",
    "",
    contextBlock(context),
  ].join("\n");
}

const KEYWORDS_SYSTEM =
  "Eres un investigador senior de keywords de Google Ads en español (es-MX). Propones términos de búsqueda " +
  "reales que usaría un cliente potencial, con el tipo de concordancia (matchType) más razonable para cada uno " +
  "(EXACT, PHRASE o BROAD). Evita términos genéricos de una sola palabra y evita duplicados.";

function keywordsPrompt(context: string): string {
  return [
    `Propón entre ${KEYWORD_COUNT.min} y ${KEYWORD_COUNT.max} keywords para un grupo de anuncios de Google Ads.`,
    `Cada texto de keyword debe tener como máximo ${KEYWORD_TEXT_MAX} caracteres.`,
    "Asigna a cada una el matchType (EXACT, PHRASE o BROAD) más adecuado según la intención de búsqueda.",
    "",
    contextBlock(context),
  ].join("\n");
}

const HEADLINE_SYSTEM =
  "Eres un copywriter senior de Google Ads (Responsive Search Ads) en español (es-MX). Conoces los límites " +
  "duros de Google al detalle y jamás los rebasas. Escribes titulares persuasivos: beneficio, diferenciador, " +
  "CTA, prueba social o urgencia — nunca genéricos. Nada de superlativos prohibidos (\"el mejor\", \"100% " +
  "garantizado\", \"#1\"), nada de mayúsculas sostenidas ni signos de exclamación repetidos.";

function headlinePrompt(context: string): string {
  return [
    `Propón UN titular de RSA (Responsive Search Ad) de máximo ${RSA_SPEC.headline.maxLen} caracteres, contando espacios.`,
    "Cuenta los caracteres tú mismo antes de responder. Si tienes duda, acórtalo.",
    "",
    contextBlock(context),
  ].join("\n");
}

const DESCRIPTION_SYSTEM =
  "Eres un copywriter senior de Google Ads (Responsive Search Ads) en español (es-MX). Conoces los límites " +
  "duros de Google al detalle y jamás los rebasas. Escribes descripciones que amplían el valor (no repiten el " +
  "titular): un beneficio, una prueba/confianza, un CTA o una oferta/diferenciador.";

function descriptionPrompt(context: string): string {
  return [
    `Propón UNA descripción de RSA (Responsive Search Ad) de máximo ${RSA_SPEC.description.maxLen} caracteres, contando espacios.`,
    "Cuenta los caracteres tú mismo antes de responder. Si tienes duda, acórtala.",
    "",
    contextBlock(context),
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Tool (JSON) schemas — each wraps the field's value under a single `value`
// property so the forced tool-call always returns an object at the root.
// ----------------------------------------------------------------------------

const GROUP_NAME_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: {
    value: {
      type: "string",
      maxLength: GROUP_NAME_MAX,
      description: "Nombre sugerido del grupo de anuncios.",
    },
  },
};

const KEYWORDS_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: {
    value: {
      type: "array",
      minItems: KEYWORD_COUNT.min,
      maxItems: KEYWORD_COUNT.max,
      description: "Keywords sugeridas para el grupo de anuncios.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "matchType"],
        properties: {
          text: { type: "string", maxLength: KEYWORD_TEXT_MAX },
          matchType: { type: "string", enum: [...MATCH_TYPES] },
        },
      },
    },
  },
};

const HEADLINE_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: {
    value: {
      type: "string",
      maxLength: RSA_SPEC.headline.maxLen,
      description: "Titular sugerido de RSA.",
    },
  },
};

const DESCRIPTION_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: {
    value: {
      type: "string",
      maxLength: RSA_SPEC.description.maxLen,
      description: "Descripción sugerida de RSA.",
    },
  },
};

// ----------------------------------------------------------------------------
// suggestField
// ----------------------------------------------------------------------------

export async function suggestField(
  input: SuggestInput,
  deps: SuggestDeps = {}
): Promise<SuggestOutput> {
  const call = deps.call ?? callStructured;
  const context = (input.context ?? "").trim();

  switch (input.kind) {
    case "group_name": {
      const { data } = await call<{ value: unknown }>({
        agentId: "structure_architect",
        system: GROUP_NAME_SYSTEM,
        prompt: groupNamePrompt(context),
        schema: GROUP_NAME_TOOL_SCHEMA,
        toolName: "suggest_group_name",
        toolDescription: "Devuelve UN nombre sugerido para el grupo de anuncios.",
        maxTokens: 200,
        temperature: 0.6,
      });
      const { value, warnings } = clampBoundedString(
        "GROUP_NAME",
        data?.value,
        GROUP_NAME_MAX,
        "Grupo principal"
      );
      return { value: groupNameSchema.parse(value), warnings };
    }

    case "keywords": {
      const { data } = await call<{ value: unknown }>({
        agentId: "keyword_researcher",
        system: KEYWORDS_SYSTEM,
        prompt: keywordsPrompt(context),
        schema: KEYWORDS_TOOL_SCHEMA,
        toolName: "suggest_keywords",
        toolDescription: "Devuelve una lista de keywords sugeridas con su matchType.",
        maxTokens: 500,
        temperature: 0.6,
      });
      const { value, warnings } = clampKeywords(data?.value, context);
      return { value: keywordsSchema.parse(value), warnings };
    }

    case "headline": {
      const { data } = await call<{ value: unknown }>({
        agentId: "rsa_copywriter",
        system: HEADLINE_SYSTEM,
        prompt: headlinePrompt(context),
        schema: HEADLINE_TOOL_SCHEMA,
        toolName: "suggest_headline",
        toolDescription: "Devuelve UN titular sugerido de RSA.",
        maxTokens: 200,
        temperature: 0.7,
      });
      const { value, warnings } = clampBoundedString(
        "HEADLINE",
        data?.value,
        RSA_SPEC.headline.maxLen,
        "Solicita tu cotización hoy"
      );
      return { value: headlineSchema.parse(value), warnings };
    }

    case "description": {
      const { data } = await call<{ value: unknown }>({
        agentId: "rsa_copywriter",
        system: DESCRIPTION_SYSTEM,
        prompt: descriptionPrompt(context),
        schema: DESCRIPTION_TOOL_SCHEMA,
        toolName: "suggest_description",
        toolDescription: "Devuelve UNA descripción sugerida de RSA.",
        maxTokens: 300,
        temperature: 0.7,
      });
      const { value, warnings } = clampBoundedString(
        "DESCRIPTION",
        data?.value,
        RSA_SPEC.description.maxLen,
        "Contáctanos hoy y recibe atención personalizada."
      );
      return { value: descriptionSchema.parse(value), warnings };
    }

    default: {
      const _exhaustive: never = input.kind;
      throw new Error(`Tipo de sugerencia desconocido: ${String(_exhaustive)}`);
    }
  }
}

// Exported for the route's mandatory server-side re-validation (never trust a
// value round-tripped through the client).
export const SUGGEST_SCHEMAS = {
  group_name: groupNameSchema,
  keywords: keywordsSchema,
  headline: headlineSchema,
  description: descriptionSchema,
} as const;
