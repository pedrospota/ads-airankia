// Google connection accounts for the Acciones import picker's "Cuenta
// destino" select (design spec §b — v2.6 batch actions + pickers).
//
// Mirrors cuentas/page.tsx's connections+accounts query byte-for-byte
// (same table, same enabled/is_manager filter) — Google only, deliberately.
// import-engine's contract requires a real ads_google_connections row
// (connection_id + account_ref), which Meta accounts never have; cuentas
// keeps Meta accounts in a separate metaAccountRefs() loop with
// connectionId: null, which is exactly what this picker cannot use.
import { createSupabaseReadClient } from "@/lib/supabase-server";
import type { CommandAccess } from "@/lib/command/access";

export interface UnifiedDestinationAccount {
  connectionId: string;
  accountRef: string;
  label: string;
}

export async function listUnifiedAccounts(access: CommandAccess): Promise<UnifiedDestinationAccount[]> {
  const db = createSupabaseReadClient(access.accessToken);
  const { data: connections } = await db
    .from("ads_google_connections")
    .select(
      "id, google_email, ads_connection_accounts(customer_id, descriptive_name, currency, is_manager, enabled)"
    )
    .in("workspace_id", access.workspaceIds);

  const accounts: UnifiedDestinationAccount[] = [];
  for (const c of connections ?? []) {
    for (const a of (c.ads_connection_accounts as Array<Record<string, unknown>>) ?? []) {
      if (a.enabled === true && a.is_manager !== true) {
        const name = (a.descriptive_name as string | null) ?? String(a.customer_id);
        const email = (c as Record<string, unknown>).google_email as string | null;
        accounts.push({
          connectionId: String((c as Record<string, unknown>).id),
          accountRef: String(a.customer_id),
          label: email ? `${name} (${a.customer_id}) · ${email}` : `${name} (${a.customer_id})`,
        });
      }
    }
  }
  return accounts;
}
