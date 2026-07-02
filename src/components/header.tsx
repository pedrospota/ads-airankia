"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTheme } from "./theme-provider";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

/**
 * Slim 56px utility bar: breadcrumbs on the left, page action + theme toggle
 * + user menu on the right. Branding lives in the global sidebar (AppShell),
 * so this bar stays quiet.
 */
export function Header({
  breadcrumbs,
  action,
}: {
  breadcrumbs?: { label: string; href?: string }[];
  action?: React.ReactNode;
}) {
  const { theme, toggleTheme, colors } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const crumbSeparator = theme === "dark" ? "#2A2A2E" : "#D4D4D8";
  // The model/LLM settings page lives at /admin. We always show the link so it's
  // easy to find; the page itself is admin-gated server-side, so a non-admin who
  // clicks it just gets a friendly "not an admin" notice (no settings leaked).

  useEffect(() => {
    if (!menuOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  async function handleLogout() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  const iconButtonStyle: React.CSSProperties = {
    padding: 6,
    borderRadius: 8,
    background: "transparent",
    border: `1px solid ${colors.border}`,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const menuItemStyle: React.CSSProperties = {
    width: "100%",
    padding: "9px 12px",
    borderRadius: 6,
    background: "transparent",
    cursor: "pointer",
    fontSize: 13,
    color: colors.text,
    textAlign: "left",
    display: "flex",
    alignItems: "center",
    gap: 8,
    textDecoration: "none",
  };

  return (
    <header
      style={{
        height: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        borderBottom: `1px solid ${colors.border}`,
        marginBottom: 24,
      }}
    >
      {/* Breadcrumbs */}
      <nav
        aria-label="Breadcrumb"
        style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
      >
        {breadcrumbs?.map((crumb, i) => (
          <span
            key={i}
            style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
          >
            {i > 0 && (
              <span aria-hidden="true" style={{ color: crumbSeparator, fontSize: 13 }}>
                /
              </span>
            )}
            {crumb.href ? (
              <Link
                href={crumb.href}
                style={{
                  color: colors.textMuted,
                  fontSize: 13,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                style={{
                  color: colors.text,
                  fontSize: 13,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {action}
        <button
          onClick={toggleTheme}
          style={iconButtonStyle}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={colors.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={colors.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          )}
        </button>

        {/* User menu */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Open user menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            style={iconButtonStyle}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={colors.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
            </svg>
          </button>
          {menuOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setMenuOpen(false)} />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: "100%",
                  marginTop: 8,
                  zIndex: 50,
                  background: colors.bgCard,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 10,
                  padding: 4,
                  minWidth: 180,
                }}
              >
                <Link
                  href="/spy"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  style={menuItemStyle}
                  onMouseEnter={(e) => (e.currentTarget.style.background = colors.surface2)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  Ad Spy
                </Link>
                <Link
                  href="/admin"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  style={menuItemStyle}
                  onMouseEnter={(e) => (e.currentTarget.style.background = colors.surface2)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                  </svg>
                  Admin settings
                </Link>
                <button
                  onClick={handleLogout}
                  role="menuitem"
                  style={{ ...menuItemStyle, border: "none", color: colors.danger }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(239,68,68,0.08)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                  </svg>
                  Log out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
