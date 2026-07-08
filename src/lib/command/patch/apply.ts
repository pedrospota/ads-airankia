// Command Center v2.4 "Copiloto Anclado" — THE chokepoint (spec §a). Pure, isomorphic,
// no rail/IO imports (no gates.ts, no executor.ts, no actions-repo.ts, no db). One
// implementation, three call sites: builder accept, editor accept, and the propose_patch
// route's server DRY RUN — so the model can never surface a card the accept path would
// reject, and the accept click can never apply something the model's dry run didn't already
// clear.
//
// The 6-rule ladder, enforced IN ORDER, ALL-OR-NOTHING: one bad op rejects the WHOLE patch,
// and the input doc is never mutated (an accepted card is a unit — partial apply would make
// the card lie about what it did).
//   1. blueprintPatchSchema.parse the patch shape (+ docKind must match the target's).
//   2. Node resolution — nodeId must resolve to a real node in the doc (fail-closed).
//   3. field ∈ WRITABLE_FIELDS[docKind][nodeKind], value parses against THAT field's own
//      real sub-schema (never a duplicate — see patch/schema.ts's imports).
//   4. Edit invariants mirrored from mergeEditDoc: removeNegatives ⊆ baseNegatives
//      resourceNames. (desiredStatus-on-a-real-row is already enforced by rule 2 — a
//      baseKeyword node only resolves for a resourceName the stored doc actually loaded.)
//   5. Immutable rebuild (structuredClone, never mutate the input) + FULL-doc re-parse via
//      the real blueprintDocSchema/editDocSchema — this re-fires the bidding superRefine
//      and the EDIT_BATCH_MAX blast bounds against the doc as a WHOLE, not op-by-op.
//   6. No side effects, no persistence, no cc_actions. Caller decides.
import { blueprintDocSchema, type CcBlueprintDoc } from "../blueprint/schema";
import { editDocSchema, type GoogleSearchEditDoc } from "../edit/schema";
import {
  blueprintPatchSchema,
  fieldSchemaFor,
  resolveNode,
  type BlueprintPatch,
  type NodeKind,
} from "./schema";

export type PatchTarget =
  | { docKind: "google_create"; doc: CcBlueprintDoc }
  | { docKind: "google_edit"; doc: GoogleSearchEditDoc };

export type ApplyPatchResult =
  | { ok: true; doc: PatchTarget["doc"]; touched: Array<{ nodeId: string; field: string }> }
  | { ok: false; errors: Array<{ opIndex: number; message: string }> }; // es-MX, shown to model AND human

interface ResolvedOp {
  opIndex: number;
  nodeId: string;
  canonicalId: string;
  nodeKind: NodeKind;
  field: string;
  value: unknown;
}

function firstIssueMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "no cumple el formato esperado.";
}

/** Rule 4's write side: locates the resolved node in the CLONED doc and sets `field`. */
function writeOp(target: PatchTarget, doc: PatchTarget["doc"], op: ResolvedOp): void {
  if (target.docKind === "google_create") {
    const c = (doc as CcBlueprintDoc).campaign;
    if (op.nodeKind === "campaign") {
      (c as unknown as Record<string, unknown>)[op.field] = op.value;
      return;
    }
    if (op.nodeKind === "budget") {
      (c.budget as unknown as Record<string, unknown>)[op.field] = op.value;
      return;
    }
    if (op.nodeKind === "adGroup") {
      const ag = c.adGroups.find((a) => a.nodeId === op.canonicalId);
      if (ag) (ag as unknown as Record<string, unknown>)[op.field] = op.value;
      return;
    }
    if (op.nodeKind === "ad") {
      for (const ag of c.adGroups) {
        const adNode = ag.ads.find((a) => a.nodeId === op.canonicalId);
        if (adNode) {
          (adNode as unknown as Record<string, unknown>)[op.field] = op.value;
          return;
        }
      }
    }
    return;
  }

  const c = (doc as GoogleSearchEditDoc).campaign;
  if (op.nodeKind === "campaign") {
    if (op.field === "desired.status") c.desired.status = op.value as typeof c.desired.status;
    else if (op.field === "desired.dailyBudgetMicros") c.desired.dailyBudgetMicros = op.value as number;
    else if (op.field === "newNegatives") c.newNegatives = op.value as typeof c.newNegatives;
    else if (op.field === "removeNegatives") c.removeNegatives = op.value as string[];
    return;
  }
  if (op.nodeKind === "adGroup") {
    const ag = c.adGroups.find((a) => a.resourceName === op.canonicalId);
    if (!ag) return;
    if (op.field === "desired.status") ag.desired.status = op.value as typeof ag.desired.status;
    else if (op.field === "desired.cpcBidMicros") ag.desired.cpcBidMicros = op.value as number | null;
    else if (op.field === "newKeywords") ag.newKeywords = op.value as typeof ag.newKeywords;
    else if (op.field === "newAds") ag.newAds = op.value as typeof ag.newAds;
    return;
  }
  if (op.nodeKind === "baseKeyword") {
    for (const ag of c.adGroups) {
      const row = ag.baseKeywords.find((k) => k.resourceName === op.canonicalId);
      if (row) {
        row.desiredStatus = op.value as typeof row.desiredStatus;
        return;
      }
    }
    return;
  }
  if (op.nodeKind === "ad") {
    for (const ag of c.adGroups) {
      const adRow = ag.ads.find((a) => a.resourceName === op.canonicalId);
      if (adRow) {
        adRow.replacement = op.value as typeof adRow.replacement;
        return;
      }
    }
  }
}

