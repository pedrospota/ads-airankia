"use client";

import { useState } from "react";
import { Card, SectionLabel, Badge, PrimaryButton, GhostDangerButton, UI } from "@/components/ui-kit";
import type { CcSettingsValues } from "@/lib/command/types";

export default function ResumenClient({
  workspaceId,
  initialSettings,
}: {
  workspaceId: string;
  initialSettings: CcSettingsValues;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/command/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSettings(data.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error guardando ajustes");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ marginTop: 16 }}>
      <SectionLabel>Guardarraíles</SectionLabel>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <Badge tone={settings.executionsPaused ? "danger" : "ok"} dot>
          {settings.executionsPaused ? "Ejecuciones PAUSADAS (kill switch)" : "Ejecuciones habilitadas"}
        </Badge>
        {settings.executionsPaused ? (
          <PrimaryButton disabled={busy} onClick={() => save({ executions_paused: false })}>
            Reanudar ejecuciones
          </PrimaryButton>
        ) : (
          <GhostDangerButton disabled={busy} onClick={() => save({ executions_paused: true })}>
            Pausar todo (kill switch)
          </GhostDangerButton>
        )}
        <span style={{ color: UI.muted, fontSize: 13 }}>
          Δ presupuesto máx {settings.maxBudgetDeltaPct}% · {settings.maxActionsPerAccountDay} acciones/cuenta/día
        </span>
      </div>
      {error ? <p style={{ color: UI.danger, marginTop: 8 }}>{error}</p> : null}
    </Card>
  );
}
