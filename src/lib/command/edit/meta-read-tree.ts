// Command Center meta-edit — PURE mapper from raw Graph rows
// (RawMetaCampaignTree, read via networks/meta.ts#readMetaCampaignTree) to the
// edit document the operator reviews (MetaEditDoc). No I/O, no
// Date.now()/new Date() — nowIso is injected by the caller (same purity rule
// as edit/read-tree.ts). doc.campaign.base becomes the DRIFT baseline, so
// every field here must faithfully reflect the live account.
import type { RawMetaCampaignTree } from "../networks/meta";
import { MICROS_PER_MINOR_UNIT } from "../types";
import type { MetaEditDoc } from "./meta-schema";

type Row = Record<string, unknown>;
type Status = "ENABLED" | "PAUSED";
type Learning = "LEARNING" | "STABLE" | "LIMITED" | "UNKNOWN";

function str(value: unknown): string {
  return typeof value === "string" ? value : value != null ? String(value) : "";
}

/** Fail-closed: the edit surface only models ACTIVE/PAUSED configured statuses
 * (readMetaCampaignTree already filtered leaves; this is the mapper's own belt,
 * mirroring read-tree.ts's requireEditableStatus). */
function requireEditableStatus(status: unknown, label: string): Status {
  const s = String(status ?? "").toUpperCase();
  if (s === "ACTIVE") return "ENABLED";
  if (s === "PAUSED") return "PAUSED";
  throw new Error(`Estado de ${label} no soportado en este editor: ${String(status)}`);
}

/** Graph budgets come back as minor-unit strings ("2000" cents). minor × 10_000
 * = micros — the listCampaigns conversion (networks/meta.ts). Missing/unset →
 * null (CBO adsets, lifetime-budget nodes), never 0. */
function budgetMicros(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n * MICROS_PER_MINOR_UNIT : null;
}

/** The mapLearning convention (networks/meta.ts): LEARNING → LEARNING,
 * SUCCESS → STABLE, FAIL → LIMITED, anything else → UNKNOWN. Re-derived here
 * (8 lines) rather than exported from the adapter — display/warn only. */
function learningPhase(info: unknown): Learning {
  const s = String((info as Row | undefined)?.status ?? "").toUpperCase();
  if (s === "LEARNING") return "LEARNING";
  if (s === "SUCCESS") return "STABLE";
  if (s === "FAIL") return "LIMITED";
  return "UNKNOWN";
}

/**
 * PURE — desired mirrors base on load (the operator hasn't proposed anything
 * yet). nowIso stamps loadedAt, the shared TTL clock (EDIT_BASELINE_MAX_AGE_MS).
 */
export function buildMetaEditDoc(tree: RawMetaCampaignTree, accountRef: string, nowIso: string): MetaEditDoc {
  const c = tree.campaign;
  const campaignStatus = requireEditableStatus(c.status, "campaña");
  const campaignDaily = budgetMicros(c.daily_budget);

  const adsByAdset = new Map<string, Row[]>();
  for (const ad of tree.ads) {
    const key = str(ad.adset_id);
    const list = adsByAdset.get(key) ?? [];
    list.push(ad);
    adsByAdset.set(key, list);
  }

  return {
    docType: "meta_edit_v1",
    network: "meta_ads",
    accountRef,
    loadedAt: nowIso,
    campaign: {
      id: str(c.id),
      base: {
        name: str(c.name),
        status: campaignStatus,
        effectiveStatus: str(c.effective_status),
        dailyBudgetMicros: campaignDaily,
        lifetimeBudgetMicros: budgetMicros(c.lifetime_budget),
        currency: tree.currency,
      },
      desired: { status: campaignStatus, dailyBudgetMicros: campaignDaily },
      adsets: tree.adsets.map((row) => {
        const status = requireEditableStatus(row.status, "conjunto de anuncios");
        const daily = budgetMicros(row.daily_budget);
        return {
          id: str(row.id),
          base: {
            name: str(row.name),
            status,
            effectiveStatus: str(row.effective_status),
            dailyBudgetMicros: daily,
            lifetimeBudgetMicros: budgetMicros(row.lifetime_budget),
            learningPhase: learningPhase(row.learning_stage_info),
          },
          desired: { status, dailyBudgetMicros: daily },
          ads: (adsByAdset.get(str(row.id)) ?? []).map((ad) => {
            const adStatus = requireEditableStatus(ad.status, "anuncio");
            return {
              id: str(ad.id),
              base: { name: str(ad.name), status: adStatus, effectiveStatus: str(ad.effective_status) },
              desired: { status: adStatus },
            };
          }),
        };
      }),
    },
  };
}
