// ============================================================================
// A5 — POLICY / QA  (model: Opus, temperature ~0.2)
// ----------------------------------------------------------------------------
// The last gate before the Activator pushes anything to Google Ads. It reads
// the WHOLE plan (planner + keywords + structure + rsa) and returns a single
// verdict: pass | fix | block, plus a list of issues and a human-readable
// checklist. It is the senior PPC reviewer that protects the account from
// hard-limit violations, policy red-flags and broken landing pages.
//
// CONTRACT (see src/lib/engine/types.ts): export default an AgentDefinition.
// OUTPUT = QAOutput. PERSISTS NOTHING. Emits a 'gate' event with the verdict.
//
// SAFETY: this agent never enables a campaign and never mutates Google Ads. It
// only judges. A 'block' verdict stops the pipeline at an approval gate
// (handled by the orchestrator).
// ============================================================================

import { callStructured, LLMError, defaultAnthropicModel } from "@/lib/llm";
import {
  RSA_LIMITS,
  BUDGET,
  type AgentDefinition,
  type AgentResult,
  type AgentHelpers,
  type RunContext,
  type QAOutput,
} from "@/lib/engine/types";

const AGENT_ID = "policy_qa" as const;
const PROMPT_VERSION = "a5-policy-qa@1";

// ----------------------------------------------------------------------------
// JSON schema — mirrors QAOutput EXACTLY.
//   QAOutput {
//     verdict: "pass" | "fix" | "block";
//     issues: QAIssue[]            // severity, area, message, suggestion?, locator?
//     checklist: QAChecklistItem[] // name, ok, detail?
//     rationale: string;
//   }
// ----------------------------------------------------------------------------

