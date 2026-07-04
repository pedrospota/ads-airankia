"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  UI,
  Card,
  StatCard,
  SectionLabel,
  DataTable,
  THead,
  Row,
  Cell,
  Badge,
  EmptyState,
  ErrorCard,
  PrimaryButton,
  SecondaryButton,
} from "@/components/ui-kit";

// ---------------------------------------------------------------------------
// Types — mirror KeywordPlanIdea from @/lib/google-ads (kept local so the
// client never imports server-only modules).
// ---------------------------------------------------------------------------

type Competition = "LOW" | "MEDIUM" | "HIGH" | "UNSPECIFIED" | "UNKNOWN";

interface Idea {
  text: string;
  avgMonthlySearches: number;
  competition: Competition;
  topOfPageBidLowMicros?: number;
  topOfPageBidHighMicros?: number;
}

interface IdeasResponse {
  ideas: Idea[];
  warning?: string;
}

const MAX_SEEDS = 20; // KeywordPlanIdeaService caps keyword seeds at 20

// Markets offered by the tool — a subset of GEO_TARGET_CONSTANTS in
// google-ads.ts (the API route validates against the same list).
const COUNTRIES: { code: string; label: string; lang: "es" | "en" }[] = [
  { code: "MX", label: "México", lang: "es" },
  { code: "ES", label: "España", lang: "es" },
  { code: "US", label: "Estados Unidos", lang: "en" },
  { code: "AR", label: "Argentina", lang: "es" },
  { code: "CO", label: "Colombia", lang: "es" },
  { code: "CL", label: "Chile", lang: "es" },
  { code: "PE", label: "Perú", lang: "es" },
];

