import { z } from "zod";
import { RSA_SPEC } from "../knowledge";
import { MICROS_PER_UNIT } from "../types";

const match = z.enum(["EXACT", "PHRASE", "BROAD"]);
// Exported for the patch chokepoint (src/lib/command/patch/schema.ts), which validates a
// propose_patch op's `value` against the SAME sub-schema the doc itself uses — never a
// re-typed duplicate. Behavior-identical to the pre-v2.4 inline shapes; only the name +
// `export` are new.
export const headlineSchema = z.object({ text: z.string().min(1).max(RSA_SPEC.headline.maxLen), pinnedField: z.string().optional() });
export const descriptionSchema = z.object({ text: z.string().min(1).max(RSA_SPEC.description.maxLen) });
export const keywordSchema = z.object({ text: z.string().min(1), match });

const ad = z.object({
  nodeId: z.string(), tempId: z.string(),
  finalUrl: z.string().url(),
  headlines: z.array(headlineSchema).min(RSA_SPEC.headline.min).max(RSA_SPEC.headline.max),
  descriptions: z.array(descriptionSchema).min(RSA_SPEC.description.min).max(RSA_SPEC.description.max),
  path1: z.string().max(RSA_SPEC.path.maxLen).optional(),
  path2: z.string().max(RSA_SPEC.path.maxLen).optional(),
});

const adGroup = z.object({
  nodeId: z.string(), tempId: z.string(), name: z.string().min(1), cpcMicros: z.number().int().optional(),
  keywords: z.array(keywordSchema).min(1),
  negatives: z.array(keywordSchema).default([]),
  ads: z.array(ad).min(1),
});

// Exported (patch chokepoint reuse — see headlineSchema comment above).
export const biddingSchema = z.object({
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
});

export const geoSchema = z.object({ countryCodes: z.array(z.string().min(2)).min(1), presenceOnly: z.boolean() });

export const blueprintDocSchema = z.object({
  network: z.literal("google_ads"),
  campaign: z.object({
    nodeId: z.string(), tempId: z.string(), name: z.string().min(1),
    channel: z.literal("SEARCH"), status: z.literal("PAUSED"),
    budget: z.object({ nodeId: z.string(), tempId: z.string(), dailyMicros: z.number().int().min(MICROS_PER_UNIT) }),
    bidding: biddingSchema,
    geo: geoSchema,
    languageCode: z.string().optional(),
    adGroups: z.array(adGroup).min(1),
  }),
});

export type CcBlueprintDoc = z.infer<typeof blueprintDocSchema>;
export function parseBlueprint(doc: unknown): CcBlueprintDoc {
  return blueprintDocSchema.parse(doc);
}
