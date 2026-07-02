import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchCosts, fmtMoney, fmtNum } from "@/lib/sentinel";

// Datos del optimizador por request (cache: "no-store") — nunca prerender.
export const dynamic = "force-dynamic";

const ACCENT = "#10b981";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

interface CostRow {
  day?: string;
  kind?: string;
  model?: string;
  calls?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number;
}

interface KindAgg {
  kind: string;
  calls: number;
  tokens: number;
  cost: number;
}

export default async function CostosPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  let rows: CostRow[] = [];
  let error: string | null = null;

  try {
    const data = await fetchCosts(30);
    rows = data.rows ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudieron cargar los costos.";
  }

  const totalCost = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const totalCalls = rows.reduce((s, r) => s + (r.calls ?? 0), 0);

  // Agrupado por tipo de uso (kind), ordenado por costo desc.
  const byKind = new Map<string, KindAgg>();
  for (const r of rows) {
    const kind = r.kind || "otro";
    const agg = byKind.get(kind) ?? { kind, calls: 0, tokens: 0, cost: 0 };
    agg.calls += r.calls ?? 0;
    agg.tokens += (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0);
    agg.cost += r.cost_usd ?? 0;
    byKind.set(kind, agg);
  }
  const kinds = [...byKind.values()].sort((a, b) => b.cost - a.cost);

  // Totales por día, más recientes primero.
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = r.day || "—";
    byDay.set(day, (byDay.get(day) ?? 0) + (r.cost_usd ?? 0));
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Costos" },
        ]}
      />

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Costos</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Cuánto cuesta operar el optimizador — consumo de IA de los últimos 30 días
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
            No pudimos cargar los costos. {error}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <div style={CARD_STYLE}>
                <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                  Costo total (30 días)
                </p>
                <p className="text-2xl font-bold mt-2" style={{ color: ACCENT }}>
                  {fmtMoney(totalCost, 2)}
                </p>
              </div>
              <div style={CARD_STYLE}>
                <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                  Llamadas
                </p>
                <p className="text-2xl font-bold mt-2">{fmtNum(totalCalls)}</p>
              </div>
              <div style={CARD_STYLE}>
                <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                  Tipos de uso
                </p>
                <p className="text-2xl font-bold mt-2">{fmtNum(kinds.length)}</p>
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="text-center py-16" style={{ opacity: 0.4 }}>
                <p className="text-lg">Sin consumo registrado en los últimos 30 días.</p>
                <p className="text-sm mt-2">
                  Los costos aparecerán aquí conforme el optimizador use modelos de IA.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2" style={{ ...CARD_STYLE, padding: 0, overflowX: "auto" }}>
                  <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
                    <thead>
                      <tr
                        className="text-xs uppercase tracking-wide"
                        style={{ opacity: 0.5, borderBottom: "1px solid rgba(128,128,128,0.2)" }}
                      >
                        <th className="text-left font-medium px-4 py-3">Tipo de uso</th>
                        <th className="text-right font-medium px-4 py-3">Llamadas</th>
                        <th className="text-right font-medium px-4 py-3">Tokens</th>
                        <th className="text-right font-medium px-4 py-3">Costo USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {kinds.map((k) => (
                        <tr key={k.kind} style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}>
                          <td className="px-4 py-3 font-medium">{k.kind}</td>
                          <td className="text-right px-4 py-3">{fmtNum(k.calls)}</td>
                          <td className="text-right px-4 py-3" style={{ opacity: 0.7 }}>
                            {fmtNum(k.tokens)}
                          </td>
                          <td className="text-right px-4 py-3 font-semibold" style={{ color: ACCENT }}>
                            {fmtMoney(k.cost, 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ ...CARD_STYLE, padding: 0 }}>
                  <p
                    className="text-xs uppercase tracking-wide px-4 py-3"
                    style={{ opacity: 0.5, borderBottom: "1px solid rgba(128,128,128,0.2)" }}
                  >
                    Por día
                  </p>
                  <ul className="text-sm" style={{ maxHeight: 420, overflowY: "auto" }}>
                    {days.map(([day, cost]) => (
                      <li
                        key={day}
                        className="flex justify-between px-4 py-2"
                        style={{ borderBottom: "1px solid rgba(128,128,128,0.08)" }}
                      >
                        <span style={{ opacity: 0.7 }}>{day}</span>
                        <span className="font-medium">{fmtMoney(cost, 2)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
