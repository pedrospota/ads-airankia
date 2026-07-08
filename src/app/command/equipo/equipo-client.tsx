"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  Card,
  SectionLabel,
  Badge,
  DataTable,
  THead,
  Row,
  Cell,
  EmptyState,
  ErrorCard,
  PrimaryButton,
  GhostDangerButton,
  UI,
} from "@/components/ui-kit";

interface Member {
  userId: string;
  email: string | null;
  role: string;
  invitedBy: string | null;
}

const inputStyle = {
  background: UI.surface2,
  border: `1px solid ${UI.border}`,
  borderRadius: 8,
  color: UI.text,
  padding: "8px 10px",
  fontSize: 13,
} as const;

export default function EquipoClient({ workspaceIds }: { workspaceIds: string[] }) {
  const [workspaceId, setWorkspaceId] = useState(workspaceIds[0] ?? "");
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // First click on "Quitar" arms the confirmation for that row; second click DELETEs.
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

  async function loadMembers(id: string) {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/command/equipo?workspaceId=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMembers(data.members ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error cargando el equipo");
      setMembers(null);
    } finally {
      setLoading(false);
    }
  }

  // On mount + workspace change: reset any armed confirmation and refetch.
  useEffect(() => {
    setConfirmTarget(null);
    void loadMembers(workspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !workspaceId || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/command/equipo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNotice(
        data.invited
          ? `Invitación enviada a ${trimmed}.`
          : `${trimmed} ya tenía cuenta — agregado al workspace.`
      );
      setEmail("");
      await loadMembers(workspaceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error invitando");
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    if (confirmTarget !== userId) {
      setConfirmTarget(userId);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/command/equipo", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, userId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await loadMembers(workspaceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error quitando miembro");
    } finally {
      setConfirmTarget(null);
      setBusy(false);
    }
  }

  if (workspaceIds.length === 0) {
    return (
      <Card>
        <EmptyState title="Sin workspaces" hint="Tu cuenta no pertenece a ningún workspace todavía." />
      </Card>
    );
  }

  return (
    <>
      <Card>
        <SectionLabel>Workspace</SectionLabel>
        <select
          aria-label="Workspace"
          style={inputStyle}
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
        >
          {workspaceIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </Card>

      <Card style={{ marginTop: 16 }}>
        <SectionLabel>Invitar</SectionLabel>
        <form onSubmit={invite} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="email"
            required
            placeholder="correo@equipo.com"
            style={inputStyle}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
          <PrimaryButton type="submit" disabled={busy || !email.trim()}>
            Invitar
          </PrimaryButton>
        </form>
        {notice ? <p style={{ color: UI.accent, marginTop: 10, fontSize: 13 }}>{notice}</p> : null}
      </Card>

      {error ? <ErrorCard message={error} style={{ marginTop: 16 }} /> : null}

      <Card style={{ marginTop: 16 }}>
        <SectionLabel>Miembros</SectionLabel>
        {loading ? (
          <p style={{ color: UI.muted, marginTop: 8 }}>Cargando…</p>
        ) : members && members.length === 0 ? (
          <EmptyState title="Sin miembros en este workspace." />
        ) : members && members.length > 0 ? (
          <DataTable>
            <THead cols={[{ label: "Miembro" }, { label: "Rol" }, { label: "" }]} />
            <tbody>
              {members.map((m) => (
                <Row key={m.userId}>
                  <Cell>{m.email ?? m.userId}</Cell>
                  <Cell>
                    <Badge tone="muted">{m.role}</Badge>
                  </Cell>
                  <Cell align="right">
                    {confirmTarget === m.userId ? (
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                          justifyContent: "flex-end",
                          flexWrap: "wrap",
                        }}
                      >
                        <span style={{ color: UI.danger, fontSize: 12.5 }}>
                          ¿Quitar a {m.email ?? m.userId}? Perderá acceso al Centro de Mando.
                        </span>
                        <GhostDangerButton disabled={busy} onClick={() => remove(m.userId)}>
                          Confirmar
                        </GhostDangerButton>
                        <button
                          type="button"
                          onClick={() => setConfirmTarget(null)}
                          disabled={busy}
                          style={{
                            background: "none",
                            border: "none",
                            color: UI.faint,
                            fontSize: 12.5,
                            cursor: busy ? "not-allowed" : "pointer",
                            textDecoration: "underline",
                            padding: 0,
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <GhostDangerButton disabled={busy} onClick={() => remove(m.userId)}>
                        Quitar
                      </GhostDangerButton>
                    )}
                  </Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        ) : null}
      </Card>

      <Card style={{ marginTop: 16 }}>
        <p style={{ color: UI.muted, fontSize: 13, margin: 0 }}>
          Recuerda: el workspace también debe estar en COMMAND_WORKSPACE_IDS para que sus miembros tengan asiento de
          operador.
        </p>
      </Card>
    </>
  );
}
