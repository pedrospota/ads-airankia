// Command Center v2.3 edit-mode — loads a live Google Search campaign into a
// draft edit blueprint (docType "google_search_edit_v1"). This route is the
// trust boundary for two things the rest of the edit-mode surface relies on:
//   (a) campaign_id must be strictly numeric before it ever reaches
//       readCampaignTree, which interpolates it into GAQL — a non-numeric id
//       would otherwise ride along as NaN and only fail deep inside the
//       Google Ads API call.
//   (b) every ad resourceName the operator can later act on comes from the
//       tree read here (via buildEditDoc -> mergeEditDoc downstream); no
//       client-supplied resourceName is ever accepted anywhere in this flow.
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { buildExecutorDeps } from "@/lib/command/executor-deps";
import { adapterFor } from "@/lib/command/networks";
import { readCampaignTree } from "@/lib/command/networks/google";
import { buildEditDoc } from "@/lib/command/edit/read-tree";
import { createBlueprint } from "@/lib/command/blueprint/repo";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import type { CcActionRow } from "@/lib/command/actions-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EditBody {
  network?: unknown;
  connection_id?: unknown;
  account_ref?: unknown;
  campaign_id?: unknown;
}

const CAMPAIGN_ID_RE = /^\d+$/;

export async function POST(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();

  let body: EditBody;
  try { body = (await request.json()) as EditBody; }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const network = body.network === "google_ads" ? "google_ads" : null;
  const connectionId = typeof body.connection_id === "string" && body.connection_id ? body.connection_id : null;
  const accountRef = typeof body.account_ref === "string" && body.account_ref ? body.account_ref : null;
  const campaignId = typeof body.campaign_id === "string" && body.campaign_id ? body.campaign_id : null;

  if (!network || !connectionId || !accountRef || !campaignId) {
    return NextResponse.json(
      { error: "Faltan campos: network, connection_id, account_ref, campaign_id" }, { status: 400 }
    );
  }

  // Security requirement (a): campaign_id is interpolated into GAQL inside
  // readCampaignTree (Number(campaignId)); this route is the boundary that
  // must reject anything non-numeric before that call happens.
  if (!CAMPAIGN_ID_RE.test(campaignId)) {
    return NextResponse.json({ error: "campaign_id inválido" }, { status: 400 });
  }

  const workspaceId = access.workspaceIds[0];
  if (!workspaceId) {
    return NextResponse.json({ error: "workspace inválido" }, { status: 403 });
  }

  // Tenant boundary, copied verbatim from blueprint/route.ts's POST: connection_id must
  // belong to the caller's own workspace, never trusted blindly from the body.
  const db = createSupabaseReadClient(access.accessToken);
  const { data: conn } = await db.from("ads_google_connections").select("workspace_id").eq("id", connectionId).maybeSingle();
  if (!conn || String(conn.workspace_id) !== workspaceId) {
    return NextResponse.json({ error: "connection_id no pertenece a este workspace" }, { status: 400 });
  }

  try {
    const deps = buildExecutorDeps(access.accessToken);
    const auth = await deps.auth.resolve({ network, connectionId, workspaceId } as unknown as CcActionRow);
    const adapter = adapterFor("google_ads");
    if (!adapter.capabilities(auth).read) {
      return NextResponse.json({ error: "Sin acceso de lectura" }, { status: 409 });
    }

    let tree;
    try {
      tree = await readCampaignTree(auth, accountRef, campaignId);
    } catch (e) {
      // Known domain throws from readCampaignTree (not-found / not-SEARCH / REMOVED) —
      // surface the Spanish message as a 409, distinct from unexpected failures below.
      return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 409 });
    }

    // Security requirement (b): buildEditDoc derives every entity resourceName
    // (campaign, ad groups, keywords, ads) solely from this server-read tree.
    const doc = buildEditDoc(tree, accountRef, new Date().toISOString());
    const bp = await createBlueprint({
      workspaceId, createdBy: access.email, network: "google_ads",
      accountRef, connectionId, doc: doc as never, status: "draft",
    });
    return NextResponse.json({ id: bp.id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
