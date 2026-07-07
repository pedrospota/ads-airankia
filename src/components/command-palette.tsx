"use client";

/**
 * command-palette.tsx — Cmd/Ctrl+K navigation launcher (Linear/Raycast style).
 *
 * Two exports:
 *   <CommandPalette open onClose />  — the controlled overlay + panel.
 *   <CommandPaletteMount />          — a tiny client island that owns the open
 *                                      state and the global ⌘K keydown listener.
 *
 * app-shell.tsx stays a SERVER component: it just renders <CommandPaletteMount/>,
 * and all client concerns (state, window listeners, router) live here.
 *
 * Palette chrome follows the ui-kit tokens (var(--uik-*)) directly, so it tracks
 * the theme toggle without reading React context. Overlay z-index sits above the
 * mobile sidebar drawer (which tops out at z-index 90).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UI } from "./ui-kit";

/* ---------------------------------------------------------------------------
 * Nav destinations — the searchable index. `section` groups them the way the
 * sidebar does; both label + section feed the substring filter.
 * ------------------------------------------------------------------------- */

interface Destination {
  label: string;
  href: string;
  section: string;
}

const DESTINATIONS: Destination[] = [
  // Rendimiento
  { label: "Cockpit", href: "/performance", section: "Rendimiento" },
  { label: "Recomendaciones", href: "/performance/recomendaciones", section: "Rendimiento" },
  { label: "Diagnostico", href: "/performance/diagnostics", section: "Rendimiento" },
  { label: "Auditoria MCC", href: "/performance/auditoria", section: "Rendimiento" },
  { label: "Simulacion", href: "/performance/simulacion", section: "Rendimiento" },
  { label: "Backtest", href: "/performance/backtest", section: "Rendimiento" },
  { label: "Playbook", href: "/performance/playbook", section: "Rendimiento" },
  { label: "QS", href: "/performance/qs", section: "Rendimiento" },
  { label: "Datalake", href: "/performance/datalake", section: "Rendimiento" },
  { label: "Costos", href: "/performance/costos", section: "Rendimiento" },
  { label: "Salud", href: "/performance/salud", section: "Rendimiento" },
  { label: "Ajustes", href: "/performance/ajustes", section: "Rendimiento" },
  { label: "Introduccion", href: "/performance/introduccion", section: "Rendimiento" },
  // Seguridad
  { label: "Monitor", href: "/security", section: "Seguridad" },
  { label: "Equipo", href: "/security/equipo", section: "Seguridad" },
  { label: "Dominios", href: "/security/dominios", section: "Seguridad" },
  // Principal
  { label: "Marcas", href: "/brands", section: "Principal" },
  // Inteligencia
  { label: "Ad Spy", href: "/spy", section: "Inteligencia" },
  { label: "Copiloto", href: "/copiloto", section: "Inteligencia" },
  { label: "Keywords", href: "/keywords", section: "Inteligencia" },
  // Cuenta
  { label: "Conexiones", href: "/conexiones", section: "Cuenta" },
  { label: "Admin", href: "/admin", section: "Cuenta" },
];

// Centro de Mando (beta): only appended to the searchable index when
// `commandCenter` (threaded from AppShell's flag+admin gate) is true.
const COMMAND_DESTINATIONS: Destination[] = [
  { label: "Centro de Mando · Resumen", href: "/command", section: "Centro de Mando" },
  { label: "Centro de Mando · Constructor", href: "/command/crear", section: "Centro de Mando" },
  { label: "Centro de Mando · Acciones", href: "/command/acciones", section: "Centro de Mando" },
  { label: "Centro de Mando · Cuentas", href: "/command/cuentas", section: "Centro de Mando" },
  { label: "Centro de Mando · Bitácora", href: "/command/bitacora", section: "Centro de Mando" },
];

/** Case-insensitive substring match on label + section. */
function filterDestinations(query: string, destinations: Destination[]): Destination[] {
  const q = query.trim().toLowerCase();
  if (!q) return destinations;
  return destinations.filter((d) =>
    `${d.label} ${d.section}`.toLowerCase().includes(q)
  );
}

