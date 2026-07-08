// Command Center v2.4 "Copiloto Anclado" — the patch contract (spec §a) + provenance
// helpers (spec §b). Isomorphic: zod only, ZERO server imports (no db, no auth, no fetch).
// This file is the fail-closed whitelist an AI-authored patch must clear before
// applyBlueprintPatch (./apply.ts) will even attempt to touch a doc: WRITABLE_FIELDS names
// every field an accepted patch may ever set, and every value is re-validated against the
// REAL sub-schema the doc itself uses (blueprint/schema.ts / edit/schema.ts) — never a
// re-typed duplicate, so the two can never silently drift apart.
import { z } from "zod";
import { RSA_SPEC } from "../knowledge";
import { MICROS_PER_UNIT } from "../types";
import {
  biddingSchema,
  descriptionSchema,
  geoSchema,
  headlineSchema,
  keywordSchema,
  type CcBlueprintDoc,
} from "../blueprint/schema";
import {
  cpcFloorMicros,
  entityStatusSchema,
  kw as editKeywordSchema,
  newAd as newAdSchema,
  type GoogleSearchEditDoc,
} from "../edit/schema";

// ---------------------------------------------------------------------------
// (a) The patch contract
// ---------------------------------------------------------------------------

export const MAX_PATCH_OPS = 20;

export const patchOpSchema = z.object({
  nodeId: z.string().min(1), // create: node.nodeId; edit: resourceName (root = "campaign")
  field: z.string().min(1), // whitelisted per docKind × node kind (fail-closed)
  value: z.unknown(),
  rationale: z.string().min(1).max(300),
});
export type PatchOp = z.infer<typeof patchOpSchema>;

export const blueprintPatchSchema = z.object({
  docKind: z.enum(["google_create", "google_edit"]),
  summary: z.string().min(1).max(160),
  ops: z.array(patchOpSchema).min(1).max(MAX_PATCH_OPS),
});
export type BlueprintPatch = z.infer<typeof blueprintPatchSchema>;
export type DocKind = BlueprintPatch["docKind"];

/** Every node kind a patch op can address, across both docKinds. */
export type NodeKind = "campaign" | "budget" | "adGroup" | "ad" | "baseKeyword";

// ---------------------------------------------------------------------------
// Per-field sub-schemas — the single source of truth WRITABLE_FIELDS is derived
// from. Every value here is either the doc's own exported sub-schema (bidding,
// geo, headline/description/keyword shapes, the edit doc's newAd/kw/status/cpc-floor)
// or a trivial primitive combinator (z.string().min(1), z.number().int()...) built
// from the SAME shared constants (RSA_SPEC, MICROS_PER_UNIT) the real schemas use —
// never a re-typed business rule.
// ---------------------------------------------------------------------------

const CREATE_FIELD_SCHEMAS: Record<NodeKind, Record<string, z.ZodTypeAny>> = {
  campaign: {
    name: z.string().min(1),
    bidding: biddingSchema,
    geo: geoSchema,
    languageCode: z.string().optional(),
  },
  budget: {
    dailyMicros: z.number().int().min(MICROS_PER_UNIT),
  },
  adGroup: {
    name: z.string().min(1),
    cpcMicros: z.number().int().optional(),
    keywords: z.array(keywordSchema).min(1),
    negatives: z.array(keywordSchema),
  },
  ad: {
    finalUrl: z.string().url(),
    headlines: z.array(headlineSchema).min(RSA_SPEC.headline.min).max(RSA_SPEC.headline.max),
    descriptions: z.array(descriptionSchema).min(RSA_SPEC.description.min).max(RSA_SPEC.description.max),
    path1: z.string().max(RSA_SPEC.path.maxLen).optional(),
    path2: z.string().max(RSA_SPEC.path.maxLen).optional(),
  },
  baseKeyword: {},
};

const EDIT_FIELD_SCHEMAS: Record<NodeKind, Record<string, z.ZodTypeAny>> = {
  campaign: {
    "desired.status": entityStatusSchema,
    "desired.dailyBudgetMicros": z.number().int().min(MICROS_PER_UNIT),
    newNegatives: z.array(editKeywordSchema),
    removeNegatives: z.array(z.string()),
  },
  adGroup: {
    "desired.status": entityStatusSchema,
    "desired.cpcBidMicros": z.number().int().min(cpcFloorMicros).nullable(),
    newKeywords: z.array(editKeywordSchema.extend({ negative: z.boolean().default(false) })),
    newAds: z.array(newAdSchema),
  },
  baseKeyword: {
    desiredStatus: entityStatusSchema,
  },
  ad: {
    replacement: newAdSchema.nullable(),
  },
  budget: {},
};

