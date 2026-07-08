// Command Center v2.3 edit-mode — Edit workbench ("Editar campaña"). Pure helpers +
// types shared by editor-client.tsx / editor-panels.tsx / editor-preview.tsx. No
// hooks, no fetch — safe to import from any of those client modules. Mirrors
// crear/builder-types.ts's role for the create flow.
//
// IMMUTABILITY NOTE: every update*/set*/queue*/undo* helper below only ever
// replaces `desired` (incl. `desired.cpcBidMicros`), `newNegatives`,
// `newKeywords`, `newAds`, `replacement`, a baseKeywords row's `desiredStatus`,
// or `campaign.removeNegatives` — never `base`, `resourceName`, `id`,
// `loadedAt`, `unsupported`, `baseKeywords[].status`, or `campaign.baseNegatives`.
// The server (mergeEditDoc) would silently drop any attempt to rewrite those
// anyway, but the client is written to never try, so the doc PUT on autosave is
// always exactly what the operator sees in this UI.

import { RSA_SPEC } from "@/lib/command/knowledge";
import type { GoogleSearchEditDoc } from "@/lib/command/edit/schema";
import { MICROS_PER_UNIT } from "@/lib/command/types";
import { newId } from "../../crear/builder-types";

export type EditAdGroup = GoogleSearchEditDoc["campaign"]["adGroups"][number];
export type EditAd = EditAdGroup["ads"][number];
export type EditNewAd = EditAdGroup["newAds"][number];

export type NodeSelection =
  | { kind: "campaign" }
  | { kind: "adGroup"; groupRef: string }
  | { kind: "keywords"; groupRef: string }
  | { kind: "ad"; groupRef: string; adRef: string }
  | { kind: "newAd"; groupRef: string; tempId: string };

export function sameSelection(a: NodeSelection, b: NodeSelection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "campaign") return true;
  if (a.kind === "adGroup" || a.kind === "keywords") return a.groupRef === (b as typeof a).groupRef;
  if (a.kind === "ad") return b.kind === "ad" && a.groupRef === b.groupRef && a.adRef === b.adRef;
  return b.kind === "newAd" && a.groupRef === b.groupRef && a.tempId === b.tempId;
}

export type NodeTone = "en-vivo" | "editado" | "nuevo";

/** True when any baseKeyword row on this ad group has a pending disposition
 * (desiredStatus set and different from the server-owned status). Negatives
 * never carry desiredStatus (differ throws if one does — see diff.ts), so this
 * is implicitly positives-only. */
function hasKeywordDispositions(g: EditAdGroup): boolean {
  return g.baseKeywords.some((k) => k.desiredStatus !== undefined && k.desiredStatus !== k.status);
}

export function adGroupHasEdits(g: EditAdGroup): boolean {
  return (
    g.desired.status !== g.base.status ||
    g.desired.cpcBidMicros !== g.base.cpcBidMicros ||
    g.newKeywords.length > 0 ||
    g.newAds.length > 0 ||
    g.ads.some((a) => a.replacement != null) ||
    hasKeywordDispositions(g)
  );
}

export function campaignTone(doc: GoogleSearchEditDoc): NodeTone {
  const c = doc.campaign;
  const own =
    c.desired.status !== c.base.status ||
    c.desired.dailyBudgetMicros !== c.base.dailyBudgetMicros ||
    c.newNegatives.length > 0 ||
    c.removeNegatives.length > 0;
  return own || c.adGroups.some(adGroupHasEdits) ? "editado" : "en-vivo";
}

export function adGroupTone(g: EditAdGroup): NodeTone {
  return adGroupHasEdits(g) ? "editado" : "en-vivo";
}

export function keywordsTone(g: EditAdGroup): NodeTone {
  if (g.newKeywords.length > 0) return "nuevo";
  if (hasKeywordDispositions(g)) return "editado";
  return "en-vivo";
}

export function adTone(ad: EditAd): NodeTone {
  return ad.replacement != null ? "editado" : "en-vivo";
}

/**
 * Count of distinct pending edits: desired≠base fields + new* lengths + replacements
 * (per the task brief). Deliberately NOT the differ (src/lib/command/edit/diff.ts is
 * server-only — it imports node:crypto — and its emitted-ACTION count differs from this
 * user-facing EDIT count anyway: one RSA replace emits 2 actions — create + pause — but
 * is 1 edit here). Kept in sync with diff.ts's edit-detection conditions by hand.
 */
export function countEdits(doc: GoogleSearchEditDoc): number {
  const c = doc.campaign;
  let n = 0;
  if (c.desired.status !== c.base.status) n++;
  if (c.desired.dailyBudgetMicros !== c.base.dailyBudgetMicros) n++;
  n += c.newNegatives.length;
  n += c.removeNegatives.length; // v2.7: pending campaign-negative removals
  for (const g of c.adGroups) {
    if (g.desired.status !== g.base.status) n++;
    if (g.desired.cpcBidMicros !== g.base.cpcBidMicros) n++; // v2.7: pending CPC change
    n += g.newKeywords.length;
    n += g.newAds.length;
    for (const ad of g.ads) {
      if (ad.replacement != null) n++;
    }
    for (const k of g.baseKeywords) {
      // v2.7: pending pause/reactivate dispositions
      if (k.desiredStatus !== undefined && k.desiredStatus !== k.status) n++;
    }
  }
  return n;
}

