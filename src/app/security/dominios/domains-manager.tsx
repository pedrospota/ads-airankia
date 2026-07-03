"use client";

// Client child of /security/dominios: lists the anti-hijack allowlist and lets
// the user add / remove domains through /api/security/brand-domains (the
// engine key never reaches the browser — the route talks to the engine).

import { useState } from "react";
import {
  Card,
  DataTable,
  THead,
  Row,
  Cell,
  Badge,
  EmptyState,
  ErrorCard,
  PrimaryButton,
  GhostDangerButton,
  UI,
} from "@/components/ui-kit";

/** Shape mirrors the engine's /api/v1/brand-domains rows (all optional). */
export interface DomainRow {
  id?: number | string | null;
  domain?: string | null;
  scope?: string | null;
  added_by?: string | null;
}

/** "https://www.acme.com/landing?x=1" → "www.acme.com" (lowercase, no path). */
function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split("?")[0]
    .split(":")[0];
}

export function DomainsManager({ initialRows }: { initialRows: DomainRow[] }) {
  const [rows, setRows] = useState<DomainRow[]>(initialRows);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/security/brand-domains", { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as {
      rows?: DomainRow[] | null;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    setRows(data.rows ?? []);
  }

  async function mutate(action: "add" | "remove", domain: string, scope?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/security/brand-domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, domain, scope }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      await refresh();
      if (action === "add") setInput("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se pudo actualizar la lista de dominios."
      );
    } finally {
      setBusy(false);
    }
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const domain = normalizeDomain(input);
    if (!domain || busy) return;
    void mutate("add", domain);
  }

  const sorted = [...rows].sort((a, b) =>
    (a.domain ?? "").localeCompare(b.domain ?? "")
  );

  return (
    <div>
      {/* Add form */}
      <form
        onSubmit={handleAdd}
        style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="ej. mimarca.com"
          disabled={busy}
          aria-label="Dominio a agregar"
          style={{
            flex: 1,
            maxWidth: 360,
            padding: "8px 12px",
            fontSize: 13.5,
            color: UI.text,
            background: UI.surface2,
            border: `1px solid ${UI.border}`,
            borderRadius: UI.radiusSm,
            outline: "none",
          }}
        />
        <PrimaryButton type="submit" disabled={busy || !normalizeDomain(input)}>
          {busy ? "Guardando…" : "Agregar"}
        </PrimaryButton>
      </form>

      {error && <ErrorCard message={error} style={{ marginBottom: 16 }} />}

      {sorted.length === 0 ? (
        <Card style={{ padding: 0 }}>
          <EmptyState
            title="La allowlist está vacía."
            hint="Sin dominios legítimos registrados, cualquier cambio de destino de un anuncio se tratará como sospechoso. Agrega los dominios de tus marcas arriba."
          />
        </Card>
      ) : (
        <Card style={{ padding: 0 }}>
          <DataTable>
            <THead
              cols={[
                { label: "Dominio" },
                { label: "Alcance", width: 140 },
                { label: "Agregado por" },
                { label: "", align: "right", width: 90 },
              ]}
            />
            <tbody>
              {sorted.map((r) => {
                const domain = r.domain ?? "";
                const scope = r.scope || "global";
                return (
                  <Row key={r.id ?? `${domain}|${scope}`}>
                    <Cell mono style={{ fontWeight: 500 }}>
                      {domain || "—"}
                    </Cell>
                    <Cell>
                      <Badge tone={scope === "global" ? "muted" : "accent"}>
                        {scope}
                      </Badge>
                    </Cell>
                    <Cell style={{ color: UI.muted }}>{r.added_by || "—"}</Cell>
                    <Cell align="right">
                      <GhostDangerButton
                        disabled={busy || !domain}
                        onClick={() => void mutate("remove", domain, scope)}
                      >
                        Quitar
                      </GhostDangerButton>
                    </Cell>
                  </Row>
                );
              })}
            </tbody>
          </DataTable>
        </Card>
      )}
    </div>
  );
}
