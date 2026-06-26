import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { adsDb } from "@/lib/ads-db";
import { campaigns, agentRuns, agentSteps } from "@/lib/schema";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { CampaignsDashboard, type CampaignListItem } from "./campaigns-dashboard";

export const dynamic = "force-dynamic";

// Same account id the activator mutates against (hyphens stripped for the URL).
const CUSTOMER_ID = process.env.GOOGLE_ADS_ACCOUNT_ID || "3531706003";

export default async function CampaignsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: brandId } = await params;

  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  const {
    data: { session },
  } = await authClient.auth.getSession();
  const supabase = createSupabaseReadClient(session?.access_token);
  const { data: brand } = await supabase
    .from("brand_project")
    .select("id, name, website")
    .eq("id", brandId)
    .single();
  if (!brand) redirect("/brands");

  // Search campaigns for this brand + user. Display is intentionally excluded
  // (it lives on a separate path and is out of scope here).
  const rows = await adsDb
    .select({
      campaignId: campaigns.id,
      campaignStatus: campaigns.status,
      googleCampaignId: campaigns.googleCampaignId,
      dailyBudgetCents: campaigns.dailyBudgetCents,
      brandName: campaigns.brandName,
      landingPageUrl: campaigns.landingPageUrl,
      createdAt: campaigns.createdAt,
      runId: agentRuns.id,
      runStatus: agentRuns.status,
      runUpdatedAt: agentRuns.updatedAt,
    })
    .from(campaigns)
    .leftJoin(agentRuns, eq(agentRuns.campaignId, campaigns.id))
    .where(
      and(
        eq(campaigns.brandId, brandId),
        eq(campaigns.userId, user.id),
        eq(campaigns.campaignType, "search"),
        // Discarded campaigns are removed from the user's list entirely.
        ne(campaigns.status, "removed")
      )
    )
    .orderBy(desc(campaigns.createdAt));

  // Collapse to one row per campaign. createRun makes exactly one run per
  // campaign, but guard against duplicates by keeping the most recent run.
  const byCampaign = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = byCampaign.get(r.campaignId);
    if (!prev) {
      byCampaign.set(r.campaignId, r);
      continue;
    }
    const a = r.runUpdatedAt ? new Date(r.runUpdatedAt).getTime() : 0;
    const b = prev.runUpdatedAt ? new Date(prev.runUpdatedAt).getTime() : 0;
    if (a > b) byCampaign.set(r.campaignId, r);
  }
  const unique = Array.from(byCampaign.values());

  // Friendly campaign names live in the structure step output, not the
  // campaigns row. Fetch them in one query keyed by run id.
  const runIds = unique
    .map((r) => r.runId)
    .filter((x): x is string => Boolean(x));
  const nameByRun = new Map<string, string>();
  if (runIds.length > 0) {
    const nameRows = await adsDb
      .select({
        runId: agentSteps.runId,
        output: agentSteps.output,
        userOverride: agentSteps.userOverride,
      })
      .from(agentSteps)
      .where(
        and(
          inArray(agentSteps.runId, runIds),
          eq(agentSteps.agent, "structure_architect")
        )
      );
    for (const n of nameRows) {
      // A hand-edited name (userOverride) wins over the AI's original output,
      // mirroring how buildRunContext folds userOverride ?? output for the
      // activator. Without this, a rename before activating would never show.
      const effective = (n.userOverride ?? n.output) as {
        campaignName?: string;
      } | null;
      const cn = effective?.campaignName;
      if (cn && n.runId) nameByRun.set(n.runId, cn);
    }
  }

  const cidNoHyphens = CUSTOMER_ID.replace(/-/g, "");
  const items: CampaignListItem[] = unique.map((r) => ({
    campaignId: r.campaignId,
    runId: r.runId,
    displayName:
      (r.runId ? nameByRun.get(r.runId) : undefined) ||
      r.brandName ||
      "Campaña de Búsqueda",
    campaignStatus: r.campaignStatus,
    runStatus: r.runStatus,
    googleCampaignId:
      r.googleCampaignId != null ? String(r.googleCampaignId) : null,
    dailyBudgetCents: r.dailyBudgetCents,
    landingPageUrl: r.landingPageUrl,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    deepLink:
      r.googleCampaignId != null
        ? `https://ads.google.com/aw/campaigns?campaignId=${r.googleCampaignId}&__c=${cidNoHyphens}`
        : null,
  }));

  return (
    <CampaignsDashboard brandId={brand.id} brandName={brand.name} items={items} />
  );
}
