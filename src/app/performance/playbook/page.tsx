import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import {
  fetchPlaybook,
  fmtNum,
  type PlaybookAccount,
  type PlaybookCell,
} from "@/lib/sentinel";
import {
  PageHeader,
  Card,
  SectionLabel,
  DataTable,
  THead,
  Row,
  Cell,
  Badge,
  EmptyState,
  ErrorCard,
  UI,
} from "@/components/ui-kit";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

// Etiquetas de objetivo del motor (dataset/objective.py).
const OBJ_LABEL: Record<string, string> = {
  efficiency_cpa: "CPA",
  value_roas: "ROAS",
  volume_conversions: "Volumen",
  traffic: "Tráfico",
};

function objLabel(obj: string | null | undefined): string {
  if (!obj) return "—";
  return OBJ_LABEL[obj] ?? obj;
}

function famLabel(c: PlaybookCell): string {
  return c.action_family || c.family || "—";
}

/** "62%" desde win_rate 0–1; "—" cuando no hay decisivos. */
function fmtWinRate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

/** "+4.2%" / "-3.1%" para el efecto neto mediano. */
function fmtNet(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v}%`;
}

function netColor(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return UI.faint;
  if (v > 0) return UI.accent;
  if (v < 0) return UI.danger;
  return UI.muted;
}

function CellRows({ cells, showAccounts }: { cells: PlaybookCell[]; showAccounts: boolean }) {
  return (
    <tbody>
      {cells.map((c, i) => (
        <Row key={`${famLabel(c)}-${c.objective ?? i}`}>
          <Cell>
            <Badge tone="muted">{famLabel(c)}</Badge>
          </Cell>
          <Cell style={{ color: UI.muted }}>{objLabel(c.objective)}</Cell>
          <Cell align="right" mono>
            {fmtNum(c.n)}
            {showAccounts && (c.n_accounts ?? 0) > 0 ? (
              <span style={{ color: UI.faint, fontSize: 11 }}>
                {" "}· {fmtNum(c.n_accounts)} ctas
              </span>
            ) : null}
          </Cell>
          <Cell align="right" mono>
            {fmtWinRate(c.win_rate)}
            <span style={{ color: UI.faint, fontSize: 11 }}>
              {" "}({fmtNum(c.n_decisive)} dec)
            </span>
          </Cell>
          <Cell align="right" mono style={{ color: netColor(c.median_net), fontWeight: 600 }}>
            {fmtNet(c.median_net)}
          </Cell>
        </Row>
      ))}
    </tbody>
  );
}

const PLAYBOOK_COLS = [
  { label: "Familia" },
  { label: "Objetivo", width: 110 },
  { label: "N", align: "right" as const, width: 120 },
  { label: "Win-rate", align: "right" as const, width: 130 },
  { label: "Efecto neto", align: "right" as const, width: 120 },
];

export default async function PlaybookPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let globalCells: PlaybookCell[] = [];
  let byAccount: PlaybookAccount[] = [];
  let error: string | null = null;

  try {
    const data = await fetchPlaybook();
    globalCells = data.global ?? [];
    byAccount = data.by_account ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar el playbook.";
  }

  const totalDecisive = globalCells.reduce((s, c) => s + (c.n_decisive ?? 0), 0);
  const thin = totalDecisive > 0 && totalDecisive < 10;

  // Por cuenta: solo cuentas con evidencia; top de cada una, compacto.
  const accounts = byAccount
    .map((a) => ({
      ...a,
      cells: (a.cells ?? []).filter((c) => (c.n ?? 0) >= 1),
    }))
    .filter((a) => a.cells.length > 0)
    .slice(0, 8);

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Playbook" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Qué funciona (medido)"
          subtitle="Win-rate y efecto neto por familia de acción × objetivo, destilado de episodios de-confundidos (neto de la tendencia de cada cuenta). Para aprender — no es un ranking ni ejecuta nada."
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar el playbook. ${error}`} />
        ) : globalCells.length === 0 || totalDecisive === 0 ? (
          <Card style={{ padding: 0 }}>
            <EmptyState
              title="El playbook todavía está delgado."
              hint="Aún no hay episodios decisivos medidos. Conforme el datalake de decisiones madure (cada acción necesita su ventana post + control), aquí aparecerá qué familias de acción funcionan por objetivo."
            />
          </Card>
        ) : (
          <>
            {thin && (
              <Card
                style={{
                  marginBottom: 24,
                  padding: "12px 18px",
                  borderColor: `${UI.warn}4D`,
                }}
              >
                <span style={{ fontSize: 13, color: UI.warn }}>
                  Señal direccional — solo {fmtNum(totalDecisive)} episodios decisivos
                  en total. Úsalo como brújula, no como veredicto.
                </span>
              </Card>
            )}

            <SectionLabel>Patrón global (todas las cuentas)</SectionLabel>
            <Card style={{ padding: 0, marginBottom: 40 }}>
              <DataTable>
                <THead cols={PLAYBOOK_COLS} />
                <CellRows cells={globalCells} showAccounts />
              </DataTable>
            </Card>

            {accounts.length > 0 && (
              <>
                <SectionLabel>Por cuenta — su propia historia</SectionLabel>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: 16,
                  }}
                >
                  {accounts.map((a, i) => (
                    <Card key={a.account_id ?? i} style={{ padding: 0 }}>
                      <div
                        style={{
                          padding: "14px 16px 10px",
                          borderBottom: `1px solid ${UI.border}`,
                        }}
                      >
                        {a.account_id ? (
                          <Link
                            href={`/performance/${encodeURIComponent(a.account_id)}`}
                            className="hover:underline"
                            style={{
                              color: UI.text,
                              fontWeight: 600,
                              fontSize: 14,
                              textDecoration: "none",
                            }}
                          >
                            {a.name || a.account_id}
                          </Link>
                        ) : (
                          <span style={{ fontWeight: 600, fontSize: 14 }}>
                            {a.name ?? "—"}
                          </span>
                        )}
                      </div>
                      <DataTable>
                        <THead cols={PLAYBOOK_COLS} />
                        <CellRows cells={a.cells.slice(0, 4)} showAccounts={false} />
                      </DataTable>
                    </Card>
                  ))}
                </div>
              </>
            )}

            <p style={{ fontSize: 12.5, lineHeight: 1.6, color: UI.faint, marginTop: 24 }}>
              Win-rate = de los episodios decisivos (mejoró/empeoró), % que mejoró.
              Efecto neto = mediana del efecto de-confundido, ya descontada la tendencia
              de la cuenta — <span style={{ color: netColor(1) }}>verde</span> mejora,{" "}
              <span style={{ color: netColor(-1) }}>rojo</span> empeora.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
