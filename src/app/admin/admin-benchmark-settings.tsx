"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface BenchmarkResp {
  liveEnabled: boolean;
  maxCompetitors: number;
  maxAdsPerDomain: number;
  searchApiKeySet: boolean;
  searchApiKeyFromEnv: boolean;
}

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

export function AdminBenchmarkSettings() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [liveEnabled, setLiveEnabled] = useState(false);
  const [maxCompetitors, setMaxCompetitors] = useState(6);
  const [maxAdsPerDomain, setMaxAdsPerDomain] = useState(12);
  const [keyInput, setKeyInput] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [keyFromEnv, setKeyFromEnv] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const loadAbort = useRef<AbortController | null>(null);
  const saveAbort = useRef<AbortController | null>(null);

  const apply = useCallback((d: BenchmarkResp) => {
    setLiveEnabled(d.liveEnabled);
    setMaxCompetitors(d.maxCompetitors);
    setMaxAdsPerDomain(d.maxAdsPerDomain);
    setKeySet(d.searchApiKeySet);
    setKeyFromEnv(d.searchApiKeyFromEnv);
  }, []);

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const ac = new AbortController();
    loadAbort.current = ac;
    try {
      const res = await fetch("/api/admin/benchmark", { signal: ac.signal });
      if (!res.ok) throw new Error(`Could not load benchmark settings (${res.status})`);
      apply((await res.json()) as BenchmarkResp);
      setError(null);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Error loading settings");
    } finally {
      if (loadAbort.current === ac) setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    load();
    return () => {
      loadAbort.current?.abort();
      saveAbort.current?.abort();
    };
  }, [load]);

  const save = useCallback(async () => {
    saveAbort.current?.abort();
    const ac = new AbortController();
    saveAbort.current = ac;
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: Record<string, unknown> = {
        liveEnabled,
        maxCompetitors,
        maxAdsPerDomain,
      };
      if (keyInput.trim()) body.searchApiKey = keyInput.trim();
      const res = await fetch("/api/admin/benchmark", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setKeyInput("");
      apply(data as BenchmarkResp);
      setSaveMsg("Saved ✓");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setSaveMsg(e instanceof Error ? e.message : "Could not save");
    } finally {
      if (saveAbort.current === ac) setSaving(false);
    }
  }, [liveEnabled, maxCompetitors, maxAdsPerDomain, keyInput, apply]);

  if (loading) return <div style={{ opacity: 0.5 }}>Loading benchmark settings…</div>;

  // Ad-spy is only actually live when the gate is on AND a key is present.
  const adSpyLive = liveEnabled && (keySet || keyFromEnv);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Competitor benchmark</h1>
        <p className="mt-2" style={{ opacity: 0.5 }}>
          The free analysis (Keyword Planner volumes, landing-page teardown,
          tracking/UTM detection) always runs. The paid ad-spy below stays off
          until you switch it on and add a key.
        </p>
      </div>

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

      {/* AD-SPY GATE ------------------------------------------------------- */}
      <div style={card}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
          Paid ad-spy (Google Ads Transparency Center)
        </h2>
        <p style={{ opacity: 0.5, fontSize: 13, marginBottom: 14 }}>
          Pulls competitors&apos; running ad creatives via SearchApi. This is the
          only paid part of the suite — leave it off to spend nothing.
        </p>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            cursor: "pointer",
          }}
        >
          <span
            onClick={() => setLiveEnabled((v) => !v)}
            style={{
              width: 46,
              height: 26,
              borderRadius: 999,
              background: liveEnabled ? "#10B981" : "rgba(255,255,255,0.15)",
              position: "relative",
              transition: "background 0.15s",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 3,
                left: liveEnabled ? 23 : 3,
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: "#fff",
                transition: "left 0.15s",
              }}
            />
          </span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {liveEnabled ? "Ad-spy gate ON" : "Ad-spy gate OFF"}
          </span>
        </label>

        <div style={{ marginTop: 14, fontSize: 13 }}>
          <span style={{ color: adSpyLive ? "#4ADE80" : "#FBBF24" }}>
            {adSpyLive
              ? "● Live — runs will pull competitor ads (this spends on SearchApi)."
              : liveEnabled
                ? "● Gate on, but no key yet — still not spending. Add a key below."
                : "● Off — no paid calls are made."}
          </span>
        </div>
      </div>

      {/* SEARCHAPI KEY ----------------------------------------------------- */}
      <div style={card}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
          SearchApi key
        </h2>
        <p style={{ opacity: 0.5, fontSize: 13, marginBottom: 12 }}>
          {keyFromEnv
            ? "A key is set on the server (it can't be changed from here)."
            : keySet
              ? "A key is saved. Type a new one only to replace it."
              : "No key yet. Paste it to enable the paid ad-spy."}
        </p>
        <input
          style={inputStyle}
          type="password"
          placeholder={keySet ? "•••••••••••••••• (already set)" : "SearchApi key…"}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          disabled={keyFromEnv}
          autoComplete="off"
        />
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <span style={{ color: keySet || keyFromEnv ? "#4ADE80" : "#FBBF24" }}>
            {keySet || keyFromEnv ? "● Key set" : "● No key"}
          </span>
        </div>
      </div>

      {/* CAPS -------------------------------------------------------------- */}
      <div style={card}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
          Cost guards
        </h2>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <label style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 6 }}>
              Max competitors per run
            </div>
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={20}
              value={maxCompetitors}
              onChange={(e) =>
                setMaxCompetitors(Math.max(1, Math.min(20, Number(e.target.value) || 1)))
              }
            />
          </label>
          <label style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 6 }}>
              Max ads per domain (when live)
            </div>
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={50}
              value={maxAdsPerDomain}
              onChange={(e) =>
                setMaxAdsPerDomain(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
              }
            />
          </label>
        </div>
      </div>

      {/* SAVE -------------------------------------------------------------- */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 8 }}>
        <button
          onClick={save}
          disabled={saving}
          style={{
            padding: "12px 28px",
            borderRadius: 10,
            background: saving ? "rgba(16,185,129,0.5)" : "#10B981",
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
