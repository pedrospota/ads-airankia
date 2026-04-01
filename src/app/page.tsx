"use client";

import Link from "next/link";
import Image from "next/image";
import { useTheme } from "@/components/theme-provider";

export default function Home() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4">
      <button
        onClick={toggleTheme}
        className="absolute top-6 right-6 p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        aria-label="Toggle theme"
      >
        {theme === "dark" ? (
          <svg className="w-5 h-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
        ) : (
          <svg className="w-5 h-5 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
        )}
      </button>

      <div className="max-w-2xl text-center space-y-8">
        <div className="space-y-4">
          <Image
            src={theme === "dark" ? "/airankia-logo-light.png" : "/airankia-logo.png"}
            alt="AI Rankia"
            width={180}
            height={48}
            className="h-10 w-auto mx-auto"
          />
          <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
            ADS PLATFORM
          </div>
          <h1 className="text-5xl font-bold tracking-tight">
            Citation Retargeting
          </h1>
          <p className="text-xl text-zinc-500 dark:text-zinc-400 mt-4 leading-relaxed">
            Run display ads on the exact URLs that AI models cite. When ChatGPT,
            Gemini, or Perplexity sends users to a source \u2014 your ad is already
            there.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-6 text-center">
          <div className="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
            <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">12%</p>
            <p className="text-sm text-zinc-500 mt-1">of AI users click citations</p>
          </div>
          <div className="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
            <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">$10</p>
            <p className="text-sm text-zinc-500 mt-1">minimum daily budget</p>
          </div>
          <div className="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
            <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">50+</p>
            <p className="text-sm text-zinc-500 mt-1">targetable citation URLs</p>
          </div>
        </div>

        <Link
          href="/login"
          className="inline-flex items-center px-8 py-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold transition-colors"
        >
          Get Started
        </Link>
      </div>
    </div>
  );
}
