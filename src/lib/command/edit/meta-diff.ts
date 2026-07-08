// Command Center meta-edit — PURE differ: MetaEditDoc -> ordered
// EditCompiledAction[] for the execution rail. Sibling of edit/diff.ts
// (google), same row type (imported — diff.ts already exports it), own recKey
// prefix ("me-", never collides with "ed-").
//
// Ordering encodes the same safety property as the google differ: the enabled
// delivery surface never grows before its container is ready. Phases run
// A (pauses, broadest-first: campaign → adsets → ads) -> B (budget_update:
// campaign, then per-adset) -> E (enables, narrowest-first, LAST: ads →
// adsets → campaign). Combined with the runner's stop-on-first-failure, a
// failed run never leaves more enabled than before.
//
// Slice-1 emits NO creates: entityRef is always the bare numeric Graph node id
// at every level — exactly what buildMetaMutation POSTs to (`/${entityRef}`)
// and snapshot() GETs. localRef is always null.
//
// PURITY: no Date, no random, no IO. Deterministic output for identical input.
import { createHash } from "node:crypto";
import type { EditCompiledAction } from "./diff";
import type { MetaEditDoc } from "./meta-schema";

/** Private sibling of diff.ts's recKey — 8 lines beat exporting/parameterizing
 * the google helper (spec adjudication #3). */
function recKey(blueprintId: string, seq: number): string {
  return (
    "me-" +
    createHash("sha256")
      .update(`${blueprintId}|${seq}`)
      .digest("hex")
      .slice(0, 14)
  );
}

/** Format micros as a currency-unit string for es-MX antes → después notes
 * (fmtMicros convention, edit/diff.ts). */
function fmtMicros(micros: number): string {
  return String(micros / 1_000_000);
}

export function diffMetaEditDoc(doc: MetaEditDoc, blueprintId: string): EditCompiledAction[] {
  const c = doc.campaign;
  const out: EditCompiledAction[] = [];
  let seq = 0;

  const push = (row: Omit<EditCompiledAction, "seq" | "recKey">) => {
    out.push({ ...row, seq, recKey: recKey(blueprintId, seq) });
    seq += 1;
  };

  const pushStatus = (
    actionType: "pause" | "enable",
    entityKind: "campaign" | "adset" | "ad",
    entityRef: string,
    name: string,
    baseStatus: "ENABLED" | "PAUSED"
  ) => {
    const label = entityKind === "campaign" ? "campaña" : entityKind === "adset" ? "conjunto de anuncios" : "anuncio";
    push({
      localRef: null,
      actionType,
      entityKind,
      entityRef,
      payload: {},
      expected: { status: baseStatus },
      entityName: name,
      note: `${actionType === "pause" ? "Pausar" : "Habilitar"} ${label} «${name}»`,
    });
  };

  // --- Phase A: pauses, broadest-first (campaign → adsets → ads) ---
  if (c.desired.status === "PAUSED" && c.base.status === "ENABLED") {
    pushStatus("pause", "campaign", c.id, c.base.name, "ENABLED");
  }
  for (const as of c.adsets) {
    if (as.desired.status === "PAUSED" && as.base.status === "ENABLED") {
      pushStatus("pause", "adset", as.id, as.base.name, "ENABLED");
    }
  }
  for (const as of c.adsets) {
    for (const ad of as.ads) {
      if (ad.desired.status === "PAUSED" && ad.base.status === "ENABLED") {
        pushStatus("pause", "ad", ad.id, ad.base.name, "ENABLED");
      }
    }
  }

  // --- Phase B: budget_update — campaign (CBO) then per-adset (ABO) ---
  // Defense-in-depth (mirrors diff.ts's budgetShared throw): the schema
  // already forbids a desired budget on a base-null node; the differ
  // re-asserts so a doc that somehow bypassed parse can never emit a write
  // that introduces a budget where Meta doesn't own one.
  const emitBudget = (
    entityKind: "campaign" | "adset",
    entityRef: string,
    name: string,
    baseMicros: number | null,
    desiredMicros: number | null
  ) => {
    if (desiredMicros === null || desiredMicros === baseMicros) return; // no-op / budget-locked node
    if (baseMicros === null) {
      throw new Error(`«${name}» no administra presupuesto diario en este nivel; no se puede introducir uno desde el editor.`);
    }
    push({
      localRef: null,
      actionType: "budget_update",
      entityKind,
      entityRef,
      payload: { newDailyBudgetMicros: desiredMicros },
      expected: { dailyBudgetMicros: baseMicros },
      entityName: name,
      note: `Presupuesto de «${name}»: ${fmtMicros(baseMicros)} → ${fmtMicros(desiredMicros)}`,
    });
  };
  emitBudget("campaign", c.id, c.base.name, c.base.dailyBudgetMicros, c.desired.dailyBudgetMicros);
  for (const as of c.adsets) {
    emitBudget("adset", as.id, as.base.name, as.base.dailyBudgetMicros, as.desired.dailyBudgetMicros);
  }

  // --- Phase E: enables, narrowest-first, LAST (ads → adsets → campaign) ---
  for (const as of c.adsets) {
    for (const ad of as.ads) {
      if (ad.desired.status === "ENABLED" && ad.base.status === "PAUSED") {
        pushStatus("enable", "ad", ad.id, ad.base.name, "PAUSED");
      }
    }
  }
  for (const as of c.adsets) {
    if (as.desired.status === "ENABLED" && as.base.status === "PAUSED") {
      pushStatus("enable", "adset", as.id, as.base.name, "PAUSED");
    }
  }
  if (c.desired.status === "ENABLED" && c.base.status === "PAUSED") {
    pushStatus("enable", "campaign", c.id, c.base.name, "PAUSED");
  }

  // Final self-assert (kept even though this differ emits no creates — the
  // 4-line invariant is what makes "every ref is a live Graph node id" a
  // checked property instead of a comment; mirrors diff.ts's tmp: guard).
  for (const a of out) {
    if (a.entityRef.startsWith("tmp:")) {
      throw new Error(`Invariante rota: acción de edición Meta con ref tmp: (${a.actionType} ${a.entityRef})`);
    }
  }

  return out;
}
