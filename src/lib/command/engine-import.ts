// Maps gads-sentinel ai_plan.optimizations into cc_actions drafts.
// Only unambiguous, low-blast-radius shapes are imported; the rest are counted
// as skipped so the UI can say "N no importables".
import { createHash } from "crypto";
import type { CcActionType, CcPayload } from "./types";

interface EngineOpt {
  tipo?: string; campaign_id?: string | number; campaign?: string;
  terminos?: unknown; texto?: string; confianza?: string;
  nuevo_presupuesto_micros?: unknown; budget_id?: string | number;
}

export interface ImportTarget {
  workspaceId: string; connectionId: string; accountRef: string; createdBy: string;
}

export interface ImportedAction {
  workspaceId: string; createdBy: string; network: "google_ads"; connectionId: string;
  accountRef: string; entityKind: "campaign"; entityRef: string; entityName: string | null;
  actionType: CcActionType; payload: CcPayload; source: "engine"; recKey: string;
  rationale: string | null; evidence: Record<string, unknown>;
}

function recKeyFor(accountRef: string, tipo: string, entityRef: string, extra: string): string {
  const h = createHash("sha256").update(`${accountRef}|${tipo}|${entityRef}|${extra}`).digest("hex").slice(0, 14);
  return `eng-${h}`;
}

export function mapEngineOptimizations(
  opts: EngineOpt[], target: ImportTarget
): { actions: ImportedAction[]; skipped: number } {
  const actions: ImportedAction[] = [];
  let skipped = 0;
  for (const opt of opts ?? []) {
    const tipo = String(opt.tipo ?? "").toLowerCase();
    const campaignId = opt.campaign_id != null ? String(opt.campaign_id) : "";
    const common = {
      workspaceId: target.workspaceId, createdBy: target.createdBy,
      network: "google_ads" as const, connectionId: target.connectionId,
      accountRef: target.accountRef, entityKind: "campaign" as const,
      entityRef: campaignId, entityName: opt.campaign ?? null,
      source: "engine" as const, rationale: opt.texto ?? null,
      evidence: { engine: true, tipo, confianza: opt.confianza ?? null },
    };
    if (tipo === "negativas" && campaignId && Array.isArray(opt.terminos) && opt.terminos.length) {
      const negatives = (opt.terminos as unknown[])
        .map((t) => String(t ?? "").trim()).filter(Boolean)
        .map((text) => ({ text, match: "PHRASE" as const }));
      actions.push({ ...common, actionType: "add_negatives", payload: { negatives },
        recKey: recKeyFor(target.accountRef, tipo, campaignId, negatives.map((n) => n.text).join(",")) });
    } else if (tipo === "pausar" && campaignId) {
      actions.push({ ...common, actionType: "pause", payload: {},
        recKey: recKeyFor(target.accountRef, tipo, campaignId, "") });
    } else if (tipo === "presupuesto" && campaignId && typeof opt.nuevo_presupuesto_micros === "number" && opt.nuevo_presupuesto_micros > 0) {
      actions.push({ ...common, actionType: "budget_update",
        payload: { newDailyBudgetMicros: Math.round(opt.nuevo_presupuesto_micros) },
        recKey: recKeyFor(target.accountRef, tipo, campaignId, String(opt.nuevo_presupuesto_micros)) });
    } else {
      skipped += 1;
    }
  }
  return { actions, skipped };
}
