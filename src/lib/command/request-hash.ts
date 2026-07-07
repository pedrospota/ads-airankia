import { createHash } from "crypto";

/** Deterministic JSON: objects get sorted keys (recursive); arrays keep order. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error("canonicalJson: undefined no es serializable");
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  // A Date has no own enumerable keys, so the Object.keys branch below would collapse it to "{}".
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
