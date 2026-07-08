import { redirect } from "next/navigation";
import { Header } from "@/components/header";
import { PageHeader, Card, SectionLabel, Badge, EmptyState, ErrorCard, UI } from "@/components/ui-kit";
import { getCommandAccess } from "@/lib/command/access";
import { listExecutions } from "@/lib/command/actions-repo";
import { ACTION_TYPE_LABEL_ES, NETWORK_LABEL_ES, formatBeforeAfter, formatFecha } from "@/lib/command/report-csv";
import PrintButton from "./print-button";

// Auth + DB reads (executions) — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPORT_WINDOW_DAYS = 7;
// listExecutions() has no server-side date/status filter (design spec §e:
// "no repo change" — actions-repo.ts stays UNTOUCHED), so this page pulls a
// bounded window of recent executions, most-recent-first, and filters
// client-side (validateOnly=false, status='done', createdAt within the last
// REPORT_WINDOW_DAYS). At beta's single-operator scale this comfortably
// covers a week's worth of real executions.
const REPORT_SCAN_LIMIT = 500;

interface ReportEntry {
  id: string;
  createdAt: string | null;
  actionLabel: string;
  beforeAfter: string;
  rationale: string | null;
  actionStatus: string;
}

interface CampaignGroup {
  key: string;
  label: string;
  entries: ReportEntry[];
}

interface AccountGroup {
  key: string;
  accountRef: string;
  networkLabel: string;
  campaigns: CampaignGroup[];
}

function estadoBadge(actionStatus: string) {
  if (actionStatus === "verified") return <Badge tone="ok" dot>✓ Verificada</Badge>;
  if (actionStatus === "rolled_back") return <Badge tone="muted" dot>Revertida</Badge>;
  return <Badge tone="accent" dot>Ejecutada</Badge>;
}

function fmtDateOnly(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export default async function BitacoraReportePage() {
  const access = await getCommandAccess();
  if (!access) redirect("/login");

  const now = new Date();
  const since = new Date(now.getTime() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  let error: string | null = null;
  const accountGroups: AccountGroup[] = [];
  try {
    const executions = await listExecutions(access.workspaceIds, REPORT_SCAN_LIMIT);
    const accountIndex = new Map<string, AccountGroup>();

    for (const { execution: e, action: a } of executions) {
      if (e.validateOnly || e.status !== "done" || !e.createdAt) continue;
      const createdAt = new Date(e.createdAt);
      if (createdAt.getTime() < since.getTime()) continue;

      const accountKey = `${a.network}::${e.accountRef}`;
      let accountGroup = accountIndex.get(accountKey);
      if (!accountGroup) {
        accountGroup = {
          key: accountKey,
          accountRef: e.accountRef,
          networkLabel: NETWORK_LABEL_ES[a.network] ?? a.network,
          campaigns: [],
        };
        accountIndex.set(accountKey, accountGroup);
        accountGroups.push(accountGroup);
      }

      // Design spec §e: grouped Cuenta → Campaña (entityName/entityRef). Every
      // row groups under its OWN entity — a campaign-scoped action groups
      // under the campaign's name, an ad-group-scoped action under the ad
      // group's name (cc_actions carries no separate parent-campaign name).
      const campaignLabel = a.entityName ?? a.entityRef;
      let campaignGroup = accountGroup.campaigns.find((c) => c.label === campaignLabel);
      if (!campaignGroup) {
        campaignGroup = { key: `${accountKey}::${campaignLabel}`, label: campaignLabel, entries: [] };
        accountGroup.campaigns.push(campaignGroup);
      }

      campaignGroup.entries.push({
        id: e.id,
        createdAt: e.createdAt ? createdAt.toISOString() : null,
        actionLabel: ACTION_TYPE_LABEL_ES[a.actionType] ?? a.actionType,
        beforeAfter: formatBeforeAfter(
          (e.before ?? null) as Record<string, unknown> | null,
          (e.after ?? null) as Record<string, unknown> | null
        ),
        rationale: a.rationale ?? null,
        actionStatus: a.status,
      });
    }

    // Stable ordering: alpha for the groups (identical render on every
    // load), chronological (oldest→newest) within a campaign so the entries
    // read as a narrative — "first we did X, then Y".
    for (const ag of accountGroups) {
      ag.campaigns.sort((x, y) => x.label.localeCompare(y.label));
      for (const cg of ag.campaigns) {
        cg.entries.sort((x, y) => (x.createdAt ?? "").localeCompare(y.createdAt ?? ""));
      }
    }
    accountGroups.sort((x, y) => x.accountRef.localeCompare(y.accountRef));
  } catch (e) {
    error = e instanceof Error ? e.message : "Error cargando el resumen semanal";
  }

  return (
    <div>
      {/* Print view (design spec §e): hide the app chrome (header/sidebar/
          nav) and any on-screen-only control, leaving just the report. */}
      <style>{`
        @media print {
          header, aside, nav, .cc-no-print { display: none !important; }
        }
      `}</style>

      <Header
        breadcrumbs={[
          { label: "Centro de Mando", href: "/command" },
          { label: "Bitácora", href: "/command/bitacora" },
          { label: "Resumen semanal" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Resumen semanal — qué cambiamos y por qué"
          subtitle={`Del ${fmtDateOnly(since)} al ${fmtDateOnly(now)} · lo que se ejecutó realmente (sin ensayos)`}
          actions={<PrintButton />}
        />

        {error ? <ErrorCard message={error} /> : null}

        {!error && accountGroups.length === 0 ? (
          <EmptyState
            title="Sin ejecuciones esta semana"
            hint="Cuando se ejecuten acciones reales (no ensayos) en los últimos 7 días, aparecerán aquí agrupadas por cuenta y campaña."
          />
        ) : null}

        {accountGroups.map((ag) => (
          <Card key={ag.key} style={{ marginBottom: 20 }}>
            <SectionLabel>{ag.networkLabel} · {ag.accountRef}</SectionLabel>
            {ag.campaigns.map((cg) => (
              <div key={cg.key} style={{ marginTop: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 14.5, color: UI.text, marginBottom: 8 }}>
                  {cg.label}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {cg.entries.map((entry) => (
                    <div key={entry.id} style={{ borderLeft: `2px solid ${UI.border}`, paddingLeft: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ color: UI.faint, fontSize: 12.5 }}>{formatFecha(entry.createdAt)}</span>
                        <span style={{ fontSize: 13.5, color: UI.text, fontWeight: 550 }}>{entry.actionLabel}</span>
                        {estadoBadge(entry.actionStatus)}
                      </div>
                      <div style={{ fontSize: 13, color: UI.muted, marginTop: 3 }}>{entry.beforeAfter}</div>
                      {entry.rationale ? (
                        <div style={{ fontSize: 13, color: UI.faint, marginTop: 3, fontStyle: "italic" }}>
                          Por qué: {entry.rationale}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </Card>
        ))}
      </main>
    </div>
  );
}
