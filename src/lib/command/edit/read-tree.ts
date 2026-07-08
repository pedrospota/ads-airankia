// Command Center v2.3 edit-mode — PURE mapper from raw GAQL rows
// (RawCampaignTree, read via networks/google.ts#readCampaignTree) to the
// edit document the operator reviews (GoogleSearchEditDoc). No I/O, no
// Date.now()/new Date() — nowIso is injected by the caller (same purity
// rule as the v2 blueprint compiler). doc.campaign.base becomes the DRIFT
// baseline, so every field here must faithfully reflect the live account.
import type { RawCampaignTree } from "../networks/google";
import type { GoogleSearchEditDoc } from "./schema";

type Row = Record<string, unknown>;
type Status = "ENABLED" | "PAUSED";
type Match = "EXACT" | "PHRASE" | "BROAD";

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** GAQL int64 fields (cpc_bid_micros) come back as string|number|null|undefined; a
 * missing/unset bid (e.g. smart-bidding ad groups) must map to null, not 0. */
function optNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Fail-closed: the edit surface only models ENABLED/PAUSED entities. */
function requireEditableStatus(status: unknown, label: string): Status {
  if (status !== "ENABLED" && status !== "PAUSED") {
    throw new Error(`Estado de ${label} no soportado en este editor: ${String(status)}`);
  }
  return status;
}

function buildKeyword(row: Row) {
  const criterion = (row.adGroupCriterion ?? {}) as Row;
  const keyword = (criterion.keyword ?? {}) as Row;
  return {
    resourceName: str(criterion.resourceName),
    negative: Boolean(criterion.negative),
    text: str(keyword.text),
    match: str(keyword.matchType) as Match,
    // REMOVED rows are already excluded by the GAQL WHERE clause; anything else
    // unrecognized fails closed rather than silently defaulting a keyword's status.
    status: requireEditableStatus(criterion.status, "palabra clave"),
  };
}

function buildNegative(row: Row) {
  const criterion = (row.campaignCriterion ?? {}) as Row;
  const keyword = (criterion.keyword ?? {}) as Row;
  return {
    resourceName: str(criterion.resourceName),
    text: str(keyword.text),
    match: str(keyword.matchType) as Match,
  };
}

function buildAd(row: Row) {
  const adGroupAd = (row.adGroupAd ?? {}) as Row;
  const ad = (adGroupAd.ad ?? {}) as Row;
  const unsupported = ad.type !== "RESPONSIVE_SEARCH_AD";
  const rsa = (ad.responsiveSearchAd ?? {}) as Row;
  const finalUrls = ad.finalUrls as string[] | undefined;

  const headlines = unsupported
    ? []
    : ((rsa.headlines as Array<{ text: string }> | undefined) ?? []).map((h) => ({ text: h.text }));
  const descriptions = unsupported
    ? []
    : ((rsa.descriptions as Array<{ text: string }> | undefined) ?? []).map((d) => ({ text: d.text }));

  return {
    resourceName: str(adGroupAd.resourceName),
    unsupported,
    base: {
      status: requireEditableStatus(adGroupAd.status, "anuncio"),
      finalUrl: finalUrls?.[0],
      headlines,
      descriptions,
      path1: unsupported ? undefined : optStr(rsa.path1),
      path2: unsupported ? undefined : optStr(rsa.path2),
    },
    replacement: null,
  };
}

function buildAdGroup(agRow: Row, tree: RawCampaignTree) {
  const adGroup = (agRow.adGroup ?? {}) as Row;
  const id = str(adGroup.id);
  const status = requireEditableStatus(adGroup.status, "grupo de anuncios");
  // null for smart-bidding ad groups (no manual CPC); desired seeds from base
  // on load, same as status — the operator hasn't proposed anything yet.
  // Smart-bidding campaigns commonly report cpc_bid_micros as 0: the schema floors
  // desired.cpcBidMicros at 10_000, so seeding desired=base with a zero/sub-floor
  // value would make the FRESH doc fail its own parse and 404 the whole edit
  // workbench for that campaign. Coerce sub-floor to null = "puja automática".
  const rawCpc = optNum(adGroup.cpcBidMicros);
  const cpcBidMicros = rawCpc != null && rawCpc < 10_000 ? null : rawCpc;

  const baseKeywords = tree.keywords
    .filter((row) => str(((row as Row).adGroup as Row | undefined)?.id) === id)
    .map((row) => buildKeyword(row as Row));
  const ads = tree.ads
    .filter((row) => str(((row as Row).adGroup as Row | undefined)?.id) === id)
    .map((row) => buildAd(row as Row));

  return {
    resourceName: str(adGroup.resourceName),
    id,
    base: { name: str(adGroup.name), status, cpcBidMicros },
    desired: { status, cpcBidMicros },
    baseKeywords,
    newKeywords: [],
    ads,
    newAds: [],
  };
}

/**
 * PURE — no I/O, no Date.now(). desired mirrors base on load (the operator
 * hasn't proposed anything yet); new* arrays start empty. nowIso stamps
 * loadedAt, the DRIFT staleness clock (see EDIT_BASELINE_MAX_AGE_MS).
 */
export function buildEditDoc(tree: RawCampaignTree, accountRef: string, nowIso: string): GoogleSearchEditDoc {
  const campaign = (tree.campaign.campaign ?? {}) as Row;
  const budget = (tree.campaign.campaignBudget ?? {}) as Row;
  const customer = (tree.campaign.customer ?? {}) as Row;

  const status = requireEditableStatus(campaign.status, "campaña");
  const dailyBudgetMicros = num(budget.amountMicros);

  return {
    docType: "google_search_edit_v1",
    network: "google_ads",
    accountRef,
    loadedAt: nowIso,
    campaign: {
      resourceName: str(campaign.resourceName),
      id: str(campaign.id),
      base: {
        name: str(campaign.name),
        status,
        dailyBudgetMicros,
        budgetResourceName: str(campaign.campaignBudget),
        budgetShared: Boolean(budget.explicitlyShared),
        currency: typeof customer.currencyCode === "string" ? customer.currencyCode : null,
      },
      desired: { status, dailyBudgetMicros },
      newNegatives: [],
      baseNegatives: tree.campaignNegatives.map((row) => buildNegative(row as Row)),
      removeNegatives: [],
      adGroups: tree.adGroups.map((row) => buildAdGroup(row as Row, tree)),
    },
  };
}
