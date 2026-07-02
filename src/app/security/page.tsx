import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import {
  fetchSecurity,
  fmtMoney,
  fmtWhen,
  type SecurityItem,
} from "@/lib/sentinel";
import {
  PageHeader,
  Card,
  DataTable,
  THead,
  Row,
  Cell,
  Badge,
  EmptyState,
  ErrorCard,
  UI,
} from "@/components/ui-kit";

// Per-request data (cache: "no-store") + runtime env vars — never prerender.
export const dynamic = "force-dynamic";

type BadgeTone = "ok" | "warn" | "danger" | "muted" | "accent";

const KIND_META: Record<string, { label: string; tone: BadgeTone }> = {
  url_change: { label: "Cambio de URL", tone: "danger" },
  budget_change: { label: "Cambio de presupuesto", tone: "warn" },
  finding: { label: "Hallazgo", tone: "muted" },
};

function kindMeta(kind: string | null | undefined): { label: string; tone: BadgeTone } {
  return (kind && KIND_META[kind]) || { label: kind || "Evento", tone: "muted" };
}

function asMoney(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? fmtMoney(n) : String(v);
}

function ItemDetail({ item }: { item: SecurityItem }) {
  if (item.kind === "budget_change") {
    return (
      <span>
        {asMoney(item.old)} <span style={{ color: UI.faint }}>→</span>{" "}
        <span style={{ color: UI.text }}>{asMoney(item.new)}</span>
        {item.entity ? <span style={{ color: UI.faint }}> · {item.entity}</span> : null}
      </span>
    );
  }
  if (item.kind === "url_change") {
    return (
      <span style={{ wordBreak: "break-all" }}>
        {item.old ?? "—"} <span style={{ color: UI.faint }}>→</span>{" "}
        <span style={{ color: UI.text }}>{item.new ?? "—"}</span>
        {item.entity ? <span style={{ color: UI.faint }}> · {item.entity}</span> : null}
      </span>
    );
  }
  // finding (or unknown kind)
  if (item.rule || item.entity) {
    return (
      <span>
        {item.rule || "Regla no especificada"}
        {item.entity ? <span style={{ color: UI.faint }}> · {item.entity}</span> : null}
      </span>
    );
  }
  return <span style={{ color: UI.faint }}>—</span>;
}

export default async function SecurityPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let items: SecurityItem[] = [];
  let error: string | null = null;

  try {
    const security = await fetchSecurity();
    items = security.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar el monitoreo.";
  }

  return (
    <div>
      <Header breadcrumbs={[{ label: "Seguridad" }]} />

      <main style={{ marginTop: 24 }}>
        <PageHeader
          title="Seguridad"
          subtitle="Monitoreo anti-hijacking: cambios de URL, presupuesto y hallazgos críticos — últimos 7 días."
        />

        {error ? (
          <ErrorCard message={`No pudimos cargar el monitoreo de seguridad. ${error}`} />
        ) : items.length === 0 ? (
          <Card style={{ padding: 0 }}>
            <EmptyState
              title="Sin incidentes en los últimos 7 días"
              hint="Los cambios de URL, de presupuesto y los hallazgos críticos detectados por el monitor aparecerán aquí."
            />
          </Card>
        ) : (
          <Card style={{ padding: 0 }}>
            <DataTable>
              <THead
                cols={[
                  { label: "Tipo", width: 180 },
                  { label: "Cuenta" },
                  { label: "Detalle" },
                  { label: "Quién" },
                  { label: "Cuándo", align: "right" },
                ]}
              />
              <tbody>
                {items.map((item, i) => {
                  const meta = kindMeta(item.kind);
                  return (
                    <Row key={i}>
                      <Cell>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </Cell>
                      <Cell style={{ fontWeight: 500 }}>
                        {item.account_name || item.account_id || "Cuenta desconocida"}
                      </Cell>
                      <Cell style={{ color: UI.muted }}>
                        <ItemDetail item={item} />
                      </Cell>
                      <Cell style={{ color: UI.muted, whiteSpace: "nowrap" }}>
                        {item.who || "—"}
                      </Cell>
                      <Cell align="right" style={{ color: UI.faint, whiteSpace: "nowrap" }}>
                        {fmtWhen(item.at)}
                      </Cell>
                    </Row>
                  );
                })}
              </tbody>
            </DataTable>
          </Card>
        )}
      </main>
    </div>
  );
}
