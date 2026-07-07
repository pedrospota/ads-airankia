import { describe, it, expect } from "bun:test";
import { canonicalJson, requestHash } from "../request-hash";

describe("canonicalJson", () => {
  it("sorts object keys recursively and is stable", () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } });
    const b = canonicalJson({ a: { c: 2, d: [3, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it("preserves array order", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });
});

describe("requestHash", () => {
  it("returns a 64-char sha256 hex, stable across key order", () => {
    const h1 = requestHash({ op: "campaigns:mutate", body: { x: 1, y: 2 } });
    const h2 = requestHash({ body: { y: 2, x: 1 }, op: "campaigns:mutate" });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
