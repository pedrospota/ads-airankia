"use client";

/**
 * csv-button.tsx — <CsvButton path label filename? /> reusable export button.
 *
 * POSTs { path } to /api/performance/engine-csv (the server-side proxy that
 * holds the engine URL + key) and triggers a blob download in the browser.
 * The `path` must be one of the allowlisted engine exports of that route.
 */

import { useState } from "react";
import { SecondaryButton, UI } from "@/components/ui-kit";

export function CsvButton({
  path,
  label,
  filename,
}: {
  /** Allowlisted engine export, e.g. "/export/recommendations.csv". */
  path: string;
  /** Button copy, e.g. "Descargar CSV". */
  label: string;
  /** Download filename; defaults to the last segment of `path`. */
  filename?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/performance/engine-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        let msg = `El servidor respondió ${res.status}.`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) msg = data.error;
        } catch {
          /* cuerpo no-JSON: nos quedamos con el status */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        filename ?? path.split("?")[0]?.split("/").pop() ?? "export.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se pudo descargar el export."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <SecondaryButton onClick={download} disabled={busy} aria-busy={busy}>
        {busy ? "Descargando…" : label}
      </SecondaryButton>
      {error != null && (
        <span
          role="alert"
          title={error}
          style={{ fontSize: 12, color: UI.danger, maxWidth: 240 }}
        >
          {error}
        </span>
      )}
    </span>
  );
}
