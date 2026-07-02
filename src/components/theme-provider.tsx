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
    text: string;
    textMuted: string;
    textFaint: string;
    accent: string;
    /** Second-level surface: active nav items, inset wells. */
    surface2: string;
    /** Table-row / list hover background. */
    hover: string;
    danger: string;
    warn: string;
  };
}

// Premium dark-first palette (mirrors src/components/ui-kit.tsx UI tokens).
const DARK = {
  bg: '#0A0A0B',
  bgCard: '#101012',
  bgInput: '#0A0A0B',
  border: '#1F1F23',
  text: '#F7F8F8',
  textMuted: '#8A8F98',
  textFaint: '#55575D',
  accent: '#10B981',
  surface2: '#151518',
  hover: '#121214',
  danger: '#EF4444',
  warn: '#F59E0B',
};

const LIGHT = {
  bg: '#FFFFFF',
  bgCard: '#FAFAFA',
  bgInput: '#FFFFFF',
  border: '#E7E7EA',
  text: '#101012',
  textMuted: '#6B7076',
  textFaint: '#A5A7AD',
  accent: '#059669',
  surface2: '#F1F1F3',
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
