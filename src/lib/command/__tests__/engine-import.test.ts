import { describe, it, expect } from "bun:test";
import { mapEngineOptimizations } from "../engine-import";

const OPTS = [
  { tipo: "negativas", campaign_id: "111", campaign: "Brand", terminos: ["gratis", "empleo"], texto: "Bloquear términos", confianza: "alta" },
  { tipo: "pausar", campaign_id: "222", campaign: "Prospecting", texto: "Pausar campaña sin conversiones" },
  { tipo: "presupuesto", campaign_id: "333", campaign: "PMax", nuevo_presupuesto_micros: 15000000, texto: "Subir presupuesto" },
  { tipo: "presupuesto", campaign_id: "444", texto: "Ajustar presupuesto (sin monto)" },
  { tipo: "otra_cosa", texto: "No mapeable" },
];

describe("mapEngineOptimizations", () => {
  it("maps negativas/pausar/presupuesto-with-amount; skips the rest", () => {
    const { actions, skipped } = mapEngineOptimizations(OPTS as never, {
      workspaceId: "w1", connectionId: "c1", accountRef: "123", createdBy: "op@x.com",
    });
    expect(actions).toHaveLength(3);
    expect(skipped).toBe(2);
    const [neg, pause, budget] = actions;
    expect(neg.actionType).toBe("add_negatives");
    expect(neg.payload).toEqual({ negatives: [{ text: "gratis", match: "PHRASE" }, { text: "empleo", match: "PHRASE" }] });
    expect(neg.recKey).toMatch(/^eng-/);
    expect(pause.actionType).toBe("pause");
    expect(pause.entityRef).toBe("222");
    expect(budget.actionType).toBe("budget_update");
    expect(budget.payload).toEqual({ newDailyBudgetMicros: 15000000 });
    expect(budget.source).toBe("engine");
  });
});
