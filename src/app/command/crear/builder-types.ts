// Centro de Mando v2 — guided builder ("Constructor"). Pure helpers + types
// shared by builder-client.tsx / builder-steps.tsx / builder-preview.tsx.
// No hooks, no fetch — safe to import from any of those client modules.

import { RSA_SPEC } from "@/lib/command/knowledge";
import { MICROS_PER_UNIT } from "@/lib/command/types";
import type { CcBlueprintDoc } from "@/lib/command/blueprint/schema";

export type MatchType = "EXACT" | "PHRASE" | "BROAD";
export type BiddingStrategy = "MAXIMIZE_CONVERSIONS" | "TARGET_CPA" | "TARGET_ROAS";
export type Goal = "ventas" | "leads" | "trafico";

/** Account option surfaced to the client by the server page (Google only — the schema is google_ads-only for now). */
export interface CrearAccountOption {
  accountRef: string;
  name: string;
  connectionId: string;
  currency: string | null;
}

export interface KeywordEntry {
  text: string;
  match: MatchType;
}

/** Everything the builder form holds. Converted to a `CcBlueprintDoc` by `buildDoc()` on every save. */
export interface BuilderState {
  accountRef: string | null;
  goal: Goal;
  campaignName: string;
  dailyAmount: string; // currency units (not micros) — e.g. "350"
  bidding: BiddingStrategy;
  targetCpaAmount: string; // currency units
  targetRoas: string; // ratio, e.g. "4"
  countryCodes: string[];
  presenceOnly: boolean;
  languageCode: string;
  groupName: string;
  keywords: KeywordEntry[];
  negatives: KeywordEntry[];
  finalUrl: string;
  headlines: string[];
  descriptions: string[];
  path1: string;
  path2: string;
}

/** Stable per-session node/temp ids for every entity the doc creates. Generated once, reused across saves. */
export interface BuilderIds {
  budgetNodeId: string;
  budgetTempId: string;
  campaignNodeId: string;
  campaignTempId: string;
  adGroupNodeId: string;
  adGroupTempId: string;
  adNodeId: string;
  adTempId: string;
}

export const GOALS: Record<Goal, { label: string; hint: string }> = {
  ventas: { label: "Ventas", hint: "Compras en tu sitio" },
  leads: { label: "Contactos (leads)", hint: "Formularios, llamadas, WhatsApp" },
  trafico: { label: "Visitas al sitio", hint: "Tráfico calificado" },
};

// Matches the country set the Google adapter can resolve to a geoTargetConstant
// (src/lib/command/networks/google.ts COUNTRY_GEO) — an unsupported code fails
// the create at compile-time, so the picker only ever offers supported ones.
export const COUNTRY_LABELS: Record<string, string> = {
  MX: "México",
  ES: "España",
  US: "Estados Unidos",
  AR: "Argentina",
  CO: "Colombia",
  CL: "Chile",
  PE: "Perú",
};

// Matches compile.ts's LANGUAGE_CONSTANTS map — same fail-closed reasoning.
export const LANGUAGE_LABELS: Record<string, string> = {
  es: "Español",
  en: "Inglés",
  pt: "Portugués",
  fr: "Francés",
  de: "Alemán",
  it: "Italiano",
};

export const BIDDING_LABELS: Record<Extract<BiddingStrategy, "MAXIMIZE_CONVERSIONS" | "TARGET_CPA">, { label: string; hint: string }> = {
  MAXIMIZE_CONVERSIONS: { label: "Automática", hint: "Maximizar conversiones — recomendado para empezar" },
  TARGET_CPA: { label: "CPA objetivo", hint: "Solo con ≥30 conversiones en 30 días" },
};

export const DEFAULT_COUNTRY = "MX";
export const DEFAULT_LANGUAGE = "es";
export const BUDGET_CHIPS = [250, 350, 500] as const;

export function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function newBuilderIds(): BuilderIds {
  return {
    budgetNodeId: newId("budget"),
    budgetTempId: newId("budget"),
    campaignNodeId: newId("campaign"),
    campaignTempId: newId("campaign"),
    adGroupNodeId: newId("adgroup"),
    adGroupTempId: newId("adgroup"),
    adNodeId: newId("ad"),
    adTempId: newId("ad"),
  };
}