function fieldSchemasFor(docKind: DocKind): Record<NodeKind, Record<string, z.ZodTypeAny>> {
  return docKind === "google_create" ? CREATE_FIELD_SCHEMAS : EDIT_FIELD_SCHEMAS;
}

/** Rule 3's per-field sub-schema lookup — reused verbatim by apply.ts and sanitizeProv below.
 * Uses `Object.hasOwn` (never a bare bracket lookup) so a `field` of "__proto__" /
 * "constructor" / "toString" — anything living on the prototype chain rather than as the
 * registry's OWN property — resolves to `undefined` (fail-closed) instead of returning a
 * prototype member that then crashes the caller's `.safeParse(...)` call with an uncaught
 * TypeError. */
export function fieldSchemaFor(docKind: DocKind, nodeKind: NodeKind, field: string): z.ZodTypeAny | undefined {
  const schemas = fieldSchemasFor(docKind)[nodeKind];
  return Object.hasOwn(schemas, field) ? schemas[field] : undefined;
}

function fieldNames(schemas: Record<string, z.ZodTypeAny>): readonly string[] {
  return Object.freeze(Object.keys(schemas));
}

// Explicit const registry — anything NOT listed is rejected (fail-closed).
//  google_create — campaign: name, bidding, geo, languageCode | budget: dailyMicros
//                  adGroup: name, cpcMicros, keywords, negatives | ad: finalUrl, headlines,
//                  descriptions, path1, path2 (NEVER status/channel — schema literals — nor
//                  nodeId/tempId).
//  google_edit    — EXACTLY the mergeEditDoc-lifted set (edit/schema.ts:139-224):
//                  campaign: desired.status, desired.dailyBudgetMicros, newNegatives,
//                  removeNegatives | adGroup: desired.status, desired.cpcBidMicros,
//                  newKeywords, newAds | baseKeyword row: desiredStatus | existing ad:
//                  replacement (every base*/resourceName/id/loadedAt is unreachable BY
//                  CONSTRUCTION — no writable-field entry ever names them).
export const WRITABLE_FIELDS: Record<DocKind, Record<NodeKind, readonly string[]>> = Object.freeze({
  google_create: {
    campaign: fieldNames(CREATE_FIELD_SCHEMAS.campaign),
    budget: fieldNames(CREATE_FIELD_SCHEMAS.budget),
    adGroup: fieldNames(CREATE_FIELD_SCHEMAS.adGroup),
    ad: fieldNames(CREATE_FIELD_SCHEMAS.ad),
    baseKeyword: fieldNames(CREATE_FIELD_SCHEMAS.baseKeyword),
  },
  google_edit: {
    campaign: fieldNames(EDIT_FIELD_SCHEMAS.campaign),
    budget: fieldNames(EDIT_FIELD_SCHEMAS.budget),
    adGroup: fieldNames(EDIT_FIELD_SCHEMAS.adGroup),
    ad: fieldNames(EDIT_FIELD_SCHEMAS.ad),
    baseKeyword: fieldNames(EDIT_FIELD_SCHEMAS.baseKeyword),
  },
});

// ---------------------------------------------------------------------------
// Node resolution — shared identity between the patch contract and provenance keys.
// create: nodeId ∈ {campaign, budget, an adGroup, an ad} `nodeId`.
// edit: nodeId ∈ resourceNames present in the doc (+ literal "campaign" as an alias
// for the campaign node, so the model never has to know/repeat its real resourceName).
// `canonicalId` is what provenance/`_ai` markers key on: the node's own nodeId for
// create, the REAL resourceName for edit (the "campaign" alias normalizes to it).
// ---------------------------------------------------------------------------

export interface ResolvedNode {
  kind: NodeKind;
  canonicalId: string;
  /** create only — the node's compile-time tempId (what `_ai` markers use, per compile.ts). */
  tempId?: string;
}

function isEditDoc(doc: CcBlueprintDoc | GoogleSearchEditDoc): doc is GoogleSearchEditDoc {
  return (doc as Partial<GoogleSearchEditDoc>).docType === "google_search_edit_v1";
}

function resolveCreateNode(doc: CcBlueprintDoc, nodeId: string): ResolvedNode | null {
  const c = doc.campaign;
  if (nodeId === c.nodeId) return { kind: "campaign", canonicalId: c.nodeId, tempId: c.tempId };
  if (nodeId === c.budget.nodeId) return { kind: "budget", canonicalId: c.budget.nodeId, tempId: c.budget.tempId };
  for (const ag of c.adGroups) {
    if (nodeId === ag.nodeId) return { kind: "adGroup", canonicalId: ag.nodeId, tempId: ag.tempId };
    for (const adNode of ag.ads) {
      if (nodeId === adNode.nodeId) return { kind: "ad", canonicalId: adNode.nodeId, tempId: adNode.tempId };
    }
  }
  return null;
}