const QA_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "checklist", "rationale"],
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "fix", "block"],
      description:
        "block = al menos una violación de límite duro o política grave; fix = mejorable pero publicable; pass = todo correcto.",
    },
    issues: {
      type: "array",
      description:
        "Lista de problemas detectados. Vacía solo si el plan está impecable.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "area", "message"],
        properties: {
          severity: {
            type: "string",
            enum: ["block", "fix", "warn"],
            description:
              "block = impide publicar; fix = corregir antes de activar; warn = aviso menor.",
          },
          area: {
            type: "string",
            description:
              "Área afectada: budget | bidding | structure | rsa_limits | policy | landing_page | geo | language | negatives | keywords | urls.",
          },
          message: {
            type: "string",
            description: "Qué está mal, en español claro y concreto.",
          },
          suggestion: {
            type: "string",
            description: "Cómo arreglarlo, en español claro. Opcional.",
          },
          locator: {
            type: "string",
            description:
              'Dónde está, p. ej. "adGroup[0].headline[4]" o "campaign.budget". Opcional.',
          },
        },
      },
    },
    checklist: {
      type: "array",
      description:
        "Resumen verificable de cada control. Una entrada por chequeo realizado.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "ok"],
        properties: {
          name: {
            type: "string",
            description: "Nombre corto del control en español.",
          },
          ok: {
            type: "boolean",
            description: "true si el control pasa.",
          },
          detail: {
            type: "string",
            description: "Detalle breve del resultado. Opcional.",
          },
        },
      },
    },
    rationale: {
      type: "string",
      description:
        "Explicación final en español sencillo: por qué este veredicto y qué debe hacer la persona.",
    },
  },
};

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "Eres el revisor SENIOR de calidad y política de una cuenta de Google Ads (Búsqueda).",
    "Llevas 15 años publicando campañas de Búsqueda y has visto rechazar miles por errores evitables.",
    "Tu trabajo NO es opinar de marketing: es proteger la cuenta antes de que se publique nada.",
    "Eres la última puerta antes de que el sistema empuje la campaña a Google (siempre EN PAUSA).",
    "",
    "Devuelves UN veredicto: pass | fix | block.",
    "  - block  → hay al menos una violación de LÍMITE DURO de Google o una política grave. NO se puede publicar tal cual.",
    "  - fix    → no hay violación dura, pero hay algo claramente mejorable que conviene corregir antes de activar.",
    "  - pass   → todo está correcto y listo para activar.",
    "",
    "Reglas de severidad (aplícalas sin excepción):",
    `  1) PRESUPUESTO: el presupuesto diario debe ser >= $${BUDGET.minDailyUsd}/día. Menos que eso = 'block' (área "budget").`,
    "  2) PUJA: la estrategia de puja debe ser coherente con el objetivo. Ej.: TARGET_CPA/MAXIMIZE_CONVERSIONS exigen objetivo de conversión (leads/sales/calls);",
    "     TARGET_ROAS/MAXIMIZE_CONVERSION_VALUE exigen valor de conversión (sales). Para tráfico puro suele bastar MAXIMIZE_CLICKS o MANUAL_CPC.",
    "     Si TARGET_CPA no trae targetCpaUsd, o TARGET_ROAS no trae targetRoas, eso es incoherente. Incoherencia razonable = 'fix'; sin sentido total = 'block' (área \"bidding\").",
    "  3) ESTRUCTURA: cada grupo de anuncios debe tener >= 1 keyword Y exactamente UN RSA. Cero keywords o cero/duplicado de RSA = 'block' (área \"structure\").",
    `  4) LÍMITES RSA (límites DUROS de Google): cada RSA con entre ${RSA_LIMITS.minHeadlines} y ${RSA_LIMITS.maxHeadlines} títulos y entre ${RSA_LIMITS.minDescriptions} y ${RSA_LIMITS.maxDescriptions} descripciones.`,
    `     Cada título <= ${RSA_LIMITS.headlineMaxChars} caracteres. Cada descripción <= ${RSA_LIMITS.descriptionMaxChars} caracteres. Path1/Path2 <= ${RSA_LIMITS.path1MaxChars} caracteres.`,
    "     CUALQUIER violación de carácter o de conteo mínimo/máximo = 'block' (área \"rsa_limits\"). Cuenta los caracteres tú mismo, uno a uno.",
    "  5) URLS: la finalUrl de cada anuncio y la landingPageUrl de cada grupo deben ser absolutas y empezar por https://. URL relativa, http:// o vacía = 'block' (área \"urls\"/\"landing_page\").",
    "  6) LANDING PAGE: debe existir una landing page (de campaña o por grupo). Si falta = 'block' (área \"landing_page\").",
    "  7) NEGATIVAS: debe haber keywords negativas (a nivel campaña/compartidas o por grupo). Si NO hay ninguna negativa = 'fix' (área \"negatives\").",
    "  8) DUPLICADOS: no puede haber la MISMA keyword exacta (mismo texto normalizado + mismo matchType EXACT) repetida en grupos distintos. Duplicado exacto = 'fix' (área \"keywords\"), porque compiten entre sí.",
    "  9) GEO + IDIOMA: deben estar definidos. geo.locations o geo.countryCodes vacíos, o languageCode vacío = 'fix' (área \"geo\"/\"language\").",
    " 10) POLÍTICA en el copy (títulos/descripciones): sin superlativos no respaldados (\"el mejor\", \"#1\", \"el número uno\") salvo que sean verificables;",
    "     sin afirmaciones médicas o de salud (curas, garantías de resultado); sin afirmaciones financieras engañosas (rentabilidad garantizada);",
    "     sin uso indebido de marcas de terceros; sin clickbait. Riesgo claro de rechazo = 'block'; riesgo leve/mejorable = 'fix' (área \"policy\").",
    "",
    "Cómo decidir el veredicto global:",
    "  - Si EXISTE cualquier issue con severity 'block' → verdict = 'block'.",
    "  - Si no hay 'block' pero existe algún 'fix' → verdict = 'fix'.",
    "  - Si solo hay 'warn' o nada → verdict = 'pass'.",
    "",
    "Devuelve también un checklist legible (una entrada por control) para que una persona no técnica entienda qué se revisó y si pasó.",
    "Sé exhaustivo pero honesto: no inventes problemas que no existen ni dejes pasar violaciones reales.",
    "TODO el texto que ve la persona (message, suggestion, detail, checklist.name, rationale) va en ESPAÑOL claro y sencillo.",
  ].join("\n");
}

