"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// Brand context shared across the Ad Spy area. A single fetch of GET
// /api/spy/brands feeds every tool's prefill (website + competitor domains). The
// selected brand id is persisted in localStorage so it survives navigation
// between the separate spy tools, AND mirrored into the URL (?brand=id) so tools
// can be deep-linked from inside a brand. Selecting "" clears it → manual mode.

export type SpyBrand = {
  id: string;
  name: string;
  website: string | null;
  competitors: string[];
};

const STORAGE_KEY = "spy:selectedBrand";
const URL_PARAM = "brand";
// Backoff between the (up to) 3 fetch attempts. Length = attempts - 1.
const RETRY_DELAYS = [600, 1500];

type SpyBrandValue = {
  brands: SpyBrand[];
  selected: SpyBrand | null;
  setSelected: (id: string | null) => void;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

const SpyBrandContext = createContext<SpyBrandValue>({
  brands: [],
  selected: null,
  setSelected: () => {},
  loading: false,
  error: null,
  reload: () => {},
});

// Resolves after `ms`, or immediately if the request is aborted — so a pending
// backoff never keeps a torn-down provider waiting.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function readUrlBrandId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get(URL_PARAM);
  } catch {
    return null;
  }
}

// Add/replace/remove ?brand=id WITHOUT a full navigation. history.replaceState
// integrates with the Next.js router (per the Native History API docs) so
// usePathname/useSearchParams stay in sync. Other params + hash are preserved.
function syncUrl(id: string | null) {
  try {
    const params = new URLSearchParams(window.location.search);
    if (id) params.set(URL_PARAM, id);
    else params.delete(URL_PARAM);
    const qs = params.toString();
    const next = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState(null, "", next);
  } catch {
    /* history/URL unavailable — selection still lives in state */
  }
}

export function SpyBrandProvider({ children }: { children: React.ReactNode }) {
  const [brands, setBrands] = useState<SpyBrand[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Auto-select from URL/localStorage runs at most once, and never after the
  // user has made a manual choice.
  const initSelectionRef = useRef(false);
  const userTouchedRef = useRef(false);

  const setSelected = useCallback((id: string | null) => {
    userTouchedRef.current = true;
    setSelectedId(id);
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* localStorage unavailable — selection still lives in state */
    }
    syncUrl(id);
  }, []);

  const loadBrands = useCallback(async () => {
    // Cancel any in-flight request (unmount, or a rapid manual retry).
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    let lastError = "Couldn't load brands";

    for (let attempt = 0; attempt < RETRY_DELAYS.length + 1; attempt++) {
      try {
        const resp = await fetch("/api/spy/brands", {
          credentials: "include",
          signal: controller.signal,
        });

        let json: unknown = null;
        try {
          json = await resp.json();
        } catch {
          json = null;
        }

        const obj = (json ?? {}) as { brands?: unknown; error?: unknown };
        const list: SpyBrand[] = Array.isArray(obj.brands)
          ? (obj.brands as SpyBrand[])
          : [];
        const apiError =
          typeof obj.error === "string" && obj.error ? obj.error : null;

        // Success = an ok response that isn't an "empty-with-error" payload. An
        // empty list with NO error is a legitimate "no brands yet" result.
        if (resp.ok && !(list.length === 0 && apiError)) {
          setBrands(list);
          if (!initSelectionRef.current && !userTouchedRef.current && list.length > 0) {
            initSelectionRef.current = true;
            // URL param wins over the stored value.
            const urlId = readUrlBrandId();
            const storedId = (() => {
              try {
                return localStorage.getItem(STORAGE_KEY);
              } catch {
                return null;
              }
            })();
            const pick =
              urlId && list.some((b) => b.id === urlId)
                ? urlId
                : storedId && list.some((b) => b.id === storedId)
                  ? storedId
                  : null;
            if (pick) {
              setSelectedId(pick);
              try {
                localStorage.setItem(STORAGE_KEY, pick);
              } catch {
                /* ignore */
              }
              syncUrl(pick);
            }
          }
          setLoading(false);
          return;
        }

        lastError = apiError ?? `Couldn't load brands (${resp.status})`;
      } catch (err) {
        // Aborted (unmount / superseded retry) is NOT an error.
        if (controller.signal.aborted) return;
        lastError = err instanceof Error && err.message ? err.message : "Network error";
      }

      // Back off before the next attempt (if any remain).
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt], controller.signal);
        if (controller.signal.aborted) return;
      }
    }

    if (!controller.signal.aborted) {
      setError(lastError);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBrands();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [loadBrands]);

  const selected = selectedId
    ? brands.find((b) => b.id === selectedId) ?? null
    : null;

  return (
    <SpyBrandContext.Provider
      value={{ brands, selected, setSelected, loading, error, reload: loadBrands }}
    >
      {children}
    </SpyBrandContext.Provider>
  );
}

export function useSpyBrand(): SpyBrandValue {
  return useContext(SpyBrandContext);
}
