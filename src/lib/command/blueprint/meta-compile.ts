import type { CcMetaBlueprintDoc } from "./meta-schema";
import type {
  MetaCreateCampaignPayload,
  MetaCreateAdsetPayload,
  MetaCreateAdPayload,
} from "../types";
import { CompiledAction, tmp, recKey } from "./compile";

export function compileMeta(
  doc: CcMetaBlueprintDoc,
  blueprintId: string
): CompiledAction[] {
  const out: CompiledAction[] = [];
  let seq = 0;
  const seenTempIds = new Set<string>();

  const push = (
    actionType: "create_campaign" | "create_adset" | "create_ad",
    entityKind: "campaign" | "adset" | "ad",
    localRef: string,
    payload: MetaCreateCampaignPayload | MetaCreateAdsetPayload | MetaCreateAdPayload
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

  const c = doc.campaign;

  // Check for duplicate tempId in campaign
  if (seenTempIds.has(c.tempId)) {
    throw new Error(`tempId duplicado: ${c.tempId}`);
  }
  seenTempIds.add(c.tempId);

  // Emit create_campaign
  const campaignPayload: MetaCreateCampaignPayload = {
    name: c.name,
    status: "PAUSED",
    objective: "OUTCOME_TRAFFIC",
    buyingType: "AUCTION",
    specialAdCategories: [],
  };
  push("create_campaign", "campaign", c.tempId, campaignPayload);

  // Process adsets (schema guarantees exactly 1)
  for (const adset of c.adsets) {
    // Check for duplicate tempId in adset
    if (seenTempIds.has(adset.tempId)) {
      throw new Error(`tempId duplicado: ${adset.tempId}`);
    }
    seenTempIds.add(adset.tempId);

    // Emit create_adset
    const adsetPayload: MetaCreateAdsetPayload = {
      name: adset.name,
      status: "PAUSED",
      campaignRef: tmp(c.tempId),
      dailyBudgetMicros: adset.dailyBudgetMicros,
      optimizationGoal: "LINK_CLICKS",
      billingEvent: "IMPRESSIONS",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: {
        countryCodes: adset.targeting.countryCodes,
        ageMin: adset.targeting.ageMin,
        ageMax: adset.targeting.ageMax,
      },
    };
    push("create_adset", "adset", adset.tempId, adsetPayload);

    // Process ads
    for (const ad of adset.ads) {
      // Check for duplicate tempId in ads
      if (seenTempIds.has(ad.tempId)) {
        throw new Error(`tempId duplicado: ${ad.tempId}`);
      }
      seenTempIds.add(ad.tempId);

      // Emit create_ad
      const adPayload: MetaCreateAdPayload = {
        name: ad.name,
        status: "ACTIVE",
        adsetRef: tmp(adset.tempId),
        creative: {
          link: ad.link,
          message: ad.message,
          ...(ad.headline && { headline: ad.headline }),
          ...(ad.description && { description: ad.description }),
          ...(ad.callToActionType && { callToActionType: ad.callToActionType }),
          ...(ad.imageUrl && { imageUrl: ad.imageUrl }),
        },
      };
      push("create_ad", "ad", ad.tempId, adPayload);
    }
  }

  return out;
}
