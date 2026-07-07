// Command Center v2.3 edit-mode — PURE differ: GoogleSearchEditDoc -> ordered
// EditCompiledAction[] for the execution rail. Mirror of blueprint/compile.ts,
// but every create in slice-1 targets a REAL parent resourceName (no
// new-ad-group subtree, so there is no tmp: resolution dependency).
//
// Ordering encodes a safety property: an ad group's enabled-ad count can
// never decrease from a failed edit. Phases run A (pauses) -> B (budget) ->
// C (negatives) -> D (per ad group: keywords, then paired create+pause per
// replacement, then plain newAds) -> E (enables LAST). Combined with the
// runner's stop-on-first-failure, a failed create_ad means its paired
// pause(old) never runs.
//
// PURITY: no Date, no random, no IO. Deterministic output for identical input.
import { createHash } from "node:crypto";
import type { GoogleSearchEditDoc } from "./schema";
import type {
  CcEntityKind,
  CcInternalActionType,
  CcPayload,
  EntitySnapshot,
} from "../types";

export interface EditCompiledAction {
  seq: number;
  localRef: string | null; // only creates get a localRef
  actionType: CcInternalActionType; // only: budget_update|pause|enable|add_negatives|create_keywords|create_ad
  entityKind: CcEntityKind;
  entityRef: string;
  payload: CcPayload;
  expected: Partial<EntitySnapshot> | null;
  entityName: string | null;
  recKey: string; // "ed-" + sha256(`${blueprintId}|${seq}`).slice(0,14)
  note: string; // es-MX antes->despues summary for review cards
}

function recKey(blueprintId: string, seq: number): string {
  return (
    "ed-" +
    createHash("sha256")
      .update(`${blueprintId}|${seq}`)
      .digest("hex")
      .slice(0, 14)
  );
}

/** Format micros as a currency-unit string for es-MX antes->despues notes. */
function fmtMicros(micros: number): string {
  return String(micros / 1_000_000);
}