export function minutesSince(iso: string): number {
  const ms = Date.now() - Date.parse(iso);
  return Math.max(0, Math.floor(ms / 60_000));
}

/** A blank RSA, sized to RSA_SPEC minimums — mirrors crear's initialBuilderState headline/description counts. */
export function blankNewAd(): EditNewAd {
  return {
    tempId: newId("ad"),
    finalUrl: "",
    headlines: Array.from({ length: RSA_SPEC.headline.min }, () => ({ text: "" })),
    descriptions: Array.from({ length: RSA_SPEC.description.min }, () => ({ text: "" })),
    path1: "",
    path2: "",
  };
}

/** Pre-fills a fresh replacement from an existing ad's live (base) RSA content. */
export function replacementFromBase(ad: EditAd): NonNullable<EditAd["replacement"]> {
  return {
    tempId: newId("ad"),
    finalUrl: ad.base.finalUrl ?? "",
    headlines: ad.base.headlines.map((h) => ({ text: h.text })),
    descriptions: ad.base.descriptions.map((d) => ({ text: d.text })),
    path1: ad.base.path1 ?? "",
    path2: ad.base.path2 ?? "",
  };
}

export function updateAdGroup(
  doc: GoogleSearchEditDoc,
  groupRef: string,
  fn: (g: EditAdGroup) => EditAdGroup
): GoogleSearchEditDoc {
  return {
    ...doc,
    campaign: {
      ...doc.campaign,
      adGroups: doc.campaign.adGroups.map((g) => (g.resourceName === groupRef ? fn(g) : g)),
    },
  };
}

export function updateAd(
  doc: GoogleSearchEditDoc,
  groupRef: string,
  adRef: string,
  fn: (a: EditAd) => EditAd
): GoogleSearchEditDoc {
  return updateAdGroup(doc, groupRef, (g) => ({
    ...g,
    ads: g.ads.map((a) => (a.resourceName === adRef ? fn(a) : a)),
  }));
}

export function updateNewAd(
  doc: GoogleSearchEditDoc,
  groupRef: string,
  tempId: string,
  fn: (a: EditNewAd) => EditNewAd
): GoogleSearchEditDoc {
  return updateAdGroup(doc, groupRef, (g) => ({
    ...g,
    newAds: g.newAds.map((a) => (a.tempId === tempId ? fn(a) : a)),
  }));
}

/**
 * v2.7 pruning — sets (or clears, via `undefined`, the [Deshacer] path) a single
 * live baseKeyword row's client-writable `desiredStatus`. Only ever touches that
 * one row's `desiredStatus` field — resourceName/text/match/negative/status stay
 * exactly as loaded. Callers only ever pass a POSITIVE keyword's resourceName:
 * negative rows render no control (the differ throws if a negative ever carries
 * a desiredStatus — see edit/diff.ts).
 */
export function setKeywordDesiredStatus(
  doc: GoogleSearchEditDoc,
  groupRef: string,
  resourceName: string,
  desiredStatus: "ENABLED" | "PAUSED" | undefined
): GoogleSearchEditDoc {
  return updateAdGroup(doc, groupRef, (g) => ({
    ...g,
    baseKeywords: g.baseKeywords.map((k) => (k.resourceName === resourceName ? { ...k, desiredStatus } : k)),
  }));
}

/** v2.7 pruning — queues a live campaign negative's resourceName for removal ([Quitar]). No-op if already queued. */
export function queueRemoveNegative(doc: GoogleSearchEditDoc, resourceName: string): GoogleSearchEditDoc {
  if (doc.campaign.removeNegatives.includes(resourceName)) return doc;
  return { ...doc, campaign: { ...doc.campaign, removeNegatives: [...doc.campaign.removeNegatives, resourceName] } };
}

/** v2.7 pruning — undoes a queued negative removal ([Deshacer]). */
export function undoRemoveNegative(doc: GoogleSearchEditDoc, resourceName: string): GoogleSearchEditDoc {
  return {
    ...doc,
    campaign: { ...doc.campaign, removeNegatives: doc.campaign.removeNegatives.filter((rn) => rn !== resourceName) },
  };
}

/** v2.7 — US$0.01 floor in micros. Mirrors edit/schema.ts's cpcFloorMicros / gates.ts CURRENCY_SANITY's update_cpc floor. */
export const CPC_FLOOR_MICROS = MICROS_PER_UNIT / 100;

/**
 * Strip a raw CPC money input to digits/decimal and convert to whole-cent-rounded
 * micros, floored at CPC_FLOOR_MICROS. Mirrors builder-types.ts's unitsToMicros,
 * but (a) rounds to the nearest whole CENT rather than the nearest unit — CPCs
 * are legitimately sub-unit ($0.65) — and (b) floors invalid/empty/sub-cent input
 * up to the $0.01 floor instead of zeroing it, since schema.ts requires
 * `desired.cpcBidMicros` to be either null or >= 10_000 whenever the field is
 * live (never a bare 0).
 */
export function unitsToCpcMicros(raw: string): number {
  const n = Number(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return CPC_FLOOR_MICROS;
  const cents = Math.round(n * 100);
  return Math.max(cents * (MICROS_PER_UNIT / 100), CPC_FLOOR_MICROS);
}