/* ---------------------------------------------------------------------------
 * The palette overlay + panel.
 * ------------------------------------------------------------------------- */

export function CommandPalette({
  open,
  onClose,
  commandCenter,
}: {
  open: boolean;
  onClose: () => void;
  commandCenter?: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const destinations = useMemo(
    () => (commandCenter ? [...DESTINATIONS, ...COMMAND_DESTINATIONS] : DESTINATIONS),
    [commandCenter]
  );
  const results = useMemo(
    () => filterDestinations(query, destinations),
    [query, destinations]
  );

  // Reset query + selection and autofocus the input each time we open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // rAF so the input exists and is focusable after the overlay mounts.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Keep the highlighted index in range as the result set shrinks.
  useEffect(() => {
    setActive((a) => (results.length === 0 ? 0 : Math.min(a, results.length - 1)));
  }, [results.length]);

  const go = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (results.length === 0 ? 0 : (a + 1) % results.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) =>
          results.length === 0 ? 0 : (a - 1 + results.length) % results.length
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const dest = results[active];
        if (dest) go(dest.href);
      }
    },
    [results, active, go, onClose]
  );

  // Keep the active row scrolled into view during arrow navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${active}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Navegación rápida"
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "14vh 20px 20px",
      }}
    >
      {/* Backdrop — click to dismiss. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
        }}
      />

      {/* Panel */}
      <div
        className="rise"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 560,
          background: UI.surface,
          border: `1px solid ${UI.border}`,
          borderTopColor: UI.borderTop,
          borderRadius: UI.radius,
          boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        {/* Search input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 16px",
            borderBottom: `1px solid ${UI.border}`,
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke={UI.faint}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Buscar destino…"
            aria-label="Buscar destino"
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: UI.text,
              fontSize: 15,
              fontFamily: "inherit",
              lineHeight: "20px",
              padding: 0,
            }}
          />
        </div>

        {/* Results */}
        <div
          ref={listRef}
          role="listbox"
          aria-label="Destinos"
          style={{ maxHeight: "48vh", overflowY: "auto", padding: 6 }}
        >
          {results.length === 0 ? (
            <div
              style={{
                padding: "28px 16px",
                textAlign: "center",
                color: UI.faint,
                fontSize: 13.5,
              }}
            >
              Sin resultados para{" "}
              <span style={{ color: UI.muted }}>“{query.trim()}”</span>
            </div>
          ) : (
            results.map((d, i) => {
              const selected = i === active;
              return (
                <div
                  key={d.href}
                  data-idx={i}
                  role="option"
                  aria-selected={selected}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(d.href)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "9px 12px",
                    borderRadius: UI.radiusSm,
                    cursor: "pointer",
                    background: selected ? UI.surface2 : "transparent",
                    boxShadow: selected
                      ? `inset 2px 0 0 0 ${UI.accentHairline}`
                      : "inset 2px 0 0 0 transparent",
                  }}
                >
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: selected ? 500 : 450,
                      color: selected ? UI.text : UI.muted,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {d.label}
                  </span>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 500,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: UI.faint,
                      flexShrink: 0,
                    }}
                  >
                    {d.section}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 16px",
            borderTop: `1px solid ${UI.border}`,
            fontSize: 11.5,
            color: UI.faint,
          }}
        >
          <span>↑↓ moverse</span>
          <span aria-hidden="true" style={{ color: UI.border }}>
            ·
          </span>
          <span>↵ abrir</span>
          <span aria-hidden="true" style={{ color: UI.border }}>
            ·
          </span>
          <span>esc cerrar</span>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Mount island — owns open state + the global ⌘K / Ctrl+K listener so the
 * app-shell can stay a server component and just render this.
 * ------------------------------------------------------------------------- */

export function CommandPaletteMount({
  commandCenter,
}: { commandCenter?: boolean } = {}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <CommandPalette
      open={open}
      onClose={() => setOpen(false)}
      commandCenter={commandCenter}
    />
  );
}
