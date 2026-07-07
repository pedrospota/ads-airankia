import { z } from "zod";
import { RSA_SPEC } from "../knowledge";
import { MICROS_PER_UNIT } from "../types";

export const EDIT_BASELINE_MAX_AGE_MS = 60 * 60_000; // 60 min

const match = z.enum(["EXACT", "PHRASE", "BROAD"]);

// Define headline and description shapes identical to blueprint/schema.ts lines 6-7
const headline = z.object({ text: z.string().min(1).max(RSA_SPEC.headline.maxLen), pinnedField: z.string().optional() });
const description = z.object({ text: z.string().min(1).max(RSA_SPEC.description.maxLen) });

const kw = z.object({ text: z.string().min(1), match });

const newAd = z.object({
  tempId: z.string(),
  finalUrl: z.string().url(),
  headlines: z.array(headline).min(RSA_SPEC.headline.min).max(RSA_SPEC.headline.max),
  descriptions: z.array(description).min(RSA_SPEC.description.min).max(RSA_SPEC.description.max),
  path1: z.string().optional(),
  path2: z.string().optional(),
});

const existingAd = z.object({
  resourceName: z.string(),
  unsupported: z.boolean().default(false),
  base: z.object({
    status: z.enum(["ENABLED", "PAUSED"]),
    finalUrl: z.string().optional(),
    headlines: z.array(headline),
    descriptions: z.array(description),
    path1: z.string().optional(),
    path2: z.string().optional(),
  }),
  replacement: newAd.nullable().default(null),
});

const existingAdGroup = z.object({
  resourceName: z.string(),
  id: z.string(),
  base: z.object({
    name: z.string(),
    status: z.enum(["ENABLED", "PAUSED"]),
  }),
  desired: z.object({
    status: z.enum(["ENABLED", "PAUSED"]),
  }),
  baseKeywords: z.array(kw.extend({ resourceName: z.string(), negative: z.boolean() })),
  newKeywords: z.array(kw.extend({ negative: z.boolean().default(false) })).default([]),
  ads: z.array(existingAd),
  newAds: z.array(newAd).default([]),
});

export const editDocSchema = z.object({
  docType: z.literal("google_search_edit_v1"),
  network: z.literal("google_ads"),
  accountRef: z.string(),
  loadedAt: z.string().datetime(),
  campaign: z.object({
    resourceName: z.string(),
    id: z.string(),
    base: z.object({
      name: z.string(),
      status: z.enum(["ENABLED", "PAUSED"]),
      dailyBudgetMicros: z.number().int(),
      budgetResourceName: z.string(),
      budgetShared: z.boolean(),
      currency: z.string().nullable(),
    }),
    desired: z.object({
      status: z.enum(["ENABLED", "PAUSED"]),
      dailyBudgetMicros: z.number().int().min(MICROS_PER_UNIT),
    }),
    newNegatives: z.array(kw).default([]),
    adGroups: z.array(existingAdGroup),
  }),
});

export type GoogleSearchEditDoc = z.infer<typeof editDocSchema>;

export function parseEditDoc(input: unknown): GoogleSearchEditDoc {
  return editDocSchema.parse(input);
}

export function mergeEditDoc(stored: GoogleSearchEditDoc, incoming: unknown): GoogleSearchEditDoc {
  // Parse incoming with editDocSchema first (throw on invalid)
  const incomingDoc = editDocSchema.parse(incoming);

  // Build the result FROM stored, preserving server-owned fields
  const result: GoogleSearchEditDoc = {
    docType: stored.docType,
    network: stored.network,
    accountRef: stored.accountRef,
    loadedAt: stored.loadedAt, // Server-owned, must not be changed
    campaign: {
      resourceName: stored.campaign.resourceName, // Server-owned
      id: stored.campaign.id, // Server-owned
      base: stored.campaign.base, // Server-owned baseline, cannot be modified
      desired: incomingDoc.campaign.desired, // Client-owned
      newNegatives: incomingDoc.campaign.newNegatives, // Client-owned
      adGroups: [],
    },
  };

  // Process ad groups: match by resourceName from stored, only include those present in stored
  for (const storedAdGroup of stored.campaign.adGroups) {
    // Find matching ad group in incoming by resourceName
    const incomingAdGroup = incomingDoc.campaign.adGroups.find(
      (ag) => ag.resourceName === storedAdGroup.resourceName
    );

    if (incomingAdGroup) {
      // Ad group exists in both - merge it
      const mergedAdGroup: typeof storedAdGroup = {
        resourceName: storedAdGroup.resourceName, // Server-owned
        id: storedAdGroup.id, // Server-owned
        base: storedAdGroup.base, // Server-owned baseline
        desired: incomingAdGroup.desired, // Client-owned
        baseKeywords: storedAdGroup.baseKeywords, // Server-owned
        newKeywords: incomingAdGroup.newKeywords, // Client-owned
        ads: [],
        newAds: incomingAdGroup.newAds, // Client-owned
      };

      // Process ads: match by resourceName from stored
      for (const storedAd of storedAdGroup.ads) {
        const incomingAd = incomingAdGroup.ads.find((a) => a.resourceName === storedAd.resourceName);

        if (incomingAd) {
          // Ad exists in both - copy replacement from incoming if present
          mergedAdGroup.ads.push({
            resourceName: storedAd.resourceName, // Server-owned
            unsupported: storedAd.unsupported, // Server-owned
            base: storedAd.base, // Server-owned baseline
            replacement: incomingAd.replacement, // Client-owned
          });
        } else {
          // Ad only in stored - preserve as-is
          mergedAdGroup.ads.push(storedAd);
        }
      }

      result.campaign.adGroups.push(mergedAdGroup);
    } else {
      // Ad group only in stored - preserve as-is
      result.campaign.adGroups.push(storedAdGroup);
    }
  }

  return result;
}
