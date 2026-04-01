"use client";

import Link from "next/link";
import Image from "next/image";
import { useTheme } from "./theme-provider";

export function Header({
  breadcrumbs,
  action,
}: {
  breadcrumbs?: { label: string; href?: string }[];
  action?: React.ReactNode;
}) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 bg-white dark:bg-zinc-950">
      <div className="max-w-6xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/brands" className="flex items-center gap-2">
            <Image
              src={
                theme === "dark"
                  ? "/airankia-logo-light.png"
                  : "/airankia-logo.png"
              }
              alt="AI Rankia"
              width={120}
              height={32}
              className="h-7 w-auto"
            />
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
              ADS
            </span>
          </Link>
          {breadcrumbs?.map((crumb, i) => (
            <span key={i} className="flex items-center gap-3">
              <span className="text-zinc-300 dark:text-zinc-600">/</span>
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 text-sm"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-zinc-900 dark:text-white text-sm font-medium">
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <svg
                className="w-5 h-5 text-zinc-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
            ) : (
              <svg
                className="w-5 h-5 text-zinc-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                />
              </svg>
            )}
          </button>
          {action}
        </div>
      </div>
    </header>
  );
}
