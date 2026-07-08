// Command Center meta-edit — doc schema + blast-bound merge for editing a LIVE
// Meta campaign (docType "meta_edit_v1", sibling of google_search_edit_v1).
// Uniform base/desired at all 3 levels (campaign → adsets → ads); `desired` is
// the ONLY client-writable family — everything else is server-owned and
// rebuilt from the stored doc on every save (see mergeMetaEditDoc).
import { z } from "zod";
import { MICROS_PER_MINOR_UNIT, MICROS_PER_UNIT } from "../types";

// TTL: the SHARED baseline clock — repo.ts reads top-level `loadedAt` through
// one code path for both edit docTypes. Re-exported (never re-declared) so a
// future TTL change can't fork the two editors.
export { EDIT_BASELINE_MAX_AGE_MS } from "./schema";

// Mapped from Graph CONFIGURED `status` (ACTIVE→ENABLED) — the mutation writes
// configured status and snapshot() maps entity.status, so DRIFT compares
// like-for-like. effective_status (CAMPAIGN_PAUSED, WITH_ISSUES, …) rides
// along as a plain display-only string, NEVER diffed (spec §a adjudication).
export const metaEntityStatusSchema = z.enum(["ENABLED", "PAUSED"]);

// Display/warn only (mapLearning convention, networks/meta.ts).
const learningPhaseSchema = z.enum(["LEARNING", "STABLE", "LIMITED", "UNKNOWN"]);

// The ONLY client-writable budget shape. Floor mirrors gates.ts
// CURRENCY_SANITY (≥ 1 unit); multipleOf keeps every editor-authored budget
// cent-aligned, so the adapter's Math.round(micros / MICROS_PER_MINOR_UNIT)
// write (networks/meta.ts buildMetaMutation) is exact and metaBudgetRoundMicros
// is an identity — DRIFT/verify can never see rounding skew.
const desiredDailyBudget = z.number().int().min(MICROS_PER_UNIT).multipleOf(MICROS_PER_MINOR_UNIT).nullable();

// Server-owned raw budget baselines: whatever the live account reports,
// converted minor-units → micros by the read-tree mapper. No floor here — the
// floor constrains what the OPERATOR may propose, not what Meta already runs.
const baseBudget = z.number().int().nullable();

// Fail-closed, BOTH directions (spec §a): desired.dailyBudgetMicros must be
// null ⇔ base.dailyBudgetMicros is null. No introducing a budget where Meta
// doesn't own one at that level (CBO adsets, lifetime-budget nodes — the
// analog of edit/diff.ts's budgetShared throw), and no clearing one it owns.
function refineBudgetCoupling(label: string) {
  return (
    node: { base: { dailyBudgetMicros: number | null }; desired: { dailyBudgetMicros: number | null } },
    ctx: z.RefinementCtx
  ): void => {
    const baseNull = node.base.dailyBudgetMicros === null;
    const desiredNull = node.desired.dailyBudgetMicros === null;
    if (baseNull && !desiredNull) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["desired", "dailyBudgetMicros"],
        message: `No se puede introducir un presupuesto diario en ${label}: Meta no administra presupuesto diario en este nivel.`,
      });
    }
    if (!baseNull && desiredNull) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["desired", "dailyBudgetMicros"],
        message: `No se puede quitar el presupuesto diario de ${label} desde este editor.`,
      });
    }
  };
}

const metaAdSchema = z.object({
  id: z.string(), // numeric Graph node id — server-owned
  base: z.object({
    name: z.string(),
    status: metaEntityStatusSchema,
    effectiveStatus: z.string(), // display-only, never diffed
  }),
  desired: z.object({ status: metaEntityStatusSchema }),
});

const metaAdsetSchema = z
  .object({
    id: z.string(),
    base: z.object({
      name: z.string(),
      status: metaEntityStatusSchema,
      effectiveStatus: z.string(),
      dailyBudgetMicros: baseBudget, // non-null under ABO; null under CBO/lifetime
      lifetimeBudgetMicros: baseBudget, // display-only: non-null ⇒ budget-locked node
      learningPhase: learningPhaseSchema,
    }),
    desired: z.object({
      status: metaEntityStatusSchema,
      dailyBudgetMicros: desiredDailyBudget,
    }),
    ads: z.array(metaAdSchema),
  })
  .superRefine(refineBudgetCoupling("el conjunto de anuncios"));