export function diffEditDoc(doc: GoogleSearchEditDoc, blueprintId: string): EditCompiledAction[] {
  const c = doc.campaign;
  const out: EditCompiledAction[] = [];
  let seq = 0;
  const seenTempIds = new Set<string>();

  const push = (row: {
    localRef: string | null;
    actionType: CcInternalActionType;
    entityKind: CcEntityKind;
    entityRef: string;
    payload: CcPayload;
    expected: Partial<EntitySnapshot> | null;
    entityName: string | null;
    note: string;
  }) => {
    out.push({ ...row, seq, recKey: recKey(blueprintId, seq) });
    seq += 1;
  };

  // --- Phase A: pause intents (campaign, then ad groups) ---
  if (c.desired.status === "PAUSED" && c.base.status === "ENABLED") {
    push({
      localRef: null,
      actionType: "pause",
      entityKind: "campaign",
      entityRef: c.id,
      payload: {},
      expected: { status: "ENABLED" },
      entityName: c.base.name,
      note: `Pausar campaña «${c.base.name}»`,
    });
  }
  for (const g of c.adGroups) {
    if (g.desired.status === "PAUSED" && g.base.status === "ENABLED") {
      push({
        localRef: null,
        actionType: "pause",
        entityKind: "ad_group",
        entityRef: g.id,
        payload: {},
        expected: { status: "ENABLED" },
        entityName: g.base.name,
        note: `Pausar grupo de anuncios «${g.base.name}»`,
      });
    }
  }

  // --- Phase B: budget ---
  if (c.desired.dailyBudgetMicros !== c.base.dailyBudgetMicros) {
    if (c.base.budgetShared) {
      throw new Error("El presupuesto es compartido; no se puede editar desde aquí.");
    }
    push({
      localRef: null,
      actionType: "budget_update",
      entityKind: "campaign",
      entityRef: c.id,
      payload: { newDailyBudgetMicros: c.desired.dailyBudgetMicros },
      expected: { dailyBudgetMicros: c.base.dailyBudgetMicros },
      entityName: c.base.name,
      note: `Presupuesto de «${c.base.name}»: ${fmtMicros(c.base.dailyBudgetMicros)} → ${fmtMicros(c.desired.dailyBudgetMicros)}`,
    });
  }

  // --- Phase C: negatives ---
  if (c.newNegatives.length > 0) {
    push({
      localRef: null,
      actionType: "add_negatives",
      entityKind: "campaign",
      entityRef: c.id,
      payload: { negatives: c.newNegatives },
      expected: null,
      entityName: c.base.name,
      note: `Agregar ${c.newNegatives.length} negativa(s) a «${c.base.name}»`,
    });
  }

  // --- Phase D: per ad group in doc order ---
  for (const g of c.adGroups) {
    // Seed guard with this group's kw: ref namespace to prevent collision with user tempIds
    seenTempIds.add(`kw:${g.id}`);

    // D1: create_keywords
    if (g.newKeywords.length > 0) {
      push({
        localRef: `kw:${g.id}`,
        actionType: "create_keywords",
        entityKind: "ad_group",
        entityRef: `tmp:kw:${g.id}`,
        payload: { adGroupRef: g.resourceName, keywords: g.newKeywords },
        expected: null,
        entityName: g.base.name,
        note: `Agregar ${g.newKeywords.length} keyword(s) a «${g.base.name}»`,
      });
    }

    // D2: per ad with a replacement -> create_ad immediately followed by paired pause(old)
    for (const ad of g.ads) {
      if (!ad.replacement) continue;
      if (ad.unsupported) {
        throw new Error(`No se puede reemplazar un anuncio no soportado (${ad.resourceName}).`);
      }
      const repl = ad.replacement;
      if (seenTempIds.has(repl.tempId)) {
        throw new Error(`tempId duplicado: ${repl.tempId}`);
      }
      seenTempIds.add(repl.tempId);

      push({
        localRef: repl.tempId,
        actionType: "create_ad",
        entityKind: "ad",
        entityRef: `tmp:${repl.tempId}`,
        payload: {
          adGroupRef: g.resourceName,
          finalUrl: repl.finalUrl,
          headlines: repl.headlines,
          descriptions: repl.descriptions,
          path1: repl.path1,
          path2: repl.path2,
        },
        expected: null,
        entityName: g.base.name,
        note: `Crear anuncio nuevo en «${g.base.name}»`,
      });

      if (ad.base.status === "ENABLED") {
        push({
          localRef: null,
          actionType: "pause",
          entityKind: "ad",
          entityRef: ad.resourceName,
          payload: {},
          expected: { status: "ENABLED" },
          entityName: g.base.name,
          note: "Google no permite editar anuncios: se crea uno nuevo y se pausa el anterior.",
        });
      }
    }

    // D3: plain newAds
    for (const newAd of g.newAds) {
      if (seenTempIds.has(newAd.tempId)) {
        throw new Error(`tempId duplicado: ${newAd.tempId}`);
      }
      seenTempIds.add(newAd.tempId);

      push({
        localRef: newAd.tempId,
        actionType: "create_ad",
        entityKind: "ad",
        entityRef: `tmp:${newAd.tempId}`,
        payload: {
          adGroupRef: g.resourceName,
          finalUrl: newAd.finalUrl,
          headlines: newAd.headlines,
          descriptions: newAd.descriptions,
          path1: newAd.path1,
          path2: newAd.path2,
        },
        expected: null,
        entityName: g.base.name,
        note: `Agregar anuncio nuevo a «${g.base.name}»`,
      });
    }
  }

  // --- Phase E: enable intents LAST (ad groups, then campaign) ---
  for (const g of c.adGroups) {
    if (g.desired.status === "ENABLED" && g.base.status === "PAUSED") {
      push({
        localRef: null,
        actionType: "enable",
        entityKind: "ad_group",
        entityRef: g.id,
        payload: {},
        expected: { status: "PAUSED" },
        entityName: g.base.name,
        note: `Habilitar grupo de anuncios «${g.base.name}»`,
      });
    }
  }
  if (c.desired.status === "ENABLED" && c.base.status === "PAUSED") {
    push({
      localRef: null,
      actionType: "enable",
      entityKind: "campaign",
      entityRef: c.id,
      payload: {},
      expected: { status: "PAUSED" },
      entityName: c.base.name,
      note: `Habilitar campaña «${c.base.name}»`,
    });
  }

  // Final self-assert: no non-create action ever carries a tmp: ref.
  for (const a of out) {
    if (!a.actionType.startsWith("create_") && a.entityRef.startsWith("tmp:")) {
      throw new Error(`Invariante rota: acción no-create con ref tmp: (${a.actionType} ${a.entityRef})`);
    }
  }

  return out;
}
