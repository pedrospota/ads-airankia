import { z } from "zod";
import { RSA_SPEC } from "../knowledge";
import { MICROS_PER_UNIT } from "../types";

const match = z.enum(["EXACT", "PHRASE", "BROAD"]);
const headline = z.object({ text: z.string().min(1).max(RSA_SPEC.headline.maxLen), pinnedField: z.string().optional() });
const description = z.object({ text: z.string().min(1).max(RSA_SPEC.description.maxLen) });

const ad = z.object({
  nodeId: z.string(), tempId: z.string(),
  finalUrl: z.string().url(),
  headlines: z.array(headline).min(RSA_SPEC.headline.min).max(RSA_SPEC.headline.max),
  descriptions: z.array(description).min(RSA_SPEC.description.min).max(RSA_SPEC.description.max),
  path1: z.string().max(RSA_SPEC.path.maxLen).optional(),
  path2: z.string().max(RSA_SPEC.path.maxLen).optional(),
});

const adGroup = z.object({
  nodeId: z.string(), tempId: z.string(), name: z.string().min(1), cpcMicros: z.number().int().optional(),
  keywords: z.array(z.object({ text: z.string().min(1), match })).min(1),
  negatives: z.array(z.object({ text: z.string().min(1), match })).default([]),
  ads: z.array(ad).min(1),
});

export const blueprintDocSchema = z.object({
  network: z.literal("google_ads"),
  campaign: z.object({
    nodeId: z.string(), tempId: z.string(), name: z.string().min(1),
    channel: z.literal("SEARCH"), status: z.literal("PAUSED"),
    budget: z.object({ nodeId: z.string(), tempId: z.string(), dailyMicros: z.number().int().min(MICROS_PER_UNIT) }),
    bidding: z.object({
      strategy: z.enum(["MAXIMIZE_CONVERSIONS", "TARGET_CPA", "TARGET_ROAS"]),
      targetCpaMicros: z.number().int().optional(), targetRoas: z.number().optional(),
    }).superRefine((data, ctx) => {
      if (data.strategy === "TARGET_CPA") {
        if (data.targetCpaMicros === undefined || data.targetCpaMicros <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "TARGET_CPA requiere targetCpaMicros > 0",
            path: ["targetCpaMicros"],
          });
        }
      } else if (data.strategy === "TARGET_ROAS") {
        if (data.targetRoas === undefined || data.targetRoas <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "TARGET_ROAS requiere targetRoas > 0",
            path: ["targetRoas"],
          });
        }
      }
    }),
    geo: z.object({ countryCodes: z.array(z.string().min(2)).min(1), presenceOnly: z.boolean() }),
    languageCode: z.string().optional(),
    adGroups: z.array(adGroup).min(1),
  }),
});

export type CcBlueprintDoc = z.infer<typeof blueprintDocSchema>;
export function parseBlueprint(doc: unknown): CcBlueprintDoc {
  return blueprintDocSchema.parse(doc);
}