export const metaEditDocSchema = z.object({
  docType: z.literal("meta_edit_v1"), // docType-first dispatch key at every seam
  network: z.literal("meta_ads"),
  accountRef: z.string(), // "act_<id>", server-owned, ∈ metaAccountRefs() at the edit route
  loadedAt: z.string().datetime(), // TOP-LEVEL — same slot as the google doc (shared TTL guard)
  campaign: z
    .object({
      id: z.string(),
      base: z.object({
        name: z.string(),
        status: metaEntityStatusSchema,
        effectiveStatus: z.string(),
        dailyBudgetMicros: baseBudget, // non-null ⇒ CBO campaign
        lifetimeBudgetMicros: baseBudget,
        currency: z.string().nullable(),
      }),
      desired: z.object({
        status: metaEntityStatusSchema,
        dailyBudgetMicros: desiredDailyBudget,
      }),
      adsets: z.array(metaAdsetSchema),
    })
    .superRefine(refineBudgetCoupling("la campaña")),
});

export type MetaEditDoc = z.infer<typeof metaEditDocSchema>;
export type MetaEditAdset = MetaEditDoc["campaign"]["adsets"][number];
export type MetaEditAd = MetaEditAdset["ads"][number];

export function parseMetaEditDoc(input: unknown): MetaEditDoc {
  return metaEditDocSchema.parse(input);
}

/**
 * Same two-layer pattern as mergeEditDoc (edit/schema.ts) but ~60 lines: only
 * ONE field family (`desired`) is lifted from the client. 4 steps:
 *  (1) parse incoming (throw → 400);
 *  (2) rebuild FROM stored — docType/network/accountRef/loadedAt/ids/base.* all server-owned;
 *  (3) lift only `desired` per row, matched by id, iterating STORED rows
 *      (unknown incoming ids structurally dropped; stored rows missing from
 *      incoming preserved as-is);
 *  (4) final parse so the base-null⇔desired-null superRefine fires against
 *      SERVER truth, not client-claimed base (the schema.ts:224-229 pattern).
 * Deliberately NOT a genericization of mergeEditDoc — google lifts 8 field
 * families, meta lifts 1; the shared thing is the pattern, not code.
 */
export function mergeMetaEditDoc(stored: MetaEditDoc, incoming: unknown): MetaEditDoc {
  const incomingDoc = metaEditDocSchema.parse(incoming); // (1)

  const result: MetaEditDoc = { // (2) + (3)
    docType: stored.docType,
    network: stored.network,
    accountRef: stored.accountRef,
    loadedAt: stored.loadedAt, // server-owned, TTL clock must not be movable
    campaign: {
      id: stored.campaign.id,
      base: stored.campaign.base, // server-owned baseline, cannot be modified
      desired: incomingDoc.campaign.desired, // client-owned
      adsets: stored.campaign.adsets.map((storedAdset) => {
        const incomingAdset = incomingDoc.campaign.adsets.find((a) => a.id === storedAdset.id);
        if (!incomingAdset) return storedAdset; // missing from incoming → preserved as-is
        return {
          id: storedAdset.id,
          base: storedAdset.base,
          desired: incomingAdset.desired, // client-owned
          ads: storedAdset.ads.map((storedAd) => {
            const incomingAd = incomingAdset.ads.find((a) => a.id === storedAd.id);
            if (!incomingAd) return storedAd;
            return { id: storedAd.id, base: storedAd.base, desired: incomingAd.desired };
          }),
        };
      }),
    },
  };

  // (4) Two-layer validation guard: incoming.parse (shape) + result.parse
  // (truth). A client that spoofs base to smuggle a budget onto a node the
  // server knows is base-null passes (1), but the refine re-fires here against
  // stored base → ZodError → 400 → doc never poisoned. The doc can never
  // mutate an entity the server didn't load.
  return metaEditDocSchema.parse(result);
}
