import { z } from "zod";
import { META_LINK_AD_SPEC } from "../knowledge";
import { MICROS_PER_UNIT, MICROS_PER_MINOR_UNIT } from "../types";

const ad = z.object({
  nodeId: z.string(),
  tempId: z.string(),
  name: z.string().min(1),
  link: z.string().url(),
  message: z.string().min(1).max(META_LINK_AD_SPEC.message.maxLen),
  headline: z.string().max(META_LINK_AD_SPEC.headline.maxLen).optional(),
  description: z.string().max(META_LINK_AD_SPEC.description.maxLen).optional(),
  callToActionType: z
    .enum(["LEARN_MORE", "CONTACT_US", "SHOP_NOW", "SIGN_UP", "GET_QUOTE"])
    .optional(),
  imageUrl: z.string().url().startsWith("https://").optional(),
});

const adset = z.object({
  nodeId: z.string(),
  tempId: z.string(),
  name: z.string().min(1),
  status: z.literal("PAUSED"),
  dailyBudgetMicros: z
    .number()
    .int()
    .min(MICROS_PER_UNIT)
    .multipleOf(MICROS_PER_MINOR_UNIT),
  targeting: z
    .object({
      countryCodes: z
        .array(z.enum(["MX", "US", "AR", "CO", "CL", "PE"]))
        .min(1),
      ageMin: z.number().int().min(18).max(65).default(18),
      ageMax: z.number().int().min(18).max(65).default(65),
    })
    .refine((t) => t.ageMin <= t.ageMax, { message: "ageMin ≤ ageMax" }),
  ads: z.array(ad).min(1),
});

export const metaBlueprintDocSchema = z.object({
  network: z.literal("meta_ads"),
  campaign: z.object({
    nodeId: z.string(),
    tempId: z.string(),
    name: z.string().min(1),
    status: z.literal("PAUSED"),
    objective: z.literal("OUTCOME_TRAFFIC"),
    adsets: z.array(adset).length(1),
  }),
});

export type CcMetaBlueprintDoc = z.infer<typeof metaBlueprintDocSchema>;

export function parseMetaBlueprint(doc: unknown): CcMetaBlueprintDoc {
  return metaBlueprintDocSchema.parse(doc);
}
