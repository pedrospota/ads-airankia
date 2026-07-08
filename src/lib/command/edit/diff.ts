// Command Center v2.3 edit-mode — PURE differ: GoogleSearchEditDoc -> ordered
// EditCompiledAction[] for the execution rail. Mirror of blueprint/compile.ts,
// but every create in slice-1 targets a REAL parent resourceName (no
// new-ad-group subtree, so there is no tmp: resolution dependency).
//
// Ordering encodes a safety property: an ad group's enabled-ad count can
// never decrease from a failed edit. Phases run A (pauses) -> A2 (v2.7:
// batched keyword pauses, per ad group) -> B (budget) -> B2 (v2.7: ad-group
// CPC change) -> C0 (v2.7: remove live campaign negatives, BEFORE add) -> C
// (add negatives) -> D (per ad group: keywords, then paired create+pause per
// replacement, then plain newAds) -> E0 (v2.7: batched keyword reactivate,
// per ad group) -> E (enables LAST). A2/E0 mirror the pause/enable direction
// (broadest-first for pause, narrowest-first for enable) so a keyword-level
// reactivation never lands before the ad group/campaign it lives in is ready.
// Combined with the runner's stop-on-first-failure, a failed create_ad means
// its paired pause(old) never runs.
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
  actionType: CcInternalActionType; // only: budget_update|pause|enable|add_negatives|create_keywords|create_ad|update_keyword_status|update_cpc|remove_negatives
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

/** v2.7: same, but null (smart-bidding ad group with no manual CPC) reads "(auto)". */
function fmtCpcBase(micros: number | null): string {
  return micros === null ? "(auto)" : fmtMicros(micros);
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

  // Fail-closed guard (v2.7): a negative baseKeyword must never carry a
  // desiredStatus — the UI shows no status control for negatives, so a
  // desiredStatus on one is either a bug or a client trying to slip a status
  // change past the differ. Checked before any phase runs (mirrors the
  // tmp:-guard self-assert at the bottom of this function).
  for (const g of c.adGroups) {
    for (const k of g.baseKeywords) {
      if (k.negative && k.desiredStatus !== undefined) {
        throw new Error(`No se puede pausar/reactivar una negativa (keyword «${k.text}» en «${g.base.name}»).`);
      }
    }
  }

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

  // --- Phase A2 (v2.7): batched keyword pause, one action per ad group ---
  for (const g of c.adGroups) {
    const toPause = g.baseKeywords.filter(
      (k) => !k.negative && k.desiredStatus === "PAUSED" && k.status === "ENABLED"
    );
    if (toPause.length > 0) {
      push({
        localRef: null,
        actionType: "update_keyword_status",
        entityKind: "ad_group",
        entityRef: g.id,
        payload: {
          status: "PAUSED",
          keywords: toPause.map((k) => ({ resourceName: k.resourceName, text: k.text })),
        },
        expected: null,
        entityName: g.base.name,
        note: `Pausar ${toPause.length} keyword(s) en «${g.base.name}»`,
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

  // --- Phase B2 (v2.7): ad-group CPC change. Setting is allowed even when
  // base is null (first manual bid on a smart-bidding group); clearing back
  // to null is deferred, so a null desired never emits. ---
  for (const g of c.adGroups) {
    const desiredCpc = g.desired.cpcBidMicros;
    if (desiredCpc !== null && desiredCpc !== g.base.cpcBidMicros) {
      push({
        localRef: null,
        actionType: "update_cpc",
        entityKind: "ad_group",
        entityRef: g.id,
        payload: { newCpcBidMicros: desiredCpc },
        expected: { cpcBidMicros: g.base.cpcBidMicros },
        entityName: g.base.name,
        note: `CPC de «${g.base.name}»: ${fmtCpcBase(g.base.cpcBidMicros)} → ${fmtMicros(desiredCpc)}`,
      });
    }
  }

  // --- Phase C0 (v2.7): remove live campaign negatives, BEFORE add_negatives ---
  if (c.removeNegatives.length > 0) {
    const removed = c.removeNegatives.map((rn) => {
      const neg = c.baseNegatives.find((n) => n.resourceName === rn);
      if (!neg) {
        throw new Error(`Negativa desconocida (fuera de la base cargada): ${rn}`);
      }
      return { text: neg.text, match: neg.match };
    });
    push({
      localRef: null,
      actionType: "remove_negatives",
      entityKind: "campaign",
      entityRef: c.id,
      payload: { resourceNames: c.removeNegatives, removed },
      expected: null,
      entityName: c.base.name,
      note: `Quitar ${c.removeNegatives.length} negativa(s) de «${c.base.name}»`,
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

  // --- Phase E0 (v2.7): batched keyword reactivate, one action per ad group.
  // Runs WITH the enables (LAST) and BEFORE the ad-group/campaign enable
  // loops below — narrowest scope first, mirroring A2's broadest-first pause
  // direction. ---
  for (const g of c.adGroups) {
    const toEnable = g.baseKeywords.filter(
      (k) => !k.negative && k.desiredStatus === "ENABLED" && k.status === "PAUSED"
    );
    if (toEnable.length > 0) {
      push({
        localRef: null,
        actionType: "update_keyword_status",
        entityKind: "ad_group",
        entityRef: g.id,
        payload: {
          status: "ENABLED",
          keywords: toEnable.map((k) => ({ resourceName: k.resourceName, text: k.text })),
        },
        expected: null,
        entityName: g.base.name,
        note: `Reactivar ${toEnable.length} keyword(s) en «${g.base.name}»`,
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
