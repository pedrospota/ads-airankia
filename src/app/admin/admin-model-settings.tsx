"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ----------------------------------------------------------------------------
// Types (mirror the admin API responses)
// ----------------------------------------------------------------------------

interface ORModel {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  created: number | null;
  supportsTools: boolean;
  description: string | null;
}

type Provider = "anthropic" | "openrouter";

interface SettingsResp {
  provider: Provider;
  defaultModel: string | null;
  perAgent: Record<string, string>;
  openrouterKeySet: boolean;
  openrouterKeyFromEnv: boolean;
}

// ----------------------------------------------------------------------------
// Agents that use an LLM (the Activator is code-only, so it's not listed).
// ----------------------------------------------------------------------------

const AGENTS: { id: string; label: string; hint: string }[] = [
  { id: "planner", label: "Strategist", hint: "Plans objective, area and budget" },
  { id: "keyword_researcher", label: "Keyword researcher", hint: "Finds and filters keywords" },
  { id: "structure_architect", label: "Structure architect", hint: "Builds the groups and the bidding strategy" },
  { id: "rsa_copywriter", label: "Ad copywriter", hint: "Writes headlines and descriptions" },
  { id: "policy_qa", label: "Quality reviewer", hint: "Checks policies and errors before activating" },
];

const QUICK_FILTERS = ["glm", "kimi", "gemini", "gpt", "claude", "deepseek", "qwen", "grok"];

// ----------------------------------------------------------------------------
// Styles (match the app's dark theme)
// ----------------------------------------------------------------------------

const card: React.CSSProperties = {
  padding: 20,
  borderRadius: 12,
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  marginBottom: 16,
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "#FAFAFA",
  fontSize: 14,
};
const chipStyle = (active: boolean): React.CSSProperties => ({
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 12,
  cursor: "pointer",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  background: active ? "#6366F1" : "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: active ? "#fff" : "#FAFAFA",
});

function priceShort(m: ORModel): string {
  if (m.promptPrice === 0 && m.completionPrice === 0) return "free";
  if (m.promptPrice == null || m.completionPrice == null) return "";
  const inM = (m.promptPrice * 1_000_000).toFixed(2);
  const outM = (m.completionPrice * 1_000_000).toFixed(2);
  return `$${inM}/$${outM} per 1M`;
}

function optionLabel(m: ORModel): string {
  const p = priceShort(m);
  return `${m.name}${m.supportsTools ? " 🔧" : ""}${p ? ` · ${p}` : ""}`;
}

// ----------------------------------------------------------------------------
// Reusable model picker (search box + native select)
// ----------------------------------------------------------------------------

function ModelSelect({
  value,
  onChange,
  models,
  showChips = false,
  allowNone = false,
  noneLabel = "(use the default model)",
}: {
  value: string;
  onChange: (v: string) => void;
  models: ORModel[];
  showChips?: boolean;
  allowNone?: boolean;
  noneLabel?: string;
}) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    let list = models;
    if (t) {
      list = models.filter(
        (m) => m.id.toLowerCase().includes(t) || m.name.toLowerCase().includes(t)
      );
    }
    return list.slice(0, 300);
  }, [q, models]);

  const selectedKnown = value && models.some((m) => m.id === value);

  return (
    <div>
      <input
        style={{ ...inputStyle, marginBottom: 8 }}
        placeholder="Search model (e.g. glm, kimi, gemini)…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {showChips && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {QUICK_FILTERS.map((f) => (
            <span
              key={f}
              style={chipStyle(q.toLowerCase() === f)}
              onClick={() => setQ(q.toLowerCase() === f ? "" : f)}
            >
              {f}
            </span>
          ))}
        </div>
      )}
      <select
        style={inputStyle}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {allowNone && <option value="">{noneLabel}</option>}
        {value && !selectedKnown && (
          <option value={value}>{value} (not in the list)</option>
        )}
        {filtered.map((m) => (
          <option key={m.id} value={m.id}>
            {optionLabel(m)}
          </option>
        ))}
      </select>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Main panel
// ----------------------------------------------------------------------------

