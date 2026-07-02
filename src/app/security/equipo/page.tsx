import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { fetchOptimizers, fmtNum } from "@/lib/sentinel";

// Per-request data (cache: "no-store") + runtime env vars — never prerender.
export const dynamic = "force-dynamic";

const ACCENT = "#10b981";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
};

// The engine only accepts these windows (anything else falls back to 14).
const DAY_OPTIONS = [7, 14, 30] as const;

interface OptimizerRow {
  person?: string;
  account_id?: string;
  account_name?: string;
  n_changes?: number;
  types?: Record<string, number>;
}

function KpiCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={CARD_STYLE}>
      <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
        {label}
      </p>
      <p className="text-2xl font-bold mt-2" style={accent ? { color: ACCENT } : undefined}>
        {value}
      </p>
    </div>
  );
}

function DaysSwitcher({ days }: { days: number }) {
  return (
    <div className="flex items-center gap-2">
      {DAY_OPTIONS.map((d) => {
        const active = d === days;
        return (
          <Link
            key={d}
            href={`/security/equipo?days=${d}`}
            className="text-xs font-medium whitespace-nowrap"
            aria-current={active ? "page" : undefined}
            style={{
              padding: "5px 12px",
              borderRadius: 999,
              textDecoration: "none",
              color: active ? ACCENT : undefined,
              opacity: active ? 1 : 0.6,
              background: active ? "rgba(16,185,129,0.12)" : "transparent",
              border: active
                ? "1px solid rgba(16,185,129,0.3)"
                : "1px solid rgba(128,128,128,0.25)",
            }}
          >
            {d} días
          </Link>
        );
      })}
    </div>
  );
}

/** "campaign×3, ad_group_criterion×12" as small chips, biggest first. */
function TypeChips({ types }: { types: Record<string, number> | null | undefined }) {
  const entries = Object.entries(types ?? {}).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (entries.length === 0) return <span style={{ opacity: 0.4 }}>—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([type, count]) => (
        <span
          key={type}
          className="text-xs px-2 py-0.5 rounded-full whitespace-nowrap"
          style={{
            border: "1px solid rgba(128,128,128,0.3)",
            background: "rgba(128,128,128,0.08)",
            opacity: 0.8,
          }}
        >
          {type}×{fmtNum(count)}
        </span>
      ))}
    </span>
  );
}

export default async function SecurityTeamPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const rawDays = Number(Array.isArray(sp.days) ? sp.days[0] : sp.days);
  const days = (DAY_OPTIONS as readonly number[]).includes(rawDays) ? rawDays : 14;

  let rows: OptimizerRow[] = [];
  let error: string | null = null;

  try {
    const data = await fetchOptimizers(days);
    rows = data.rows ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudo cargar la actividad del equipo.";
  }

  const sorted = [...rows].sort((a, b) => (b.n_changes ?? 0) - (a.n_changes ?? 0));
  const nPersonas = new Set(sorted.map((r) => r.person || "(desconocido)")).size;
  const nCuentas = new Set(sorted.map((r) => r.account_id || r.account_name || "?")).size;
  const nCambios = sorted.reduce((s, r) => s + (r.n_changes ?? 0), 0);

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[{ label: "Seguridad", href: "/security" }, { label: "Equipo" }]}
      />

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold">Equipo — actividad de optimizadores</h1>
            <p className="mt-2" style={{ opacity: 0.4 }}>
              Cambios atribuidos por persona en Google Ads — {days} días
            </p>
          </div>
          <DaysSwitcher days={days} />
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
            No pudimos cargar la actividad del equipo. {error}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <KpiCard label="Personas activas" value={fmtNum(nPersonas)} accent />
              <KpiCard label="Cuentas tocadas" value={fmtNum(nCuentas)} />
              <KpiCard label="Cambios totales" value={fmtNum(nCambios)} />
            </div>

            {sorted.length === 0 ? (
              <div className="text-center py-16" style={{ opacity: 0.4 }}>
                <p className="text-lg">
                  Sin cambios atribuidos en los últimos {days} días.
                </p>
                <p className="text-sm mt-2">
                  La actividad del equipo aparecerá aquí cuando el colector detecte
                  cambios en Google Ads.
                </p>
              </div>
            ) : (
              <div style={{ ...CARD_STYLE, padding: 0, overflowX: "auto" }}>
                <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr
                      className="text-xs uppercase tracking-wide"
                      style={{ opacity: 0.5, borderBottom: "1px solid rgba(128,128,128,0.2)" }}
                    >
                      <th className="text-left font-medium px-4 py-3">Persona</th>
                      <th className="text-left font-medium px-4 py-3">Cuenta</th>
                      <th className="text-right font-medium px-4 py-3">Cambios</th>
                      <th className="text-left font-medium px-4 py-3">Desglose</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r, i) => (
                      <tr
                        key={`${r.person ?? "?"}-${r.account_id ?? i}`}
                        style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}
                      >
                        <td className="px-4 py-3 font-medium">
                          {r.person || "(desconocido)"}
                        </td>
                        <td className="px-4 py-3" style={{ opacity: 0.8 }}>
                          {r.account_name || r.account_id || "—"}
                        </td>
                        <td
                          className="text-right px-4 py-3 font-semibold"
                          style={{ color: ACCENT }}
                        >
                          {fmtNum(r.n_changes)}
                        </td>
                        <td className="px-4 py-3">
                          <TypeChips types={r.types} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
