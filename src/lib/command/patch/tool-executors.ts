// Command Center v2.4 "Copiloto Anclado" — pure, testable helpers backing
// /api/command/copiloto's two tools (spec §c). Extracted out of the route so they can be
// unit-tested without a request/DB/OpenRouter harness: the route itself stays thin wiring
// (auth, grounding, tool-loop assembly, system prompt) and is NOT separately unit-tested,
// per repo convention ("no unit tests for the route").
//
//   - trimDocForTool: the get_doc tool's payload shaper — arrays capped at
//     GET_DOC_ARRAY_CAP items (+ long strings capped defensively), every cut noted in a
//     `_truncado` sibling. Mirrors the ARRAY-CAP + `_truncado` idiom src/lib/copiloto-tools.ts
//     uses for the OTHER /api/copiloto route — a local reimplementation, not an import: that
//     file is server-only (imports the sentinel belt) and is explicitly UNTOUCHED by v2.4.
//   - executeProposePatch: the propose_patch tool's server DRY RUN — combines the model's
//     {summary, ops} args with the route's OWN known docKind (never model-supplied), full
//     blueprintPatchSchema-parses the result, then runs the SAME applyBlueprintPatch dry run
//     the human Accept click will re-run later — so the model can never surface a card the
//     accept path would reject, and gets the same es-MX errors back for self-correction. Pure:
//     never mutates `target.doc`, never persists, no rail import, no randomness (the caller
//     assigns the proposal's id at push time).
import { blueprintPatchSchema, type BlueprintPatch, type DocKind } from "./schema";
import { applyBlueprintPatch, type PatchTarget } from "./apply";

// ---------------------------------------------------------------------------
// get_doc trimming
// ---------------------------------------------------------------------------

export const GET_DOC_ARRAY_CAP = 30;
const GET_DOC_STRING_CAP = 2_000;

function deepTrim(value: unknown, notes: string[], path: string): unknown {
  if (Array.isArray(value)) {
    let items = value;
    if (value.length > GET_DOC_ARRAY_CAP) {
      items = value.slice(0, GET_DOC_ARRAY_CAP);
      notes.push(`${path || "raíz"}: ${value.length} elementos → primeros ${GET_DOC_ARRAY_CAP}`);
    }
    return items.map((v, i) => deepTrim(v, notes, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepTrim(v, notes, path ? `${path}.${k}` : k);
    }
    return out;
  }
  if (typeof value === "string" && value.length > GET_DOC_STRING_CAP) {
    notes.push(`${path || "raíz"}: texto recortado a ${GET_DOC_STRING_CAP} caracteres`);
    return `${value.slice(0, GET_DOC_STRING_CAP)}…`;
  }
  return value;
}

/**
 * Shapes the grounded doc for the get_doc tool result: arrays capped at GET_DOC_ARRAY_CAP
 * items (+ long strings capped defensively), every cut noted in a `_truncado` sibling — the
 * same raw-sibling convention `_ai`/`_prov` already use on this doc, not a `{data, _truncado}`
 * envelope. Untouched docs (nothing to trim) come back byte-identical (no `_truncado` noise).
 */
export function trimDocForTool(doc: unknown): unknown {
  const notes: string[] = [];
  const trimmed = deepTrim(doc, notes, "");
  if (notes.length === 0) return trimmed;
  if (trimmed !== null && typeof trimmed === "object" && !Array.isArray(trimmed)) {
    return { ...(trimmed as Record<string, unknown>), _truncado: notes.slice(0, 20) };
  }
  return { data: trimmed, _truncado: notes.slice(0, 20) };
}

// ---------------------------------------------------------------------------
// propose_patch dry-run executor
// ---------------------------------------------------------------------------

export const MAX_PROPOSALS = 3;

export interface ProposalOpRationale {
  nodeId: string;
  field: string;
  rationale: string;
}

/** The proposal shape minus `id` — the route assigns `id: crypto.randomUUID()` at push time
 * (kept OUT of this pure function so it stays free of randomness/IO). */
export interface ProposalDraft {
  summary: string;
  ops: BlueprintPatch["ops"];
  rationale: ProposalOpRationale[];
}

/** The full proposal record the route accumulates and returns (`{id, ...ProposalDraft}`). */
export interface Proposal extends ProposalDraft {
  id: string;
}

export type ProposePatchOutcome =
  | { status: "ok"; proposal: ProposalDraft }
  | { status: "invalid"; errors: Array<{ opIndex: number; message: string }> }
  | { status: "limit" };

function firstIssueMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "no cumple el formato esperado.";
}

/**
 * The propose_patch tool's server DRY RUN (spec §c). `proposalCount` is the CALLER's current
 * proposals-array length — checked FIRST, before any validation work, so once the per-turn
 * cap is reached every further propose_patch call (valid or not) returns "limit" without
 * spending a validation round. Never mutates `target.doc`.
 */
export function executeProposePatch(
  target: PatchTarget,
  docKind: DocKind,
  rawArgs: unknown,
  proposalCount: number,
  maxProposals: number = MAX_PROPOSALS
): ProposePatchOutcome {
  if (proposalCount >= maxProposals) return { status: "limit" };

  const argsObj = rawArgs !== null && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
  const shapeResult = blueprintPatchSchema.safeParse({ docKind, summary: argsObj.summary, ops: argsObj.ops });
  if (!shapeResult.success) {
    return {
      status: "invalid",
      errors: [{ opIndex: -1, message: `El patch no tiene un formato válido: ${firstIssueMessage(shapeResult.error)}` }],
    };
  }
  const patch = shapeResult.data;

  const applied = applyBlueprintPatch(target, patch);
  if (!applied.ok) return { status: "invalid", errors: applied.errors };

  return {
    status: "ok",
    proposal: {
      summary: patch.summary,
      ops: patch.ops,
      rationale: patch.ops.map((op) => ({ nodeId: op.nodeId, field: op.field, rationale: op.rationale })),
    },
  };
}
