import { describe, expect, test } from "bun:test";
import { buildNovedadesMessage, notifyNovedades, type NotifyDeps } from "../notify";
import type { NovedadesResult } from "../actions-repo";

const W = "11111111-1111-1111-1111-111111111111";
const ref = (id: string) => ({ id, workspaceId: W });

function novedades(partial: Partial<NovedadesResult["items"]>): NovedadesResult {
  const items = {
    planesFallidos: [], accionesFallidas: [], conDeriva: [], bloqueadas: [], caducadas: [],
    ...partial,
  };
  const counts = {
    planesFallidos: items.planesFallidos.length,
    accionesFallidas: items.accionesFallidas.length,
    conDeriva: items.conDeriva.length,
    bloqueadas: items.bloqueadas.length,
    caducadas: items.caducadas.length,
  };
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), items };
}

function fakeDeps(result: NovedadesResult, opts?: { dupes?: Set<string>; sendFails?: boolean }) {
  const inserts: string[] = [];
  const sends: string[] = [];
  const deps: NotifyDeps = {
    novedades: async () => result,
    insertIfNew: async (workspaceId, kind, itemId) => {
      const key = `${workspaceId}|${kind}|${itemId}`;
      inserts.push(key);
      return !(opts?.dupes?.has(key));
    },
    send: async (text) => {
      if (opts?.sendFails) throw new Error("telegram caído");
      sends.push(text);
    },
    appUrl: "https://ads.airankia.com",
  };
  return { deps, inserts, sends };
}

describe("notifyNovedades — DB-dedup'd Telegram send (spec §c)", () => {
  test("all-new items → exactly one send naming only non-zero categories, with deep links", async () => {
    const { deps, sends } = fakeDeps(novedades({
      accionesFallidas: [ref("a1"), ref("a2")],
      conDeriva: [ref("d1")],
    }));
    const out = await notifyNovedades([W], deps);
    expect(out.sent).toBe(true);
    expect(sends.length).toBe(1);
    expect(sends[0]).toContain("2 acciones fallidas");
    expect(sends[0]).toContain("1 con deriva");
    expect(sends[0]).toContain("https://ads.airankia.com/command/acciones");
    expect(sends[0]).not.toContain("plan");
  });

  test("all items already notified → NO send (dedup)", async () => {
    const items = { accionesFallidas: [ref("a1")] };
    const { deps, sends } = fakeDeps(novedades(items), {
      dupes: new Set([`${W}|accion_fallida|a1`]),
    });
    const out = await notifyNovedades([W], deps);
    expect(out.sent).toBe(false);
    expect(sends.length).toBe(0);
  });

  test("mixed: only categories with ≥1 NEW item appear in the message", async () => {
    const { deps, sends } = fakeDeps(
      novedades({ accionesFallidas: [ref("old")], caducadas: [ref("new1")] }),
      { dupes: new Set([`${W}|accion_fallida|old`]) }
    );
    await notifyNovedades([W], deps);
    expect(sends.length).toBe(1);
    expect(sends[0]).toContain("caducada");
    expect(sends[0]).not.toContain("fallida");
  });

  test("inserts happen BEFORE the send; a failed send never throws and never rolls back", async () => {
    const { deps, inserts } = fakeDeps(novedades({ conDeriva: [ref("d1")] }), { sendFails: true });
    const out = await notifyNovedades([W], deps);
    expect(out.sent).toBe(false);
    expect(inserts).toContain(`${W}|deriva|d1`); // row stays → no re-spam next sweep
  });

  test("zero novedades → zero inserts, zero sends", async () => {
    const { deps, inserts, sends } = fakeDeps(novedades({}));
    const out = await notifyNovedades([W], deps);
    expect(out.sent).toBe(false);
    expect(inserts.length).toBe(0);
    expect(sends.length).toBe(0);
  });
});

describe("buildNovedadesMessage — pure es-MX formatter", () => {
  test("null when nothing is new", () => {
    expect(buildNovedadesMessage(
      { planesFallidos: 0, accionesFallidas: 0, conDeriva: 0, bloqueadas: 0, caducadas: 0 },
      "https://x"
    )).toBeNull();
  });

  test("singular/plural + total header", () => {
    const msg = buildNovedadesMessage(
      { planesFallidos: 1, accionesFallidas: 0, conDeriva: 0, bloqueadas: 0, caducadas: 2 },
      "https://x"
    );
    expect(msg).toContain("3 novedades");
    expect(msg).toContain("1 plan fallido");
    expect(msg).toContain("2 caducadas");
    expect(msg).toContain("https://x/command/bitacora");
  });
});
