"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "./theme-provider";
import { UI } from "./ui-kit";

export interface SectionNavItem {
  href: string;
  label: string;
}

/**
 * Horizontal sub-navigation bar (quiet underline tabs) used by section layouts
 * (Performance, Seguridad). Active state via longest-prefix match so the
 * section root (e.g. /performance) doesn't stay highlighted on deeper
 * sub-pages, while account pages (/performance/[id]) still highlight it.
 */
export function SectionNav({ items }: { items: SectionNavItem[] }) {
  const pathname = usePathname();
  const { colors } = useTheme();

  let activeHref: string | null = null;
  for (const item of items) {
    const matches =
      pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (matches && (activeHref === null || item.href.length > activeHref.length)) {
      activeHref = item.href;
    }
  }

  return (
    <nav
      aria-label="Navegación de sección"
      style={{ borderBottom: `1px solid ${colors.border}`, background: colors.bg }}
    >
      <div
        className="flex items-center overflow-x-auto"
        style={{
          maxWidth: UI.maxWidth,
          margin: "0 auto",
          padding: "0 32px",
          gap: 20,
        }}
      >
        {items.map((item) => {
          const active = item.href === activeHref;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap"
              aria-current={active ? "page" : undefined}
              style={{
                fontSize: 13,
                fontWeight: 500,
                padding: "11px 2px 9px",
                textDecoration: "none",
                color: active ? colors.text : colors.textMuted,
                borderBottom: active
                  ? `2px solid ${colors.accent}`
                  : "2px solid transparent",
                transition: "color 150ms ease, border-color 150ms ease",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.color = colors.text;
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.color = colors.textMuted;
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
