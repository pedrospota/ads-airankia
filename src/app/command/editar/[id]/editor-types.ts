// Command Center v2.3 edit-mode — Edit workbench ("Editar campaña"). Pure helpers +
// types shared by editor-client.tsx / editor-panels.tsx / editor-preview.tsx. No
// hooks, no fetch — safe to import from any of those client modules. Mirrors
// crear/builder-types.ts's role for the create flow.
//
// IMMUTABILITY NOTE: every update* helper below only ever replaces `desired`,
// `newNegatives`, `newKeywords`, `newAds`, or `replacement` — never `base`,
// `resourceName`, `id`, `loadedAt`, `unsupported`, or `baseKeywords`. The server
// (mergeEditDoc) would silently drop any attempt to rewrite those anyway, but the
// client is written to never try, so the doc PUT on autosave is always exactly what
// the operator sees in this UI.

import { RSA_SPEC } from "@/lib/command/knowledge";
import type { GoogleSearchEditDoc } from "@/lib/command/edit/schema";
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

export function adGroupHasEdits(g: EditAdGroup): boolean {
  return (
    g.desired.status !== g.base.status ||
    g.newKeywords.length > 0 ||
    g.newAds.length > 0 ||
    g.ads.some((a) => a.replacement != null)
  );
}

export function campaignTone(doc: GoogleSearchEditDoc): NodeTone {
  const c = doc.campaign;
  const own =
    c.desired.status !== c.base.status ||
    c.desired.dailyBudgetMicros !== c.base.dailyBudgetMicros ||
    c.newNegatives.length > 0;
  return own || c.adGroups.some(adGroupHasEdits) ? "editado" : "en-vivo";
}

export function adGroupTone(g: EditAdGroup): NodeTone {
  return adGroupHasEdits(g) ? "editado" : "en-vivo";
}

export function keywordsTone(g: EditAdGroup): NodeTone {
  return g.newKeywords.length > 0 ? "nuevo" : "en-vivo";
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
  for (const g of c.adGroups) {
    if (g.desired.status !== g.base.status) n++;
    n += g.newKeywords.length;
    n += g.newAds.length;
    for (const ad of g.ads) {
      if (ad.replacement != null) n++;
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
