// Command Center v2.7 — Bitácora CSV export + weekly client report, shared
// helpers. Design spec §e: "Report — CSV + print-view, no token links".
//
// PURE module: no IO, no Date.now(), no React/Next import — safe to import
// from a server component (bitacora/page.tsx, bitacora/reporte/page.tsx), a
// "use client" component (bitacora-client.tsx), or a bun test file with zero
// setup. Deterministic for identical input, so executionsToCsv is unit-tested
// directly against fixed rows — no DB, no browser, no snapshot fixture.

/**
 * The Bitácora / weekly-report execution DTO. Canonical shape: bitacora/
 * page.tsx maps listExecutions()'s { execution: CcExecutionRow, action:
 * CcActionRow } join into this once; bitacora-client.tsx and bitacora/
 * reporte/page.tsx both consume the same rows.
 */
export interface ExecutionDto {
  id: string;
  actionId: string;
  network: string;
  accountRef: string;
  operation: string;
  validateOnly: boolean;
  status: string;
  actor: string;
  createdAt: string | null;
  actionType: string;
  entityName: string;
  actionStatus: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  rollbackNote: string | null;
  /** v2.7: cc_actions.rationale. listExecutions() already returns the full
   * CcActionRow (no repo change needed — see design spec §e); page.tsx maps
   * it into the DTO alongside the rest of the fields. */
  rationale: string | null;
}

/**
 * es-MX action-type labels. MIRRORS acciones-client.tsx's TYPE_LABEL (:31) —
 * kept as its own literal here (not imported) so this pure lib module carries
 * zero dependency on a "use client" app file. If the two ever drift, the
 * Acciones table and the Bitácora CSV/weekly report would show different
 * labels for the same action_type — the same mirrored-literal risk pattern
 * actions-repo.ts already documents for verify.ts's VERIFIABLE_ACTION_TYPES.
 */
export const ACTION_TYPE_LABEL_ES: Record<string, string> = {
  budget_update: "Cambio de presupuesto",
  pause: "Pausar",
  enable: "Activar",
  add_negatives: "Añadir negativas",
  update_keyword_status: "Pausar/Reactivar palabras clave",
  update_cpc: "Cambiar CPC",
  remove_negatives: "Quitar negativas",
};

export const NETWORK_LABEL_ES: Record<string, string> = {
  google_ads: "Google",
  meta_ads: "Meta",
};

function fmtBudget(v: unknown): string {
  return typeof v === "number" ? (v / 1_000_000).toFixed(2) : "—";
}

/**
 * Antes→Después summary — EXACTLY the logic bitacora-client.tsx's table has
 * always rendered (status + daily budget from the execution's before/after
 * EntitySnapshot jsonb), extracted here so the CSV export and the weekly
 * report page never disagree with what the operator sees on screen.
 */
export function formatBeforeAfter(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): string {
  if (!before) return "—";
  const b = `estado ${before.status ?? "?"} · $${fmtBudget(before.dailyBudgetMicros)}/día`;
  if (!after) return b;
  return `${b} → estado ${after.status ?? "?"} · $${fmtBudget(after.dailyBudgetMicros)}/día`;
}

/**
 * DD/MM/AAAA HH:mm — deliberately NOT toLocaleString("es-MX"): Intl's es-MX
 * data isn't reliably present across runtimes (this repo's bun resolves it to
 * en-US month/day ordering), and a report artifact a media buyer forwards to
 * a client must render identically everywhere it's opened. Manual formatting
 * keeps it locale-independent and unit-testable.
 */
export function formatFecha(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CSV_BOM = "﻿";
const CRLF = "\r\n";

const CSV_HEADERS = [
  "Fecha", "Red", "Cuenta", "Entidad", "Acción",
  "Antes → Después", "Actor", "Estado", "Verificada", "Por qué", "Reversión",
] as const;

/**
 * RFC-4180 field quoting: wrap in double quotes (doubling any internal
 * double quote) when the value contains a comma, a double quote, or a line
 * break (CR or LF). Untouched otherwise.
 */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * PURE serializer (design spec §e): rows -> a UTF-8-BOM-prefixed, RFC-4180,
 * CRLF-terminated CSV string (Excel/es-MX friendly). "Verificada" reads
 * actionStatus==="verified" (already computed server-side by the lazy
 * verification sweep — verify.ts); "Por qué" is cc_actions.rationale;
 * "Reversión" is the execution's rollback recipe note.
 */
export function executionsToCsv(rows: ExecutionDto[]): string {
  const lines: string[] = [CSV_HEADERS.map(csvField).join(",")];
  for (const r of rows) {
    const fields = [
      formatFecha(r.createdAt),
      NETWORK_LABEL_ES[r.network] ?? r.network,
      r.accountRef,
      r.entityName,
      ACTION_TYPE_LABEL_ES[r.actionType] ?? r.actionType,
      formatBeforeAfter(r.before, r.after),
      r.actor,
      r.status,
      r.actionStatus === "verified" ? "Sí" : "",
      r.rationale ?? "",
      r.rollbackNote ?? "",
    ];
    lines.push(fields.map(csvField).join(","));
  }
  return CSV_BOM + lines.join(CRLF) + CRLF;
}