export function initialBuilderState(accountRef: string | null): BuilderState {
  return {
    accountRef,
    goal: "leads",
    campaignName: "",
    dailyAmount: "350",
    bidding: "MAXIMIZE_CONVERSIONS",
    targetCpaAmount: "",
    targetRoas: "",
    countryCodes: [DEFAULT_COUNTRY],
    presenceOnly: true,
    languageCode: DEFAULT_LANGUAGE,
    groupName: "",
    keywords: [],
    negatives: [],
    finalUrl: "",
    headlines: ["", "", ""], // RSA_SPEC.headline.min
    descriptions: ["", ""], // RSA_SPEC.description.min
    path1: "",
    path2: "",
  };
}

/** Strip a raw money input to digits/decimal, convert to micros. Returns 0 for empty/invalid. */
export function unitsToMicros(raw: string): number {
  const n = Number(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * MICROS_PER_UNIT);
}

export function formatMoney(amount: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: currency || "MXN",
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `$${amount.toLocaleString("es-MX")}`;
  }
}

/** Build the exact CcBlueprintDoc shape (see src/lib/command/blueprint/schema.ts). Always returns a full object — even
 * mid-edit while fields are still empty — so it can be both autosaved (server 400s on incomplete docs, surfaced inline)
 * and safeParse-checked client-side to drive validators. */
export function buildDoc(state: BuilderState, ids: BuilderIds): CcBlueprintDoc {
  const bidding: CcBlueprintDoc["campaign"]["bidding"] =
    state.bidding === "TARGET_CPA"
      ? { strategy: "TARGET_CPA", targetCpaMicros: unitsToMicros(state.targetCpaAmount) }
      : state.bidding === "TARGET_ROAS"
        ? { strategy: "TARGET_ROAS", targetRoas: Number(state.targetRoas) || 0 }
        : { strategy: "MAXIMIZE_CONVERSIONS" };

  return {
    network: "google_ads",
    campaign: {
      nodeId: ids.campaignNodeId,
      tempId: ids.campaignTempId,
      name: state.campaignName.trim(),
      channel: "SEARCH",
      status: "PAUSED",
      budget: {
        nodeId: ids.budgetNodeId,
        tempId: ids.budgetTempId,
        dailyMicros: unitsToMicros(state.dailyAmount),
      },
      bidding,
      geo: { countryCodes: state.countryCodes, presenceOnly: state.presenceOnly },
      languageCode: state.languageCode || undefined,
      adGroups: [
        {
          nodeId: ids.adGroupNodeId,
          tempId: ids.adGroupTempId,
          name: state.groupName.trim(),
          keywords: state.keywords
            .filter((k) => k.text.trim())
            .map((k) => ({ text: k.text.trim(), match: k.match })),
          negatives: state.negatives
            .filter((n) => n.text.trim())
            .map((n) => ({ text: n.text.trim(), match: n.match })),
          ads: [
            {
              nodeId: ids.adNodeId,
              tempId: ids.adTempId,
              finalUrl: state.finalUrl.trim(),
              headlines: state.headlines.filter((h) => h.trim()).map((h) => ({ text: h.trim() })),
              descriptions: state.descriptions.filter((d) => d.trim()).map((d) => ({ text: d.trim() })),
              path1: state.path1.trim() || undefined,
              path2: state.path2.trim() || undefined,
            },
          ],
        },
      ],
    },
  };
}

/** Human-readable Spanish reasons the doc isn't ready to review/publish yet — drives the disabled-button hint. */
export function missingSteps(state: BuilderState): string[] {
  const out: string[] = [];
  if (!state.accountRef) out.push("Selecciona una cuenta de Google Ads.");
  if (!state.campaignName.trim()) out.push("Escribe el nombre de la campaña.");
  if (unitsToMicros(state.dailyAmount) < MICROS_PER_UNIT) out.push("Define un presupuesto diario de al menos 1 unidad.");
  if (state.bidding === "TARGET_CPA" && unitsToMicros(state.targetCpaAmount) <= 0)
    out.push("Define un CPA objetivo mayor a cero.");
  if (state.countryCodes.length === 0) out.push("Elige al menos un país.");
  if (!state.groupName.trim()) out.push("Escribe el nombre del grupo de anuncios.");
  if (state.keywords.filter((k) => k.text.trim()).length === 0) out.push("Agrega al menos una palabra clave.");
  if (!state.finalUrl.trim()) out.push("Escribe la página de destino del anuncio.");
  const validHeadlines = state.headlines.filter((h) => h.trim() && h.trim().length <= RSA_SPEC.headline.maxLen);
  if (validHeadlines.length < RSA_SPEC.headline.min)
    out.push(`Completa al menos ${RSA_SPEC.headline.min} títulos (máx ${RSA_SPEC.headline.maxLen} caracteres).`);
  const validDescriptions = state.descriptions.filter(
    (d) => d.trim() && d.trim().length <= RSA_SPEC.description.maxLen
  );
  if (validDescriptions.length < RSA_SPEC.description.min)
    out.push(`Completa al menos ${RSA_SPEC.description.min} descripciones (máx ${RSA_SPEC.description.maxLen} caracteres).`);
  return out;
}

