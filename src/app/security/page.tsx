import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import {
  fetchSecurity,
  fmtMoney,
  fmtWhen,
  type SecurityItem,
} from "@/lib/sentinel";

// Per-request data (cache: "no-store") + runtime env vars — never prerender.
export const dynamic = "force-dynamic";

const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

const KIND_META: Record<string, { label: string; color: string }> = {
  url_change: { label: "Cambio de URL", color: "#ef4444" },
  budget_change: { label: "Cambio de presupuesto", color: "#f59e0b" },
  finding: { label: "Hallazgo", color: "#3b82f6" },
};

function kindMeta(kind: string | null | undefined) {
  return (kind && KIND_META[kind]) || { label: kind || "Evento", color: "rgba(128,128,128,0.6)" };
}

function asMoney(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? fmtMoney(n) : String(v);
}

function ItemDetail({ item }: { item: SecurityItem }) {
  if (item.kind === "budget_change") {
    return (
      <p className="text-sm mt-1" style={{ opacity: 0.7 }}>
        {asMoney(item.old)} <span style={{ opacity: 0.5 }}>→</span>{" "}
        <span className="font-semibold">{asMoney(item.new)}</span>
        {item.entity ? <span style={{ opacity: 0.5 }}> · {item.entity}</span> : null}
      </p>
    );
  }
  if (item.kind === "url_change") {
    return (
      <p className="text-sm mt-1 break-all" style={{ opacity: 0.7 }}>
        {item.old ?? "—"} <span style={{ opacity: 0.5 }}>→</span>{" "}
        <span className="font-semibold">{item.new ?? "—"}</span>
        {item.entity ? <span style={{ opacity: 0.5 }}> · {item.entity}</span> : null}
      </p>
    );
  }
  // finding (or unknown kind)
  if (item.rule || item.entity) {
    return (
      <p className="text-sm mt-1" style={{ opacity: 0.7 }}>
        {item.rule || "Regla no especificada"}
        {item.entity ? <span style={{ opacity: 0.5 }}> · {item.entity}</span> : null}
      </p>
    );
  }
  return null;
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
    <div className="min-h-screen">
      <Header breadcrumbs={[{ label: "Seguridad" }]} />

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Seguridad — Monitor</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Monitoreo anti-hijacking: cambios de URL, presupuesto y hallazgos críticos — 7 días
          </p>
        </div>

        {error ? (
          <div
            style={{
              padding: 16,
              borderRadius: 8,
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.2)",
              color: "#F87171",
            }}
          >
            No pudimos cargar el monitoreo de seguridad. {error}
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-16" style={{ opacity: 0.5 }}>
            <p className="text-lg">Sin incidentes en los últimos 7 días ✅</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((item, i) => {
              const meta = kindMeta(item.kind);
              return (
                <div key={i} style={CARD_STYLE}>
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="text-xs font-semibold px-2 py-0.5 rounded-full"
                          style={{
                            color: meta.color,
                            border: `1px solid ${meta.color}40`,
                            background: `${meta.color}14`,
                          }}
                        >
                          {meta.label}
                        </span>
                        <span className="font-semibold">
                          {item.account_name || item.account_id || "Cuenta desconocida"}
                        </span>
                      </div>
                      <ItemDetail item={item} />
                      {item.who && (
                        <p className="text-xs mt-1" style={{ opacity: 0.5 }}>
                          {item.who}
                        </p>
                      )}
                    </div>
                    <span
                      className="text-xs whitespace-nowrap shrink-0"
                      style={{ opacity: 0.5 }}
                    >
                      {fmtWhen(item.at)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
