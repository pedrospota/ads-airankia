"use client";

import Link from "next/link";
import { useState } from "react";
import { useTheme } from "./theme-provider";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

export function Header({
  breadcrumbs,
  action,
}: {
  breadcrumbs?: { label: string; href?: string }[];
  action?: React.ReactNode;
}) {
  const { theme, toggleTheme, colors } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  async function handleLogout() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <header style={{ borderBottom: `1px solid ${colors.border}`, padding: '16px 24px', background: colors.bg }}>
      <div className="max-w-6xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/brands" className="flex items-center gap-2">
            <img src="/airankia-logo.png" alt="AI Rankia" style={{ height: 28, width: 'auto' }} />
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              background: 'rgba(16,185,129,0.15)', color: colors.accent,
              border: '1px solid rgba(16,185,129,0.3)', letterSpacing: '0.05em',
            }}>
              ADS
            </span>
          </Link>
          {breadcrumbs?.map((crumb, i) => (
            <span key={i} className="flex items-center gap-3">
              <span style={{ color: colors.border }}>/</span>
              {crumb.href ? (
                <Link href={crumb.href} style={{ color: colors.textMuted, fontSize: 13 }}>
                  {crumb.label}
                </Link>
              ) : (
                <span style={{ color: colors.text, fontSize: 13, fontWeight: 500 }}>
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {action}
          <button
            onClick={toggleTheme}
            style={{
              padding: 8, borderRadius: 8, background: 'transparent',
              border: `1px solid ${colors.border}`, cursor: 'pointer', display: 'flex',
            }}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>

          {/* User menu */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              style={{
                padding: 8, borderRadius: 8, background: 'transparent',
                border: `1px solid ${colors.border}`, cursor: 'pointer', display: 'flex',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
            </button>
            {menuOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setMenuOpen(false)} />
                <div style={{
                  position: 'absolute', right: 0, top: '100%', marginTop: 8, zIndex: 50,
                  background: colors.bgCard, border: `1px solid ${colors.border}`,
                  borderRadius: 10, padding: 4, minWidth: 160, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                }}>
                  <button
                    onClick={handleLogout}
                    style={{
                      width: '100%', padding: '10px 14px', borderRadius: 6,
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      fontSize: 13, color: '#F87171', textAlign: 'left',
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(248,113,113,0.1)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                    </svg>
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