export function AdminModelSettings() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState<Provider>("anthropic");
  const [defaultModel, setDefaultModel] = useState("");
  const [perAgent, setPerAgent] = useState<Record<string, string>>({});
  const [keyInput, setKeyInput] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [keyFromEnv, setKeyFromEnv] = useState(false);

  const [models, setModels] = useState<ORModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Track in-flight requests so we can cancel on unmount / refetch.
  const settingsAbort = useRef<AbortController | null>(null);
  const modelsAbort = useRef<AbortController | null>(null);
  const saveAbort = useRef<AbortController | null>(null);

  // ---- load settings -------------------------------------------------------
  const loadSettings = useCallback(async () => {
    settingsAbort.current?.abort();
    const ac = new AbortController();
    settingsAbort.current = ac;
    try {
      const res = await fetch("/api/admin/settings", { signal: ac.signal });
      if (!res.ok) throw new Error(`Could not load settings (${res.status})`);
      const data = (await res.json()) as SettingsResp;
      setProvider(data.provider);
      setDefaultModel(data.defaultModel ?? "");
      setPerAgent(data.perAgent ?? {});
      setKeySet(data.openrouterKeySet);
      setKeyFromEnv(data.openrouterKeyFromEnv);
      setError(null);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Error loading settings");
    } finally {
      if (settingsAbort.current === ac) setLoading(false);
    }
  }, []);

  // ---- load models ---------------------------------------------------------
  const loadModels = useCallback(async () => {
    modelsAbort.current?.abort();
    const ac = new AbortController();
    modelsAbort.current = ac;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const res = await fetch("/api/admin/models", { signal: ac.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setModels((data.models ?? []) as ORModel[]);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setModelsError(
        e instanceof Error ? e.message : "Could not load the model list"
      );
    } finally {
      if (modelsAbort.current === ac) setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
    loadModels();
    // Cancel everything on unmount.
    return () => {
      settingsAbort.current?.abort();
      modelsAbort.current?.abort();
      saveAbort.current?.abort();
    };
  }, [loadSettings, loadModels]);

  // ---- save ----------------------------------------------------------------
  const save = useCallback(async () => {
    saveAbort.current?.abort();
    const ac = new AbortController();
    saveAbort.current = ac;
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: Record<string, unknown> = {
        provider,
        defaultModel: provider === "openrouter" ? defaultModel || null : null,
        perAgent,
      };
      if (keyInput.trim()) body.openrouterApiKey = keyInput.trim();

      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setKeyInput("");
      setKeySet(data.openrouterKeySet);
      setKeyFromEnv(data.openrouterKeyFromEnv);
      setSaveMsg("Saved ✓");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setSaveMsg(e instanceof Error ? e.message : "Could not save");
    } finally {
      if (saveAbort.current === ac) setSaving(false);
    }
  }, [provider, defaultModel, perAgent, keyInput]);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === defaultModel) ?? null,
    [models, defaultModel]
  );

  if (loading) {
    return <div style={{ opacity: 0.5 }}>Loading settings…</div>;
  }

  return (
    <div>
      {error && (
        <div
          style={{
            ...card,
            background: "rgba(248,113,113,0.1)",
            border: "1px solid rgba(248,113,113,0.2)",
            color: "#F87171",
          }}
        >
          {error}
        </div>
      )}

      {/* PROVIDER -------------------------------------------------------- */}
      <div style={card}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
          Which brain do we use?
        </h2>
        <p style={{ opacity: 0.5, fontSize: 13, marginBottom: 14 }}>
          Claude direct is the most stable. OpenRouter lets you choose between
          hundreds of models (GLM, Kimi, Gemini, GPT…).
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => setProvider("anthropic")}
            style={{
              ...inputStyle,
              width: "auto",
              flex: 1,
              cursor: "pointer",
              fontWeight: 600,
              background:
                provider === "anthropic" ? "#6366F1" : "rgba(255,255,255,0.04)",
              borderColor:
                provider === "anthropic" ? "#6366F1" : "rgba(255,255,255,0.12)",
            }}
          >
            Claude (direct)
          </button>
          <button
            onClick={() => setProvider("openrouter")}
            style={{
              ...inputStyle,
              width: "auto",
              flex: 1,
              cursor: "pointer",
              fontWeight: 600,
              background:
                provider === "openrouter" ? "#6366F1" : "rgba(255,255,255,0.04)",
              borderColor:
                provider === "openrouter" ? "#6366F1" : "rgba(255,255,255,0.12)",
            }}
          >
            OpenRouter (many models)
          </button>
        </div>
      </div>

      {/* OPENROUTER ------------------------------------------------------ */}
      {provider === "openrouter" && (
        <>
          {/* KEY */}
          <div style={card}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
              OpenRouter key
            </h2>
            <p style={{ opacity: 0.5, fontSize: 13, marginBottom: 12 }}>
              {keyFromEnv
                ? "There is a key set on the server (it can't be changed from here)."
                : keySet
                ? "There is a saved key. Type a new one only if you want to change it."
                : "There is no key yet. Paste it so the agents can work."}
            </p>
            <input
              style={inputStyle}
              type="password"
              placeholder={
                keySet ? "•••••••••••••••• (already set)" : "sk-or-v1-…"
              }
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              disabled={keyFromEnv}
              autoComplete="off"
            />
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <span
                style={{
                  color: keySet ? "#4ADE80" : "#FBBF24",
                }}
              >
                {keySet ? "● Key set" : "● No key"}
              </span>
            </div>
          </div>

          {/* DEFAULT MODEL */}
          <div style={card}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
              Default model
            </h2>
            <p style={{ opacity: 0.5, fontSize: 13, marginBottom: 12 }}>
              All the agents use it unless you set a different one below. The
              🔧 icon means the model supports tools (recommended).
            </p>

            {modelsLoading && (
              <div style={{ opacity: 0.5, fontSize: 13, marginBottom: 8 }}>
                Loading OpenRouter models…
              </div>
            )}
            {modelsError && (
              <div style={{ color: "#F87171", fontSize: 13, marginBottom: 8 }}>
                {modelsError}{" "}
                <button
                  onClick={loadModels}
                  style={{ textDecoration: "underline", cursor: "pointer" }}
                >
                  retry
                </button>
              </div>
            )}

            <ModelSelect
              value={defaultModel}
              onChange={setDefaultModel}
              models={models}
              showChips
            />

            {selectedModel && !selectedModel.supportsTools && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 12,
                  color: "#FBBF24",
                  background: "rgba(251,191,36,0.08)",
                  border: "1px solid rgba(251,191,36,0.2)",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}
              >
                Warning: this model doesn't mark “tools” support. We'll try
                other ways to get the answer, but it may fail. Better choose
                one with 🔧.
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.45 }}>
              {models.length > 0
                ? `${models.length} models available · sorted from newest to oldest`
                : ""}
            </div>
          </div>

          {/* ADVANCED PER-AGENT */}
          <div style={card}>
            <button
              onClick={() => setShowAdvanced((s) => !s)}
              style={{
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                color: "#A5B4FC",
              }}
            >
              {showAdvanced ? "▾" : "▸"} Advanced: one model per agent
            </button>
            {showAdvanced && (
              <div style={{ marginTop: 14, display: "grid", gap: 16 }}>
                <p style={{ opacity: 0.5, fontSize: 13 }}>
                  Optional. Leave “default” so it uses the model above.
                </p>
                {AGENTS.map((a) => (
                  <div key={a.id}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{a.label}</div>
                    <div style={{ fontSize: 12, opacity: 0.45, marginBottom: 6 }}>
                      {a.hint}
                    </div>
                    <ModelSelect
                      value={perAgent[a.id] ?? ""}
                      onChange={(v) =>
                        setPerAgent((prev) => {
                          const next = { ...prev };
                          if (v) next[a.id] = v;
                          else delete next[a.id];
                          return next;
                        })
                      }
                      models={models}
                      allowNone
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {provider === "anthropic" && (
        <div style={card}>
          <p style={{ opacity: 0.6, fontSize: 13 }}>
            Using Claude direct: Opus for the agents that “think” (strategy,
            structure, quality) and Sonnet for the high-volume ones (keywords,
            copywriting). There's nothing else to set up.
          </p>
        </div>
      )}

      {/* SAVE ------------------------------------------------------------ */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 8 }}>
        <button
          onClick={save}
          disabled={saving}
          style={{
            padding: "12px 28px",
            borderRadius: 10,
            background: saving ? "rgba(99,102,241,0.5)" : "#6366F1",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            cursor: saving ? "default" : "pointer",
            border: "none",
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saveMsg && (
          <span
            style={{
              fontSize: 14,
              color: saveMsg.includes("✓") ? "#4ADE80" : "#F87171",
            }}
          >
            {saveMsg}
          </span>
        )}
      </div>
    </div>
  );
}
