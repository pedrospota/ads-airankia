"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useTheme } from "./theme-provider";

const SIDEBAR_WIDTH = 220;

/* ---------------------------------------------------------------------------
 * Inline SVG icons (stroke-based, inherit currentColor). Kept tiny on purpose
 * so the sidebar has zero external dependencies.
 * ------------------------------------------------------------------------- */

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    brands: (
      <>
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
        <line x1="7" y1="7" x2="7.01" y2="7" />
      </>
    ),
    cockpit: (
      <>
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </>
    ),
    recomendaciones: (
      <>
        <path d="M9 18h6" />
        <path d="M10 22h4" />
        <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z" />
      </>
    ),
    auditoria: (
      <>
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        <path d="M9 14l2 2 4-4" />
      </>
    ),
    simulacion: (
      <>
        <line x1="4" y1="21" x2="4" y2="14" />
        <line x1="4" y1="10" x2="4" y2="3" />
        <line x1="12" y1="21" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12" y2="3" />
        <line x1="20" y1="21" x2="20" y2="16" />
        <line x1="20" y1="12" x2="20" y2="3" />
        <line x1="1" y1="14" x2="7" y2="14" />
        <line x1="9" y1="8" x2="15" y2="8" />
        <line x1="17" y1="16" x2="23" y2="16" />
      </>
    ),
    backtest: (
      <>
        <polyline points="1 4 1 10 7 10" />
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        <polyline points="12 7 12 12 15 14" />
      </>
    ),
    datalake: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </>
    ),
    costos: (
      <>
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </>
    ),
    salud: (
      <>
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" />
      </>
    ),
    ajustes: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>
    ),
    monitor: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </>
    ),
    equipo: (
      <>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
    spy: (
      <>
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </>
    ),
    conexiones: (
      <>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </>
    ),
    admin: (
      <>
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </>
    ),
  };

  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {paths[name]}
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Navigation model
 * ------------------------------------------------------------------------- */

interface NavItem {
  href: string;
  label: string;
  icon: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Principal",
    items: [{ href: "/brands", label: "Marcas", icon: "brands" }],
  },
  {
    label: "Rendimiento",
    items: [
      { href: "/performance", label: "Cockpit", icon: "cockpit" },
      { href: "/performance/recomendaciones", label: "Recomendaciones", icon: "recomendaciones" },
      { href: "/performance/auditoria", label: "Auditoria MCC", icon: "auditoria" },
      { href: "/performance/simulacion", label: "Simulacion", icon: "simulacion" },
      { href: "/performance/backtest", label: "Backtest", icon: "backtest" },
      { href: "/performance/datalake", label: "Datalake", icon: "datalake" },
      { href: "/performance/costos", label: "Costos", icon: "costos" },
      { href: "/performance/salud", label: "Salud", icon: "salud" },
      { href: "/performance/ajustes", label: "Ajustes", icon: "ajustes" },
    ],
  },
  {
    label: "Seguridad",
    items: [
      { href: "/security", label: "Monitor", icon: "monitor" },
      { href: "/security/equipo", label: "Equipo", icon: "equipo" },
    ],
  },
  {
    label: "Inteligencia",
    items: [{ href: "/spy", label: "Ad Spy", icon: "spy" }],
  },
  {
    label: "Cuenta",
    items: [
      { href: "/conexiones", label: "Conexiones", icon: "conexiones" },
      { href: "/admin", label: "Admin", icon: "admin" },
    ],
  },
];

/**
 * Longest-prefix active match across ALL items so e.g.
 * /performance/recomendaciones highlights "Recomendaciones" and not
 * "Cockpit" (/performance), while /performance/123 still highlights Cockpit.
 */
function findActiveHref(pathname: string): string | null {
  let active: string | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const matches =
        pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (matches && (active === null || item.href.length > active.length)) {
        active = item.href;
      }
    }
  }
  return active;
}

/* ---------------------------------------------------------------------------
 * Sidebar
 * ------------------------------------------------------------------------- */

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { colors } = useTheme();
  const activeHref = findActiveHref(pathname ?? "");
  // Hover = surface (#101012 dark), active = surface2 (#151518 dark).
  const hoverBg = colors.bgCard;
  const activeBg = colors.surface2;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflowY: "auto",
      }}
    >
      {/* Brand row (56px, aligned to the 24px text inset of nav items) */}
      <Link
        href="/brands"
        onClick={onNavigate}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 56,
          flexShrink: 0,
          padding: "0 24px",
          textDecoration: "none",
        }}
      >
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: colors.text,
          }}
        >
          AI Rankia
        </span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            padding: "1px 5px",
            borderRadius: 4,
            background: "rgba(16,185,129,0.12)",
            color: colors.accent,
            border: "1px solid rgba(16,185,129,0.3)",
            letterSpacing: "0.06em",
          }}
        >
          ADS
        </span>
      </Link>

      {/* Groups */}
      <nav
        aria-label="Navegación principal"
        style={{ padding: "0 12px 32px" }}
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label} style={{ marginTop: 24 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: colors.textFaint,
                padding: "0 12px",
                marginBottom: 6,
              }}
            >
              {group.label}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {group.items.map((item) => {
                const active = item.href === activeHref;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    style={{
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "7px 12px",
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: active ? 500 : 450,
                      textDecoration: "none",
                      color: active ? colors.text : colors.textMuted,
                      background: active ? activeBg : "transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (!active) e.currentTarget.style.background = hoverBg;
                    }}
                    onMouseLeave={(e) => {
                      if (!active)
                        e.currentTarget.style.background = "transparent";
                    }}
                  >
                    {active && (
                      <span
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          left: 0,
                          top: 7,
                          bottom: 7,
                          width: 2,
                          borderRadius: 2,
                          background: colors.accent,
                        }}
                      />
                    )}
                    <Icon name={item.icon} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </div>
  );
}

/**
 * Persistent global left sidebar.
 * - Desktop (md+): sticky column, always visible, ~230px wide.
 * - Mobile: hidden by default; a floating toggle opens it as an overlay.
 */
export function AppSidebar() {
  const pathname = usePathname();
  const { colors } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Close on Escape.
  useEffect(() => {
    if (!mobileOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className="hidden md:block"
        style={{
          width: SIDEBAR_WIDTH,
          flexShrink: 0,
          borderRight: `1px solid ${colors.border}`,
          background: colors.bg,
          position: "sticky",
          top: 0,
          height: "100vh",
        }}
      >
        <SidebarContent />
      </aside>

      {/* Mobile toggle */}
      <button
        className="md:hidden"
        onClick={() => setMobileOpen(true)}
        aria-label="Abrir menú de navegación"
        aria-expanded={mobileOpen}
        style={{
          position: "fixed",
          bottom: 16,
          left: 16,
          zIndex: 70,
          width: 44,
          height: 44,
          borderRadius: 999,
          border: `1px solid ${colors.border}`,
          background: colors.bgCard,
          color: colors.text,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* Mobile overlay drawer */}
      {mobileOpen && (
        <div className="md:hidden">
          <div
            onClick={() => setMobileOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 80,
              background: "rgba(0,0,0,0.5)",
            }}
          />
          <aside
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              bottom: 0,
              zIndex: 90,
              width: SIDEBAR_WIDTH,
              borderRight: `1px solid ${colors.border}`,
              background: colors.bg,
            }}
          >
            <button
              onClick={() => setMobileOpen(false)}
              aria-label="Cerrar menú de navegación"
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                padding: 6,
                borderRadius: 8,
                border: `1px solid ${colors.border}`,
                background: "transparent",
                color: colors.textMuted,
                cursor: "pointer",
                display: "flex",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}