function buildUserPrompt(ctx: RunContext): string {
  const planner = ctx.planner ?? null;
  const keywords = ctx.keywords ?? null;
  const structure = ctx.structure ?? null;
  const rsa = ctx.rsa ?? null;

  const limitsBlock = JSON.stringify(
    {
      budgetMinDailyUsd: BUDGET.minDailyUsd,
      rsa: {
        headlineMaxChars: RSA_LIMITS.headlineMaxChars,
        descriptionMaxChars: RSA_LIMITS.descriptionMaxChars,
        minHeadlines: RSA_LIMITS.minHeadlines,
        maxHeadlines: RSA_LIMITS.maxHeadlines,
        minDescriptions: RSA_LIMITS.minDescriptions,
        maxDescriptions: RSA_LIMITS.maxDescriptions,
        path1MaxChars: RSA_LIMITS.path1MaxChars,
        path2MaxChars: RSA_LIMITS.path2MaxChars,
      },
    },
    null,
    2
  );

  return [
    "Revisa el plan COMPLETO de esta campaña de Búsqueda y emite tu veredicto.",
    "",
    "=== MARCA (seed) ===",
    JSON.stringify(
      {
        brandName: ctx.brand?.brandName,
        brandWebsite: ctx.brand?.brandWebsite,
        landingPageUrl: ctx.brand?.landingPageUrl,
        objectiveHint: ctx.brand?.objectiveHint,
        geoHint: ctx.brand?.geoHint,
        languageHint: ctx.brand?.languageHint,
        budgetHintUsd: ctx.brand?.budgetHintUsd,
      },
      null,
      2
    ),
    "",
    "=== A1 — PLANNER (objetivo, geo/idioma, presupuesto, puja, temas, KPIs) ===",
    planner
      ? JSON.stringify(planner, null, 2)
      : "FALTA la salida del Planner. Trátalo como un problema grave de estructura.",
    "",
    "=== A2 — KEYWORDS (keywords + negativas) ===",
    keywords
      ? JSON.stringify(keywords, null, 2)
      : "FALTA la salida del investigador de keywords.",
    "",
    "=== A3 — ESTRUCTURA (campaña → grupos, keywords por grupo, negativas, landing pages) ===",
    structure
      ? JSON.stringify(structure, null, 2)
      : "FALTA la salida del arquitecto de estructura. Sin grupos no se puede publicar.",
    "",
    "=== A4 — RSA (títulos y descripciones por grupo, paths, finalUrl) ===",
    rsa
      ? JSON.stringify(rsa, null, 2)
      : "FALTA la salida del redactor de anuncios. Sin anuncios no se puede publicar.",
    "",
    "=== LÍMITES DUROS DE REFERENCIA (úsalos al pie de la letra) ===",
    limitsBlock,
    "",
    "Recuerda emparejar cada grupo de A3 con su RSA de A4 por el nombre del grupo (adGroupName === PlannedAdGroup.name).",
    "Cuenta los caracteres de cada título, descripción y path uno a uno. Verifica que cada grupo tenga >= 1 keyword y exactamente 1 RSA.",
    "Comprueba que todas las finalUrl y landingPageUrl sean absolutas y https. Busca keywords exactas duplicadas entre grupos.",
    "Emite issues[] con locator preciso, un checklist[] legible y un veredicto final coherente con las reglas de severidad.",
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Agent definition
// ----------------------------------------------------------------------------

const a5PolicyQa: AgentDefinition<QAOutput> = {
  id: AGENT_ID,
  title: "Revisor de calidad y política",
  model: defaultAnthropicModel("policy_qa"),
  kind: "llm",
  promptVersion: PROMPT_VERSION,

  async execute(
    ctx: RunContext,
    helpers: AgentHelpers
  ): Promise<AgentResult<QAOutput>> {
    const system = buildSystemPrompt();
    const prompt = buildUserPrompt(ctx);

    let result;
    try {
      result = await callStructured<QAOutput>({
        agentId: AGENT_ID,
        system,
        prompt,
        schema: QA_SCHEMA,
        toolName: "submit_qa_review",
        toolDescription:
          "Devuelve el veredicto (pass|fix|block), los problemas detectados, el checklist y la explicación.",
        temperature: 0.2,
        signal: helpers.signal,
      });
    } catch (e) {
      if (e instanceof LLMError) {
        await helpers.emit("error", { agent: AGENT_ID, message: e.message });
      }
      throw e;
    }

    const output = result.data;

    const blockers = output.issues.filter((i) => i.severity === "block").length;
    const fixes = output.issues.filter((i) => i.severity === "fix").length;
    const warns = output.issues.filter((i) => i.severity === "warn").length;

    await helpers.emit("decision", {
      agent: AGENT_ID,
      verdict: output.verdict,
      summary: `Veredicto: ${output.verdict.toUpperCase()} — ${blockers} bloqueante(s), ${fixes} a corregir, ${warns} aviso(s).`,
    });

    // Gate event carrying the verdict (the orchestrator stops on 'block').
    await helpers.emit("gate", {
      agent: AGENT_ID,
      verdict: output.verdict,
      blockers,
      fixes,
      warns,
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

export default a5PolicyQa;
