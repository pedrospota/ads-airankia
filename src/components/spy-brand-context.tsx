"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// Brand context shared across the Ad Spy area. A single fetch of GET
// /api/spy/brands feeds every tool's prefill (website + competitor domains). The
// selected brand id is persisted in localStorage so it survives navigation
// between the separate spy tools. Selecting "" clears it → manual mode.

export type SpyBrand = {
  id: string;
  name: string;
  website: string | null;
  competitors: string[];
};

const STORAGE_KEY = "spy:selectedBrand";

type SpyBrandValue = {
  brands: SpyBrand[];
  selected: SpyBrand | null;
  setSelected: (id: string | null) => void;
  loading: boolean;
};

const SpyBrandContext = createContext<SpyBrandValue>({
  brands: [],
  selected: null,
  setSelected: () => {},
  loading: false,
});

export function SpyBrandProvider({ children }: { children: React.ReactNode }) {
  const [brands, setBrands] = useState<SpyBrand[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    let storedId: string | null = null;
    try {
      storedId = localStorage.getItem(STORAGE_KEY);
    } catch {
      storedId = null;
    }

    (async () => {
      try {
        const resp = await fetch("/api/spy/brands", {
          credentials: "include",
          signal: controller.signal,
        });
        const json = await resp.json();
        const list: SpyBrand[] = Array.isArray(json?.brands) ? json.brands : [];
        setBrands(list);
        // Restore the stored selection only if it still matches a real brand.
        if (storedId && list.some((b) => b.id === storedId)) {
          setSelectedId(storedId);
        }
      } catch {
        // Aborted on unmount or network failure → tolerate (empty list).
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, []);

  const setSelected = (id: string | null) => {
    setSelectedId(id);
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* localStorage unavailable — selection still lives in state */
    }
  };

  const selected = selectedId
    ? brands.find((b) => b.id === selectedId) ?? null
    : null;

  return (
    <SpyBrandContext.Provider value={{ brands, selected, setSelected, loading }}>
      {children}
    </SpyBrandContext.Provider>
  );
}

export function useSpyBrand(): SpyBrandValue {
  return useContext(SpyBrandContext);
}
