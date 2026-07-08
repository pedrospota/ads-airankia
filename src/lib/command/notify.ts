// v3.0 — Telegram notifications layered on the Novedades query (spec §c).
//
// PURITY COVENANT: verify.ts stays byte-identical. This module is fired
// fire-and-forget from the /api/command/verify ROUTE after runSweep returns —
// a send is a side effect, so it lives outside the READ-only sweep, and a
// notify failure can never block or fail the sweep response.
//
// DEDUP: cc_notifications' unique index (workspace_id, kind, item_id) is the
// lock — INSERT … ON CONFLICT DO NOTHING, and only newly-inserted rows enter
// the message. Rows are inserted BEFORE the send, so a Telegram outage drops
// that batch instead of re-spamming on every following sweep (deliberate
// trade-off: losing one batch beats spamming forever).
import { adsDb } from "@/lib/ads-db";
import { ccNotifications } from "@/lib/schema";
import { listNovedades, type NovedadesCounts, type NovedadesResult } from "./actions-repo";

export type NovedadKind = "plan_fallido" | "accion_fallida" | "deriva" | "bloqueada" | "caducada";

/** category → (kind, es-MX label [singular, plural], deep link path) */
const CATEGORIES: Array<{
  key: keyof NovedadesCounts;
  kind: NovedadKind;
  emoji: string;
  singular: string;
  plural: string;
  path: string;
}> = [
  { key: "planesFallidos", kind: "plan_fallido", emoji: "🧩", singular: "plan fallido", plural: "planes fallidos", path: "/command/bitacora" },
  { key: "accionesFallidas", kind: "accion_fallida", emoji: "❌", singular: "acción fallida", plural: "acciones fallidas", path: "/command/acciones?filter=failed" },
  { key: "conDeriva", kind: "deriva", emoji: "⚠️", singular: "con deriva detectada", plural: "con deriva detectada", path: "/command/acciones?filter=executed" },
  { key: "bloqueadas", kind: "bloqueada", emoji: "🚧", singular: "bloqueada por compuertas", plural: "bloqueadas por compuertas", path: "/command/acciones?filter=approved" },
  { key: "caducadas", kind: "caducada", emoji: "⏳", singular: "caducada", plural: "caducadas", path: "/command/acciones?filter=expired" },
];

export interface NotifyDeps {
  novedades: (workspaceIds: string[]) => Promise<NovedadesResult>;
  /** true = newly inserted (notify); false = already notified (skip). */
  insertIfNew: (workspaceId: string, kind: NovedadKind, itemId: string) => Promise<boolean>;
  send: (text: string) => Promise<void>;
  appUrl: string;
}

export interface NotifyOutcome {
  sent: boolean;
  newCounts: NovedadesCounts;
}

export function notifyEnabled(): boolean {
  return (
    Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) &&
    process.env.CC_NOTIFY_ENABLED !== "false"
  );
}

/** PURE es-MX formatter. null when no category has new items. */
export function buildNovedadesMessage(newCounts: NovedadesCounts, appUrl: string): string | null {
  const total = Object.values(newCounts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const lines = [`🛰 Centro de Mando — ${total} ${total === 1 ? "novedad" : "novedades"}`, ""];
  for (const c of CATEGORIES) {
    const n = newCounts[c.key];
    if (n === 0) continue;
    lines.push(`${c.emoji} ${n} ${n === 1 ? c.singular : c.plural}`);
    lines.push(`   → ${appUrl}${c.path}`);
  }
  return lines.join("\n");
}

export function buildNotifyDeps(): NotifyDeps {
  return {
    novedades: listNovedades,
    insertIfNew: async (workspaceId, kind, itemId) => {
      const inserted = await adsDb
        .insert(ccNotifications)
        .values({ workspaceId, kind, itemId })
        .onConflictDoNothing()
        .returning({ id: ccNotifications.id });
      return inserted.length > 0;
    },
    send: async (text) => {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) return;
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`telegram sendMessage ${res.status}`);
    },
    appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://ads.airankia.com",
  };
}

export async function notifyNovedades(
  workspaceIds: string[],
  deps: NotifyDeps = buildNotifyDeps()
): Promise<NotifyOutcome> {
  const result = await deps.novedades(workspaceIds);
  const newCounts: NovedadesCounts = {
    planesFallidos: 0, accionesFallidas: 0, conDeriva: 0, bloqueadas: 0, caducadas: 0,
  };
  for (const c of CATEGORIES) {
    for (const item of result.items[c.key]) {
      if (await deps.insertIfNew(item.workspaceId, c.kind, item.id)) newCounts[c.key] += 1;
    }
  }
  const message = buildNovedadesMessage(newCounts, deps.appUrl);
  if (!message) return { sent: false, newCounts };
  try {
    await deps.send(message);
    return { sent: true, newCounts };
  } catch {
    // Rows are already inserted — deliberate: drop this batch, never re-spam.
    return { sent: false, newCounts };
  }
}
