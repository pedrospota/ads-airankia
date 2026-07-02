"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "./theme-provider";

export interface SectionNavItem {
  href: string;
  label: string;
}

/**
 * Horizontal sub-navigation bar (pill links) used by section layouts
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
        className="max-w-6xl mx-auto px-6 flex items-center gap-2 overflow-x-auto"
        style={{ paddingTop: 10, paddingBottom: 10 }}
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
                padding: "5px 12px",
                borderRadius: 999,
                textDecoration: "none",
                color: active ? "#10b981" : colors.textMuted,
                background: active ? "rgba(16,185,129,0.12)" : "transparent",
                border: active
                  ? "1px solid rgba(16,185,129,0.3)"
                  : "1px solid transparent",
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
