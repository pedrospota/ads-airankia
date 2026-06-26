"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type AppMode = "clasico" | "nuevo";

interface ModeContextValue {
  mode: AppMode;
  setMode: (m: AppMode) => void;
  toggleMode: () => void;
}

const ModeContext = createContext<ModeContextValue | undefined>(undefined);

const STORAGE_KEY = "ads-mode";

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<AppMode>("nuevo");

  // Hydrate from localStorage after mount (mirrors ThemeProvider).
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "clasico" || stored === "nuevo") {
      setModeState(stored);
    }
  }, []);

  const setMode = (m: AppMode) => {
    setModeState(m);
    localStorage.setItem(STORAGE_KEY, m);
  };

  const toggleMode = () => {
    setMode(mode === "clasico" ? "nuevo" : "clasico");
  };

  return (
    <ModeContext.Provider value={{ mode, setMode, toggleMode }}>
      {children}
    </ModeContext.Provider>
  );
}

export function useMode() {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error("useMode must be used within ModeProvider");
  return ctx;
}
