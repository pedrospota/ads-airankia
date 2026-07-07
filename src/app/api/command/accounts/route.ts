// Unified account list: enabled Google connection accounts (Supabase, RLS)
// + Meta env-allowlisted accounts, with adapter capabilities.
import { NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { adapterFor } from "@/lib/command/networks";
import { metaAccountRefs } from "@/lib/command/networks/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await getCommandAccess();
  if (!access) return commandDenied();
  try {
    const db = createSupabaseReadClient(access.accessToken);
    const { data: connections } = await db
      .from("ads_google_connections")
      .select("id, workspace_id, google_email, status, ads_connection_accounts(id, customer_id, descriptive_name, currency, is_manager, enabled)")
      .in("workspace_id", access.workspaceIds);
    const google = (connections ?? []).flatMap((c) =>
      ((c.ads_connection_accounts as Array<Record<string, unknown>>) ?? [])
        .filter((a) => a.enabled === true && a.is_manager !== true)
        .map((a) => ({
          network: "google_ads" as const,
          accountRef: String(a.customer_id),
          name: (a.descriptive_name as string) ?? null,
          currency: (a.currency as string) ?? null,
          connectionId: String(c.id),
          workspaceId: String(c.workspace_id),
          googleEmail: String(c.google_email ?? ""),
        })));
    const metaCaps = adapterFor("meta_ads").capabilities({});
    const meta = metaAccountRefs().map((ref) => ({
      network: "meta_ads" as const, accountRef: ref, name: ref, currency: null,
      connectionId: null, workspaceId: access.workspaceIds[0] ?? null, googleEmail: null,
    }));
    return NextResponse.json({
      google, meta,
      capabilities: {
        google_ads: { read: google.length > 0, write: google.length > 0, reason: google.length ? undefined : "Sin cuentas habilitadas en Conexiones." },
        meta_ads: metaCaps,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
