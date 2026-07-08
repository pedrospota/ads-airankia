import { z } from "zod";
import { RSA_SPEC } from "../knowledge";
import { MICROS_PER_UNIT } from "../types";

export const EDIT_BASELINE_MAX_AGE_MS = 60 * 60_000; // 60 min

// v2.7 BLAST_RADIUS batch bound (spec §b): the differ emits ONE batched action
// per ad group (keyword pauses/enables) / per campaign (negative removal), so
// BLAST_RADIUS's per-action counting can't cap an unbounded batch. The cap
// lives here, where the batch is formed: at most this many non-KEEP keyword
// dispositions per ad group, and at most this many negatives removed per
// campaign, per single edit-doc save.
export const EDIT_BATCH_MAX = 100;

const match = z.enum(["EXACT", "PHRASE", "BROAD"]);
const cpcFloorMicros = 10_000; // US$0.01 — mirrors gates.ts CURRENCY_SANITY's update_cpc floor

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

const existingAdGroup = z
  .object({
    resourceName: z.string(),
    id: z.string(),
    base: z.object({
      name: z.string(),
      status: z.enum(["ENABLED", "PAUSED"]),
      cpcBidMicros: z.number().int().nullable(),
    }),
    desired: z.object({
      status: z.enum(["ENABLED", "PAUSED"]),
      cpcBidMicros: z.number().int().min(cpcFloorMicros).nullable(),
    }),
    // status is server-owned (loaded from ad_group_criterion.status); desiredStatus
    // is the only client-writable field on a baseKeyword row (mergeEditDoc lifts it
    // per-row, matched by resourceName — see mergeEditDoc below).
    baseKeywords: z.array(
      kw.extend({
        resourceName: z.string(),
        negative: z.boolean(),
        status: z.enum(["ENABLED", "PAUSED"]),
        desiredStatus: z.enum(["ENABLED", "PAUSED"]).optional(),
      })
    ),
    newKeywords: z.array(kw.extend({ negative: z.boolean().default(false) })).default([]),
    ads: z.array(existingAd),
    newAds: z.array(newAd).default([]),
  })
  .superRefine((g, ctx) => {
    const changed = g.baseKeywords.filter((k) => k.desiredStatus !== undefined && k.desiredStatus !== k.status).length;
    if (changed > EDIT_BATCH_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `No se pueden pausar/reactivar más de ${EDIT_BATCH_MAX} keyword(s) por grupo de anuncios en un mismo guardado.`,
        path: ["baseKeywords"],
      });
    }
  });

// Server-owned campaign-level negative keyword criteria (loaded by the 5th
// GAQL in readCampaignTree). resourceName is what removeNegatives references.
const baseNegative = z.object({
  resourceName: z.string(),
  text: z.string(),
  match,
});

export const editDocSchema = z.object({
  docType: z.literal("google_search_edit_v1"),
  network: z.literal("google_ads"),
  accountRef: z.string(),
  loadedAt: z.string().datetime(),
  campaign: z
    .object({
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
      // Server-owned live negatives + the client's removal picks (resourceNames
      // only — text/match ride along in baseNegatives for the differ/UI).
      baseNegatives: z.array(baseNegative).default([]),
      removeNegatives: z.array(z.string()).default([]),
      adGroups: z.array(existingAdGroup),
    })
    .superRefine((c, ctx) => {
      if (c.removeNegatives.length > EDIT_BATCH_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `No se pueden quitar más de ${EDIT_BATCH_MAX} negativa(s) de campaña en un mismo guardado.`,
          path: ["removeNegatives"],
        });
      }
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
      baseNegatives: stored.campaign.baseNegatives, // Server-owned baseline
      // Client-owned, but two-layer guarded: filtered here to resourceNames the
      // server actually loaded (⊆ baseNegatives); the differ re-throws on any
      // resourceName that slips through (defense in depth, not redundancy).
      removeNegatives: incomingDoc.campaign.removeNegatives.filter((rn) =>
        stored.campaign.baseNegatives.some((n) => n.resourceName === rn)
      ),
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
        base: storedAdGroup.base, // Server-owned baseline (incl. cpcBidMicros)
        desired: incomingAdGroup.desired, // Client-owned (incl. cpcBidMicros)
        // Per-row merge (v2.7): every server-owned field (resourceName/text/match/
        // negative/status) comes from STORED; only desiredStatus is lifted from the
        // matching incoming row, matched by resourceName within the stored set.
        // Incoming rows with a resourceName the server never loaded are structurally
        // dropped — this loop only ever iterates storedAdGroup.baseKeywords.
        baseKeywords: storedAdGroup.baseKeywords.map((storedKw) => {
          const incomingKw = incomingAdGroup.baseKeywords.find((k) => k.resourceName === storedKw.resourceName);
          return { ...storedKw, desiredStatus: incomingKw?.desiredStatus };
        }),
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