export function applyBlueprintPatch(target: PatchTarget, patch: BlueprintPatch): ApplyPatchResult {
  // Rule 1: shape parse.
  const shapeResult = blueprintPatchSchema.safeParse(patch);
  if (!shapeResult.success) {
    return { ok: false, errors: [{ opIndex: -1, message: `El patch no tiene un formato válido: ${firstIssueMessage(shapeResult.error)}` }] };
  }
  const p: BlueprintPatch = shapeResult.data;
  if (p.docKind !== target.docKind) {
    return { ok: false, errors: [{ opIndex: -1, message: "El patch no corresponde a este tipo de documento." }] };
  }

  // Rules 2 + 3: per-op node resolution, field whitelist, value sub-schema parse.
  const errors: Array<{ opIndex: number; message: string }> = [];
  const resolved: ResolvedOp[] = [];

  p.ops.forEach((op, opIndex) => {
    const node = resolveNode(target.doc, op.nodeId);
    if (!node) {
      errors.push({ opIndex, message: `No se encontró el nodo "${op.nodeId}" en este borrador.` });
      return;
    }
    const fieldSchema = fieldSchemaFor(target.docKind, node.kind, op.field);
    if (!fieldSchema) {
      errors.push({ opIndex, message: `El campo "${op.field}" no se puede modificar en este nodo.` });
      return;
    }
    const valueResult = fieldSchema.safeParse(op.value);
    if (!valueResult.success) {
      errors.push({ opIndex, message: `Valor inválido para "${op.field}": ${firstIssueMessage(valueResult.error)}` });
      return;
    }
    resolved.push({ opIndex, nodeId: op.nodeId, canonicalId: node.canonicalId, nodeKind: node.kind, field: op.field, value: valueResult.data });
  });

  if (errors.length > 0) return { ok: false, errors };

  // Rule 4: edit invariants mirrored from mergeEditDoc. removeNegatives ⊆ baseNegatives
  // resourceNames (desiredStatus-on-an-existing-row is already guaranteed by rule 2 above —
  // a "baseKeyword" node only ever resolves for a resourceName the stored doc loaded).
  if (target.docKind === "google_edit") {
    const doc = target.doc;
    const knownNegatives = new Set(doc.campaign.baseNegatives.map((n) => n.resourceName));
    for (const r of resolved) {
      if (r.field !== "removeNegatives") continue;
      const requested = r.value as string[];
      const foreign = requested.filter((rn) => !knownNegatives.has(rn));
      if (foreign.length > 0) {
        errors.push({ opIndex: r.opIndex, message: `No se pueden quitar negativas ajenas a la campaña: ${foreign.join(", ")}.` });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Rule 5: immutable rebuild (never mutate target.doc) + full-doc re-parse.
  const nextDoc = structuredClone(target.doc) as PatchTarget["doc"];
  for (const op of resolved) {
    writeOp(target, nextDoc, op);
  }

  const reparsed = target.docKind === "google_create"
    ? blueprintDocSchema.safeParse(nextDoc)
    : editDocSchema.safeParse(nextDoc as GoogleSearchEditDoc);
  if (!reparsed.success) {
    return { ok: false, errors: [{ opIndex: -1, message: `El documento resultante no es válido: ${firstIssueMessage(reparsed.error)}` }] };
  }

  // Rule 6: no side effects — just the new doc + what changed. Caller (accept handler /
  // propose_patch dry run) decides persistence, prov stamping, and cc_actions.
  // `nodeId` here is the CANONICAL id (node.canonicalId), not the raw op.nodeId the model
  // sent — for edit docs the "campaign" alias and the real resourceName must collapse to the
  // SAME touched entry, or a caller stamping `_prov` keys from `touched` (`${nodeId}:${field}`)
  // could end up with two differently-spelled keys for the one node that deriveAiMarkers/
  // sanitizeProv (both keyed on canonicalId) would then disagree about.
  const touched = resolved.map((r) => ({ nodeId: r.canonicalId, field: r.field }));
  return { ok: true, doc: reparsed.data as PatchTarget["doc"], touched };
}
