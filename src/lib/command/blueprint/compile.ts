import { createHash } from "crypto";
import type { CcBlueprintDoc } from "./schema";
import type {
  CcCreateActionType,
  CcEntityKind,
  CcPayload,
  CreateBudgetPayload,
  CreateCampaignPayload,
  CreateAdGroupPayload,
  CreateKeywordsPayload,
  CreateAdPayload,
} from "../types";

export interface CompiledAction {
  seq: number;
  localRef: string;
  actionType: CcCreateActionType;
  entityKind: CcEntityKind;
  entityRef: string;
  payload: CcPayload;
  recKey: string;
}

// Google Ads language constant IDs (languageConstants/<id>). Extend as the builder adds languages.
const LANGUAGE_CONSTANTS: Record<string, string> = {
  es: "1003",
  en: "1000",
  pt: "1014",
  fr: "1002",
  de: "1001",
  it: "1004",
};

const tmp = (ref: string) => `tmp:${ref}`;
function recKey(blueprintId: string, seq: number): string {
  return (
    "bp-" +
    createHash("sha256")
      .update(`${blueprintId}|${seq}`)
      .digest("hex")
      .slice(0, 14)
  );
}

export function compile(
  doc: CcBlueprintDoc,
  blueprintId: string
): CompiledAction[] {
  const out: CompiledAction[] = [];
  let seq = 0;
  const c = doc.campaign;
  const push = (
    actionType: CcCreateActionType,
    entityKind: CcEntityKind,
    localRef: string,
    payload: CcPayload
  ) => {
    out.push({
      seq,
      localRef,
      actionType,
      entityKind,
      entityRef: tmp(localRef),
      payload,
      recKey: recKey(blueprintId, seq),
    });
    seq += 1;
  };

  push(
    "create_budget",
    "campaign",
    c.budget.tempId,
    {
      name: `${c.name} — Presupuesto`,
      amountMicros: c.budget.dailyMicros,
    } as CreateBudgetPayload
  );
  const campaignPayload: CreateCampaignPayload = {
    name: c.name,
    status: "PAUSED",
    channel: "SEARCH",
    budgetRef: tmp(c.budget.tempId),
    bidding: c.bidding,
    geoTargetIds: c.geo.countryCodes,
    presenceOnly: c.geo.presenceOnly,
  };

  // Map languageCode to Google Ads language constant ID (fail-closed)
  if (c.languageCode) {
    const languageId = LANGUAGE_CONSTANTS[c.languageCode];
    if (!languageId) {
      throw new Error(`Idioma no soportado: ${c.languageCode}`);
    }
    campaignPayload.languageId = languageId;
  }

  push("create_campaign", "campaign", c.tempId, campaignPayload);
  for (const g of c.adGroups) {
    push(
      "create_ad_group",
      "ad_group",
      g.tempId,
      {
        name: g.name,
        campaignRef: tmp(c.tempId),
        cpcBidMicros: g.cpcMicros,
      } as CreateAdGroupPayload
    );
    push(
      "create_keywords",
      "ad_group",
      `${g.tempId}:kw`,
      {
        adGroupRef: tmp(g.tempId),
        keywords: [
          ...g.keywords.map((k) => ({ text: k.text, match: k.match })),
          ...g.negatives.map((k) => ({
            text: k.text,
            match: k.match,
            negative: true,
          })),
        ],
      } as CreateKeywordsPayload
    );
    for (const adNode of g.ads) {
      push(
        "create_ad",
        "ad",
        adNode.tempId,
        {
          adGroupRef: tmp(g.tempId),
          finalUrl: adNode.finalUrl,
          headlines: adNode.headlines,
          descriptions: adNode.descriptions,
          path1: adNode.path1,
          path2: adNode.path2,
        } as CreateAdPayload
      );
    }
  }
  return out;
}
