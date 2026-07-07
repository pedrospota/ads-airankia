import { createSupabaseReadClient } from "@/lib/supabase-server";
import { decryptSecret } from "@/lib/ads-connections";
import * as repo from "./actions-repo";
import { adapterFor } from "./networks";
import { getCcSettings } from "./settings";
import type { CcActionRow } from "./actions-repo";
import type { AdapterAuth } from "./types";
import type { ExecutorDeps } from "./executor";

export function buildExecutorDeps(supabaseAccessToken: string | undefined): ExecutorDeps {
  return {
    repo: {
      getAction: repo.getAction,
      transitionAction: (row, to, patch) => repo.transitionAction(row as CcActionRow, to as never, patch as never),
      insertExecution: (v) => repo.insertExecution(v as never),
      updateExecution: (id, patch) => repo.updateExecution(id, patch as never),
      countExecutedToday: repo.countExecutedToday,
      latestDoneExecution: repo.latestDoneExecution,
      createAction: (v) => repo.createAction(v as never),
    },
    adapters: { for: adapterFor },
    settings: { get: getCcSettings },
    auth: {
      async resolve(action: CcActionRow): Promise<AdapterAuth> {
        if (action.network !== "google_ads") return {};
        if (!action.connectionId) throw new Error("La acción de Google no tiene conexión asociada.");
        const db = createSupabaseReadClient(supabaseAccessToken);
        const { data, error } = await db
          .from("ads_google_connections")
          .select("id, refresh_token_enc")
          .eq("id", action.connectionId)
          .maybeSingle();
        if (error || !data?.refresh_token_enc) throw new Error("Conexión de Google no accesible para este usuario.");
        return { googleRefreshToken: decryptSecret(String(data.refresh_token_enc)) };
      },
    },
    dryRun: process.env.CC_DRY_RUN === "true",
    now: () => new Date(),
  };
}
