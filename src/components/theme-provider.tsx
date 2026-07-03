"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  colors: {
    bg: string;
    bgCard: string;
    bgInput: string;
    border: string;
    /** Emphasized hairline (hover borders, ornaments). */
    borderStrong: string;
    text: string;
    textMuted: string;
    textFaint: string;
    accent: string;
    /** Accent wash for active/selected fills. */
    accentSoft: string;
    /** Second-level surface: active nav items, inset wells. */
    surface2: string;
    /** Table-row / list hover background. */
    hover: string;
    danger: string;
    warn: string;
  };
}

// Luxury-refined dark palette (mirrors src/components/ui-kit.tsx UI tokens).
const DARK = {
  bg: '#09090B',
  bgCard: '#0E0E11',
  bgInput: '#09090B',
  border: 'rgba(255,255,255,0.07)',
  borderStrong: 'rgba(255,255,255,0.12)',
  text: '#F5F6F7',
  textMuted: '#9A9FA8',
  textFaint: '#5B5E66',
  accent: '#10B981',
  accentSoft: 'rgba(16,185,129,0.12)',
  surface2: '#131316',
  hover: '#101014',
  danger: '#EF4444',
  warn: '#F59E0B',
};

const LIGHT = {
  bg: '#FCFCFC',
  bgCard: '#FFFFFF',
  bgInput: '#FFFFFF',
  border: 'rgba(0,0,0,0.08)',
  borderStrong: 'rgba(0,0,0,0.14)',
  text: '#101012',
  textMuted: '#6B7076',
  textFaint: '#A5A7AD',
  accent: '#059669',
  accentSoft: 'rgba(5,150,105,0.10)',
  surface2: '#F2F2F3',
  hover: '#F6F6F7',
  danger: '#DC2626',
  warn: '#D97706',
};

const ThemeContext = createContext<ThemeContextType>({
  theme: "dark",
  toggleTheme: () => {},
  colors: DARK,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = localStorage.getItem("ads-theme") as Theme | null;
    if (stored) setTheme(stored);
  }, []);

  useEffect(() => {
    document.body.style.background = theme === "dark" ? DARK.bg : LIGHT.bg;
    document.body.style.color = theme === "dark" ? DARK.text : LIGHT.text;
    // Keep the html theme class in sync so globals.css scoping
    // (.light scrollbars, .light .uik-btn-* hovers) follows the toggle.
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.classList.toggle("light", theme !== "dark");
    localStorage.setItem("ads-theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  const colors = theme === "dark" ? DARK : LIGHT;

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, colors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
