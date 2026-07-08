"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, SectionLabel, Badge, PrimaryButton, GhostDangerButton, UI } from "@/components/ui-kit";
import type { CcSettingsValues } from "@/lib/command/types";

export default function ResumenClient({
  workspaceId,
  initialSettings,
}: {
  workspaceId: string;
  initialSettings: CcSettingsValues;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(initialSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy verification sweep (design spec §c): fire-and-forget on mount, then
  // refresh the server data (counts/settings/Novedades) only if the sweep
  // actually changed something. Never surfaces an error to the operator —
  // this is best-effort housekeeping, not a user-initiated action.
  useEffect(() => {
    fetch("/api/command/verify", { method: "POST" })
      .then((r) => r.json())
      .then((res) => {
        if (res.expired || res.verified || res.drifted) router.refresh();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