/** Left-tree subtitle lines, one per structure node (mirrors the mockup's live subs). */
export function treeSubs(state: BuilderState, ready: boolean): string[] {
  const keywordCount = state.keywords.filter((k) => k.text.trim()).length;
  return [
    GOALS[state.goal].label,
    `${formatMoney(Number(state.dailyAmount) || 0, null)} / día`,
    keywordCount > 0 ? `${keywordCount} palabra${keywordCount === 1 ? "" : "s"} clave` : "sin palabras clave",
    "1 anuncio (RSA)",
    ready ? "listo para publicar" : "faltan datos",
  ];
}

/** Free-form grounding text sent as `context` to /api/command/blueprint/suggest — same shape for every `kind`. */
export function suggestContext(state: BuilderState, accountName: string | null, extra?: string): string {
  const parts = [
    state.campaignName.trim() ? `Campaña: ${state.campaignName.trim()}` : null,
    `Objetivo: ${GOALS[state.goal].label}`,
    accountName ? `Cuenta: ${accountName}` : null,
    state.groupName.trim() ? `Grupo de anuncios: ${state.groupName.trim()}` : null,
    state.keywords.length ? `Palabras clave: ${state.keywords.map((k) => k.text).join(", ")}` : null,
    extra ?? null,
  ].filter((p): p is string => Boolean(p));
  return parts.join("\n");
}

/** Convert micros back to currency units as a string. Inverse of unitsToMicros. */
export function microsToUnits(micros: number): string {
  const units = micros / MICROS_PER_UNIT;
  return units.toString();
}

/** Inverse of buildDoc — reconstructs BuilderState from a CcBlueprintDoc.
 * All writable fields are sourced from the doc; UI-only fields (accountRef, goal) come from prev.
 * Fields not present in doc (undefined languageCode) are filled with defaults.
 */
export function stateFromDoc(doc: CcBlueprintDoc, prev: BuilderState): BuilderState {
  // Extract the single ad group and ad (builder only supports one of each)
  const adGroup = doc.campaign.adGroups[0];
  const ad = adGroup.ads[0];

  // Parse bidding strategy and target values
  let bidding: BiddingStrategy = "MAXIMIZE_CONVERSIONS";
  let targetCpaAmount = "";
  let targetRoas = "";

  if (doc.campaign.bidding.strategy === "TARGET_CPA") {
    bidding = "TARGET_CPA";
    targetCpaAmount = microsToUnits(doc.campaign.bidding.targetCpaMicros || 0);
  } else if (doc.campaign.bidding.strategy === "TARGET_ROAS") {
    bidding = "TARGET_ROAS";
    targetRoas = (doc.campaign.bidding.targetRoas || 0).toString();
  }

  return {
    // UI-only fields: preserved from prev
    accountRef: prev.accountRef,
    goal: prev.goal,

    // Campaign fields
    campaignName: doc.campaign.name,
    dailyAmount: microsToUnits(doc.campaign.budget.dailyMicros),
    bidding,
    targetCpaAmount,
    targetRoas,
    countryCodes: doc.campaign.geo.countryCodes,
    presenceOnly: doc.campaign.geo.presenceOnly,
    languageCode: doc.campaign.languageCode || DEFAULT_LANGUAGE,

    // Ad group fields
    groupName: adGroup.name,
    keywords: adGroup.keywords,
    negatives: adGroup.negatives,

    // Ad fields (extract text from headline/description objects)
    finalUrl: ad.finalUrl,
    headlines: ad.headlines.map((h) => h.text),
    descriptions: ad.descriptions.map((d) => d.text),
    path1: ad.path1 || "",
    path2: ad.path2 || "",
  };
}
