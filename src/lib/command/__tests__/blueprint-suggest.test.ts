import { describe, it, expect } from "bun:test";
import { suggestField, type KeywordSuggestion } from "../blueprint/suggest";
import { RSA_SPEC } from "../knowledge";
import type { UnifiedStructuredResult } from "@/lib/llm";

type MockCallFn = (<U>() => Promise<UnifiedStructuredResult<U>>) & { readonly calls: number };

/** Builds a mock `call` (same shape as `callStructured`) that never hits the network. */
function mockCall<T>(data: T): MockCallFn {
  const counter = { calls: 0 };
  const fn = async <U>(): Promise<UnifiedStructuredResult<U>> => {
    counter.calls += 1;
    return {
      data: data as unknown as U,
      usage: { inputTokens: 10, outputTokens: 10 },
      costMicros: 0,
      model: "mock-model",
      provider: "anthropic",
    };
  };
  Object.defineProperty(fn, "calls", { get: () => counter.calls });
  return fn as MockCallFn;
}

describe("suggestField", () => {
  it("clamps an over-long headline to <=30 chars and reports a warning", async () => {
    const tooLong = "x".repeat(40);
    const call = mockCall({ value: tooLong });
    const result = await suggestField(
      { kind: "headline", context: "Clínica dental en CDMX" },
      { call }
    );
    expect(typeof result.value).toBe("string");
    expect((result.value as string).length).toBeLessThanOrEqual(RSA_SPEC.headline.maxLen);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(call.calls).toBe(1); // never retried against the network — DI mock is the only call site
  });

  it("passes a valid headline through unchanged with no warning", async () => {
    const valid = "Implantes dentales hoy";
    const result = await suggestField(
      { kind: "headline", context: "Clínica dental en CDMX" },
      { call: mockCall({ value: valid }) }
    );
    expect(result.value).toBe(valid);
    expect(result.warnings.length).toBe(0);
  });

  it("clamps an over-long description to <=90 chars and reports a warning", async () => {
    const tooLong = "y".repeat(120);
    const result = await suggestField(
      { kind: "description", context: "Clínica dental en CDMX" },
      { call: mockCall({ value: tooLong }) }
    );
    expect((result.value as string).length).toBeLessThanOrEqual(RSA_SPEC.description.maxLen);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("passes a valid description through unchanged with no warning", async () => {
    const valid = "Agenda tu valoración sin costo con especialistas certificados hoy.";
    const result = await suggestField(
      { kind: "description", context: "Clínica dental en CDMX" },
      { call: mockCall({ value: valid }) }
    );
    expect(result.value).toBe(valid);
    expect(result.warnings.length).toBe(0);
  });

  it("clamps an over-long group name and reports a warning", async () => {
    const tooLong = "Grupo de anuncios muy largo ".repeat(10);
    const result = await suggestField(
      { kind: "group_name", context: "Clínica dental en CDMX" },
      { call: mockCall({ value: tooLong }) }
    );
    expect((result.value as string).length).toBeLessThanOrEqual(80);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("caps keyword count/length and never returns an empty array", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      text: `palabra clave numero ${i} extremadamente larga para forzar el recorte`,
      matchType: "BROAD",
    }));
    const result = await suggestField(
      { kind: "keywords", context: "Clínica dental en CDMX" },
      { call: mockCall({ value: many }) }
    );
    const value = result.value as Array<{ text: string; matchType: string }>;
    expect(value.length).toBeGreaterThan(0);
    expect(value.length).toBeLessThanOrEqual(10);
    for (const kw of value) {
      expect(kw.text.length).toBeLessThanOrEqual(80);
    }
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("passes valid keywords through with no warning", async () => {
    const valid: KeywordSuggestion[] = [
      { text: "implantes dentales cdmx", matchType: "PHRASE" },
      { text: "clinica dental cdmx", matchType: "BROAD" },
    ];
    const result = await suggestField(
      { kind: "keywords", context: "Clínica dental en CDMX" },
      { call: mockCall({ value: valid }) }
    );
    expect(result.value).toEqual(valid);
    expect(result.warnings.length).toBe(0);
  });

  it("falls back to a safe non-empty value when the AI returns nothing usable", async () => {
    const result = await suggestField(
      { kind: "headline", context: "Clínica dental en CDMX" },
      { call: mockCall({ value: "" }) }
    );
    expect((result.value as string).length).toBeGreaterThan(0);
    expect((result.value as string).length).toBeLessThanOrEqual(RSA_SPEC.headline.maxLen);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