function resolveEditNode(doc: GoogleSearchEditDoc, nodeId: string): ResolvedNode | null {
  const c = doc.campaign;
  if (nodeId === "campaign" || nodeId === c.resourceName) {
    return { kind: "campaign", canonicalId: c.resourceName };
  }
  for (const ag of c.adGroups) {
    if (nodeId === ag.resourceName) return { kind: "adGroup", canonicalId: ag.resourceName };
    for (const kwRow of ag.baseKeywords) {
      if (nodeId === kwRow.resourceName) return { kind: "baseKeyword", canonicalId: kwRow.resourceName };
    }
    for (const adRow of ag.ads) {
      if (nodeId === adRow.resourceName) return { kind: "ad", canonicalId: adRow.resourceName };
    }
  }
  return null;
}

/** Rule 2's node resolution — shared by apply.ts and the provenance helpers below. */
export function resolveNode(doc: CcBlueprintDoc | GoogleSearchEditDoc, nodeId: string): ResolvedNode | null {
  return isEditDoc(doc) ? resolveEditNode(doc, nodeId) : resolveCreateNode(doc as CcBlueprintDoc, nodeId);
}

// ---------------------------------------------------------------------------
// (b) Provenance — storage, flow (spec §b)
// ---------------------------------------------------------------------------

/**
 * Stored value is only `'ia'` — the conceptual dato/auto/manual/ia 4-value model
 * resolves the other three by absence/derivation, never by writing them. See spec §b.
 */
export type ProvenanceMap = Record<string, "ia">;

/** sanitizeProv's per-save cap on raw `_prov` entries examined (bounds both work and output size). */
export const MAX_PROV_ENTRIES = 500;

/** Splits a `${nodeId}:${field}` provenance key. nodeId/resourceName never contain ':'. */
function splitProvKey(key: string): { nodeId: string; field: string } | null {
  const sep = key.lastIndexOf(":");
  if (sep <= 0 || sep === key.length - 1) return null;
  return { nodeId: key.slice(0, sep), field: key.slice(sep + 1) };
}

/** Reads the `_prov` raw jsonb sibling off a doc-like value (mirrors the `_ai` convention —
 * zod doesn't declare it, so parseBlueprint/parseEditDoc strip it from the parsed result). */
export function readProv(doc: unknown): ProvenanceMap {
  const raw = (doc as { _prov?: unknown } | null | undefined)?._prov;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ProvenanceMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === "ia") out[key] = "ia";
  }
  return out;
}

/** Pure — returns a NEW map with every key stamped `'ia'`. The only legitimate writer of `'ia'`. */
export function stampProv(prov: ProvenanceMap, keys: readonly string[]): ProvenanceMap {
  if (keys.length === 0) return prov;
  const next: ProvenanceMap = { ...prov };
  for (const key of keys) next[key] = "ia";
  return next;
}

/** Pure — returns a NEW map with `key` removed (the ia→manual downgrade on any other write). */
export function clearProv(prov: ProvenanceMap, key: string): ProvenanceMap {
  if (!(key in prov)) return prov;
  const next = { ...prov };
  delete next[key];
  return next;
}