const EXAMPLES = [
  "prestamos personales",
  "seguro de coche",
  "hipoteca online",
  "tarjeta de crédito",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Seeds: comma- or newline-separated, trimmed, deduped case-insensitively.
function parseSeeds(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const fmtNum = (n: number) => Math.round(Math.max(0, n)).toLocaleString("es-ES");

// micros (1e6 = one currency unit) → "$1.23". Returns "—" when unknown/zero.
// The planner reports bids in the source's currency (USD on the DataForSEO
// fallback), so we render a plain "$" rather than pretending to know better.
function money(micros: number | undefined): string {
  if (micros == null || micros <= 0) return "—";
  return "$" + (micros / 1_000_000).toFixed(2);
}

// Competition → Badge tone + Spanish label. LOW is good (accent), HIGH is
// costly (danger), MEDIUM is warn; unknown states read as muted.
function competitionBadge(c: Competition): { tone: "ok" | "warn" | "danger" | "muted"; label: string } {
  switch (c) {
    case "LOW":
      return { tone: "ok", label: "Baja" };
    case "MEDIUM":
      return { tone: "warn", label: "Media" };
    case "HIGH":
      return { tone: "danger", label: "Alta" };
    default:
      return { tone: "muted", label: "—" };
  }
}

// Rank for sorting competition low→high; unknowns sort last.
const COMPETITION_RANK: Record<Competition, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  UNSPECIFIED: 3,
  UNKNOWN: 3,
};

type SortKey = "text" | "avgMonthlySearches" | "competition" | "cpc";
type SortDir = "asc" | "desc";

function cpcMid(i: Idea): number {
  const lo = i.topOfPageBidLowMicros ?? 0;
  const hi = i.topOfPageBidHighMicros ?? 0;
  if (lo && hi) return (lo + hi) / 2;
  return hi || lo || 0;
}

// ---------------------------------------------------------------------------

export function KeywordsClient() {
  const [seeds, setSeeds] = useState("");
  const [url, setUrl] = useState("");
  const [country, setCountry] = useState("MX");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("avgMonthlySearches");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const seedList = useMemo(() => parseSeeds(seeds), [seeds]);
  const tooManySeeds = seedList.length > MAX_SEEDS;

  const run = useCallback(async () => {
    const urlValue = url.trim();

    if (seedList.length === 0 && !urlValue) {
      setError("Escribe al menos una palabra clave semilla (separadas por comas o saltos de línea) o una URL.");
      return;
    }
    if (seedList.length > MAX_SEEDS) {
      setError(`Máximo ${MAX_SEEDS} palabras clave semilla — quita ${seedList.length - MAX_SEEDS} para continuar.`);
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    setWarning(null);

    const lang = COUNTRIES.find((c) => c.code === country)?.lang ?? "es";

    try {
      const res = await fetch("/api/keywords/ideas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        signal: ac.signal,
        body: JSON.stringify({
          seeds: seedList.length > 0 ? seedList : undefined,
          url: urlValue || undefined,
          country,
          language: lang,
        }),
      });
      const data = (await res.json()) as IdeasResponse & { error?: string };
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setIdeas(data.ideas ?? []);
      setWarning(data.warning ?? null);
      setSelected(new Set());
      setSortKey("avgMonthlySearches");
      setSortDir("desc");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Algo salió mal. Inténtalo de nuevo.");
    } finally {
      if (abortRef.current === ac) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  }, [seedList, url, country]);

  const prefill = useCallback((example: string) => {
    setSeeds((prev) => {
      const existing = parseSeeds(prev);
      if (existing.some((s) => s.toLowerCase() === example.toLowerCase())) return prev;
      return existing.length > 0 ? `${prev.trimEnd()}\n${example}` : example;
    });
  }, []);

  const toggleSelect = useCallback((text: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(text)) next.delete(text);
      else next.add(text);
      return next;
    });
  }, []);

  const setSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        // Toggle direction on the active column.
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prevKey;
      }
      // New column: text defaults ascending, metrics descending.
      setSortDir(key === "text" ? "asc" : "desc");
      return key;
    });
  }, []);

  const sortedIdeas = useMemo(() => {
    if (!ideas) return [];
    const arr = [...ideas];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "text":
          cmp = a.text.localeCompare(b.text, "es");
          break;
        case "avgMonthlySearches":
          cmp = a.avgMonthlySearches - b.avgMonthlySearches;
          break;
        case "competition":
          cmp = COMPETITION_RANK[a.competition] - COMPETITION_RANK[b.competition];
          break;
        case "cpc":
          cmp = cpcMid(a) - cpcMid(b);
          break;
      }
      return cmp * dir;
    });
    return arr;
  }, [ideas, sortKey, sortDir]);

  // Summary metrics across ALL returned ideas (not just the sorted view).
  const summary = useMemo(() => {
    if (!ideas || ideas.length === 0) return null;
    const totalVolume = ideas.reduce((s, i) => s + Math.max(0, i.avgMonthlySearches), 0);
    const cpcs = ideas.map(cpcMid).filter((v) => v > 0);
    const avgCpcMicros = cpcs.length ? cpcs.reduce((a, b) => a + b, 0) / cpcs.length : 0;
    return { count: ideas.length, totalVolume, avgCpcMicros };
  }, [ideas]);

  const copySelected = useCallback(async () => {
    if (!ideas) return;
    const chosen = ideas.filter((i) => selected.has(i.text)).map((i) => i.text);
    if (chosen.length === 0) return;
    try {
      await navigator.clipboard.writeText(chosen.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be blocked (permissions/insecure context) — stay quiet.
    }
  }, [ideas, selected]);

  const exportCsv = useCallback(() => {
    if (!ideas) return;
    const chosen = ideas.filter((i) => selected.has(i.text));
    if (chosen.length === 0) return;
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const header = ["Keyword", "Busquedas mensuales", "Competencia", "CPC bajo", "CPC alto"];
    const lines = [
      header.map(esc).join(","),
      ...chosen.map((i) =>
        [
          esc(i.text),
          String(Math.round(Math.max(0, i.avgMonthlySearches))),
          esc(competitionBadge(i.competition).label),
          esc(money(i.topOfPageBidLowMicros)),
          esc(money(i.topOfPageBidHighMicros)),
        ].join(",")
      ),
    ];
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `keywords-${country}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(href);
  }, [ideas, selected, country]);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: UI.surface2,
    border: `1px solid ${UI.border}`,
    borderRadius: UI.radiusSm,
    color: UI.text,
    fontSize: 14,
    padding: "10px 12px",
    outline: "none",
    fontFamily: "inherit",
  };

  const selectedCount = selected.size;
  const hasResults = ideas != null;
  const emptyResults = hasResults && ideas.length === 0;

  return (
    <div style={{ paddingBottom: selectedCount > 0 ? 88 : 0 }}>
      {/* ── Search hero ─────────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <SectionLabel style={{ marginBottom: 8 }}>
              Palabras clave semilla (separadas por comas o líneas)
            </SectionLabel>
            <span
              style={{
                fontSize: 11.5,
                fontVariantNumeric: "tabular-nums",
                color: tooManySeeds ? UI.danger : UI.faint,
                whiteSpace: "nowrap",
              }}
            >
              {seedList.length}/{MAX_SEEDS}
            </span>
          </div>
          <textarea
            style={{ ...inputStyle, resize: "vertical", minHeight: 68, lineHeight: 1.5 }}
            rows={3}
            placeholder={"p. ej. prestamos personales, credito rapido\nhipoteca online"}
            value={seeds}
            onChange={(e) => setSeeds(e.target.value)}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && run()}
            aria-label="Palabras clave semilla"
          />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 200px",
            gap: 14,
            alignItems: "end",
          }}
        >
          <div>
            <SectionLabel style={{ marginBottom: 8 }}>URL (opcional — landing o competidor)</SectionLabel>
            <input
              style={inputStyle}
              placeholder="https://ejemplo.com/prestamos"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              aria-label="URL semilla"
            />
          </div>

          <div>
            <SectionLabel style={{ marginBottom: 8 }}>Mercado</SectionLabel>
            <select
              style={{ ...inputStyle, cursor: "pointer" }}
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              aria-label="Mercado"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 18, flexWrap: "wrap" }}>
          <PrimaryButton onClick={run} disabled={loading || tooManySeeds}>
            {loading ? "Buscando…" : "Buscar ideas"}
          </PrimaryButton>

          {/* Example seeds that append to the textarea */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: UI.faint }}>prueba:</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => prefill(ex)}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  fontSize: 12.5,
                  color: UI.accent,
                  fontFamily: "inherit",
                  textDecoration: "underline",
                  textUnderlineOffset: 2,
                  textDecorationColor: UI.accentHairline,
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* ── Error ───────────────────────────────────────────────────────── */}
      {error && <ErrorCard message={error} style={{ marginBottom: 24 }} />}

      {/* ── Loading ─────────────────────────────────────────────────────── */}
      {loading && (
        <Card>
          <EmptyState
            title="Consultando el planner…"
            hint="Estamos pidiendo volúmenes de búsqueda, competencia y CPC reales. Esto tarda unos segundos."
          />
        </Card>
      )}

      {/* ── Warning (planner degraded — results may be fallback/empty) ──── */}
      {!loading && warning && (
        <div
          role="status"
          style={{
            background: `color-mix(in srgb, ${UI.warn} 8%, transparent)`,
            border: `1px solid color-mix(in srgb, ${UI.warn} 32%, transparent)`,
            borderRadius: UI.radius,
            padding: "12px 16px",
            fontSize: 13,
            lineHeight: 1.5,
            color: UI.warn,
            marginBottom: 24,
          }}
        >
          {warning}
        </div>
      )}

      {/* ── Empty result ────────────────────────────────────────────────── */}
      {!loading && emptyResults && (
        <Card>
          <EmptyState
            title="Sin ideas para esa búsqueda."
            hint="Prueba con otras palabras semilla, una URL distinta o cambia el mercado."
          />
        </Card>
      )}

      {/* ── Results ─────────────────────────────────────────────────────── */}
      {!loading && hasResults && ideas.length > 0 && summary && (
        <>
          {/* Summary stat row */}
          <div
            className="grid grid-cols-1 md:grid-cols-3"
            style={{ gap: 16, marginBottom: 24 }}
          >
            <StatCard label="Ideas encontradas" value={fmtNum(summary.count)} />
            <StatCard label="Volumen total / mes" value={fmtNum(summary.totalVolume)} />
            <StatCard label="CPC medio" value={money(summary.avgCpcMicros)} />
          </div>

          {/* Results table */}
          <Card style={{ padding: 0 }}>
            <DataTable>
              <THead
                cols={[
                  { label: <Sortable label="Keyword" active={sortKey === "text"} dir={sortDir} onClick={() => setSort("text")} /> },
                  {
                    label: <Sortable label="Búsquedas/mes" active={sortKey === "avgMonthlySearches"} dir={sortDir} onClick={() => setSort("avgMonthlySearches")} align="right" />,
                    align: "right",
                  },
                  {
                    label: <Sortable label="Competencia" active={sortKey === "competition"} dir={sortDir} onClick={() => setSort("competition")} />,
                  },
                  {
                    label: <Sortable label="CPC (bajo–alto)" active={sortKey === "cpc"} dir={sortDir} onClick={() => setSort("cpc")} align="right" />,
                    align: "right",
                  },
                  { label: "", align: "right", width: 44 },
                ]}
              />
              <tbody>
                {sortedIdeas.map((idea) => {
                  const badge = competitionBadge(idea.competition);
                  const isSelected = selected.has(idea.text);
                  return (
                    <Row key={idea.text}>
                      <Cell>{idea.text}</Cell>
                      <Cell align="right" mono>
                        {fmtNum(idea.avgMonthlySearches)}
                      </Cell>
                      <Cell>
                        <Badge tone={badge.tone} dot>
                          {badge.label}
                        </Badge>
                      </Cell>
                      <Cell align="right" mono>
                        {money(idea.topOfPageBidLowMicros)}
                        <span style={{ color: UI.faint }}> – </span>
                        {money(idea.topOfPageBidHighMicros)}
                      </Cell>
                      <Cell align="right">
                        <button
                          type="button"
                          onClick={() => toggleSelect(idea.text)}
                          aria-label={isSelected ? `Quitar ${idea.text}` : `Añadir ${idea.text}`}
                          aria-pressed={isSelected}
                          title={isSelected ? "Quitar de seleccionadas" : "Añadir a seleccionadas"}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 999,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "pointer",
                            fontSize: 16,
                            lineHeight: 1,
                            fontFamily: UI.fontMono,
                            transition: "background 150ms ease, border-color 150ms ease, color 150ms ease",
                            color: isSelected ? UI.accent : UI.muted,
                            background: isSelected ? UI.accentSoft : "transparent",
                            border: `1px solid ${isSelected ? UI.accentHairline : UI.border}`,
                          }}
                        >
                          {isSelected ? "✓" : "+"}
                        </button>
                      </Cell>
                    </Row>
                  );
                })}
              </tbody>
            </DataTable>
          </Card>
        </>
      )}

      {/* ── First-run empty (no search yet) ─────────────────────────────── */}
      {!loading && !hasResults && !error && (
        <Card>
          <EmptyState
            title="Empieza tu investigación."
            hint="Escribe una o varias palabras clave (o pega una URL) y elige el mercado para descubrir keywords con volumen, competencia y CPC reales."
          />
        </Card>
      )}

      {/* ── Sticky selection footer ─────────────────────────────────────── */}
      {selectedCount > 0 && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 40,
            background: `color-mix(in srgb, ${UI.surface} 92%, transparent)`,
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            borderTop: `1px solid ${UI.border}`,
          }}
        >
          <div
            style={{
              maxWidth: UI.maxWidth,
              margin: "0 auto",
              padding: "14px 32px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13.5, color: UI.text, fontWeight: 550 }}>
                {fmtNum(selectedCount)} {selectedCount === 1 ? "keyword seleccionada" : "keywords seleccionadas"}
              </span>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  fontSize: 12.5,
                  color: UI.faint,
                  fontFamily: "inherit",
                  textDecoration: "underline",
                  textUnderlineOffset: 2,
                }}
              >
                limpiar
              </button>
              <span style={{ fontSize: 12, color: UI.faint }}>
                próximamente: enviar al asistente de campañas
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <SecondaryButton onClick={copySelected}>
                {copied ? "Copiado ✓" : "Copiar"}
              </SecondaryButton>
              <SecondaryButton onClick={exportCsv}>Exportar CSV</SecondaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small local UI bits (no ui-kit equivalent)
// ---------------------------------------------------------------------------

// A sortable column header label: the text + a direction caret when active.
function Sortable({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        font: "inherit",
        letterSpacing: "inherit",
        textTransform: "inherit",
        color: active ? UI.text : "inherit",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        width: align === "right" ? "100%" : "auto",
        justifyContent: align === "right" ? "flex-end" : "flex-start",
      }}
    >
      {label}
      <span aria-hidden="true" style={{ opacity: active ? 1 : 0.25, fontSize: 9 }}>
        {active ? (dir === "asc" ? "▲" : "▼") : "▼"}
      </span>
    </button>
  );
}
