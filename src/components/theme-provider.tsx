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
  };
}

const DARK = {
  bg: '#0A0A0E',
  bgCard: '#1C1C23',
  bgInput: '#0A0A0E',
  border: '#38383F',
  text: '#FAFAFA',
  textMuted: 'rgba(255,255,255,0.4)',
  textFaint: 'rgba(255,255,255,0.25)',
  accent: '#10B981',
};

const LIGHT = {
  bg: '#FFFFFF',
  bgCard: '#F9FAFB',
  bgInput: '#FFFFFF',
  border: '#E5E7EB',
  text: '#111827',
  textMuted: '#6B7280',
  textFaint: '#9CA3AF',
  accent: '#059669',
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