/**
 * Markers must match the LITERAL `localRef`/`entityRef` the compiler for this docKind will
 * stamp on the action(s) that field produces — never the patch node's own `canonicalId` — or
 * the repo-layer `aiPaths.has(...)` match silently labels nothing (or the wrong thing).
 *
 * create (blueprint/compile.ts): matched against `CompiledAction.localRef` — feeds the
 * dormant repo.ts:229-252 `_ai` reader.
 *   - campaign (name/bidding/geo/languageCode) -> campaign's bare tempId (compile.ts:98).
 *   - budget (dailyMicros)                     -> budget's bare tempId (compile.ts:70-78).
 *   - adGroup name/cpcMicros                    -> adGroup's bare tempId, the create_ad_group
 *                                                  action (compile.ts:100-109).
 *   - adGroup keywords/negatives                -> `${tempId}:kw` — these two fields feed the
 *                                                  SEPARATE create_keywords action, not
 *                                                  create_ad_group (compile.ts:110-125).
 *   - ad (finalUrl/headlines/descriptions/path*) -> ad's bare tempId (compile.ts:126-140).
 *
 * edit (edit/diff.ts): matched against `EditCompiledAction.entityRef` — feeds the (not yet
 * wired) equivalent of repo.ts's `aiPaths.has(a.entityRef)` for edit docs.
 *   - EVERY campaign field's action (pause/enable/budget_update/add|remove_negatives) carries
 *     entityRef = campaign.id — NOT campaign.resourceName (diff.ts:100,153,193,207,350).
 *   - adGroup desired.status/desired.cpcBidMicros -> group.id (diff.ts:113,172,337).
 *   - adGroup newKeywords -> `tmp:kw:${group.id}`, the create_keywords action (diff.ts:223-232).
 *   - adGroup newAds -> `tmp:${tempId}` for EACH entry in the (merged) newAds array — one
 *     create_ad action per entry (diff.ts:279-302); a single 'ia' field can yield N markers.
 *   - a baseKeyword row's desiredStatus is folded into the BATCHED per-ad-group
 *     update_keyword_status action -> group.id (diff.ts:122-142,305-328), NOT the keyword
 *     row's own resourceName.
 *   - an ad's replacement pairs a create_ad (`tmp:${replacement.tempId}`, diff.ts:246-262)
 *     with, IF the old ad was ENABLED, a pause on the OLD ad (entityRef = ad.resourceName,
 *     diff.ts:264-275) — both actions get marked.
 * Coarse (action-level), matching the create path's existing granularity.
 */
export function deriveAiMarkers(doc: CcBlueprintDoc | GoogleSearchEditDoc, prov: ProvenanceMap): string[] {
  const edit = isEditDoc(doc);
  const markers = new Set<string>();
  for (const [key, value] of Object.entries(prov)) {
    if (value !== "ia") continue;
    const split = splitProvKey(key);
    if (!split) continue;
    const resolved = resolveNode(doc, split.nodeId);
    if (!resolved) continue;

    if (!edit) {
      if (!resolved.tempId) continue;
      if (resolved.kind === "adGroup" && (split.field === "keywords" || split.field === "negatives")) {
        markers.add(`${resolved.tempId}:kw`);
      } else {
        markers.add(resolved.tempId);
      }
      continue;
    }

    const editDoc = doc as GoogleSearchEditDoc;
    if (resolved.kind === "campaign") {
      markers.add(editDoc.campaign.id);
    } else if (resolved.kind === "adGroup") {
      const ag = editDoc.campaign.adGroups.find((a) => a.resourceName === resolved.canonicalId);
      if (!ag) continue;
      if (split.field === "newKeywords") {
        markers.add(`tmp:kw:${ag.id}`);
      } else if (split.field === "newAds") {
        for (const na of ag.newAds) markers.add(`tmp:${na.tempId}`);
      } else {
        markers.add(ag.id);
      }
    } else if (resolved.kind === "baseKeyword") {
      const ag = editDoc.campaign.adGroups.find((a) => a.baseKeywords.some((k) => k.resourceName === resolved.canonicalId));
      if (ag) markers.add(ag.id);
    } else if (resolved.kind === "ad") {
      markers.add(resolved.canonicalId); // pairs the paired pause(old)'s entityRef, if emitted
      for (const ag of editDoc.campaign.adGroups) {
        const adRow = ag.ads.find((a) => a.resourceName === resolved.canonicalId);
        if (adRow?.replacement) markers.add(`tmp:${adRow.replacement.tempId}`);
      }
    }
  }
  return Array.from(markers);
}

/**
 * The one real edit-plumbing fix (spec §b): the edit PUT route re-attaches `_prov` onto
 * `mergeEditDoc`'s output, but only after re-validating every key resolves to a WRITABLE
 * field of the MERGED doc (a node the merge dropped, or a field mergeEditDoc doesn't lift,
 * must not survive) — value must be exactly `'ia'`, capped at MAX_PROV_ENTRIES raw entries.
 */
export function sanitizeProv(mergedDoc: GoogleSearchEditDoc, rawProv: unknown): ProvenanceMap {
  if (!rawProv || typeof rawProv !== "object" || Array.isArray(rawProv)) return {};
  const out: ProvenanceMap = {};
  const entries = Object.entries(rawProv as Record<string, unknown>).slice(0, MAX_PROV_ENTRIES);
  for (const [key, value] of entries) {
    if (value !== "ia") continue;
    const split = splitProvKey(key);
    if (!split) continue;
    const resolved = resolveNode(mergedDoc, split.nodeId);
    if (!resolved) continue;
    if (!fieldSchemaFor("google_edit", resolved.kind, split.field)) continue;
    out[key] = "ia";
  }
  return out;
}
