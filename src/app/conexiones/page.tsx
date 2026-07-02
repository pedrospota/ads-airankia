import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import {
  ConexionesClient,
  type ConnectionRow,
  type BrandOption,
} from "./conexiones-client";

// Auth is cookie-based per-request, so never prerender this page.
export const dynamic = "force-dynamic";

export default async function ConexionesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  const {
    data: { session },
  } = await authClient.auth.getSession();
  const accessToken = session?.access_token;
  const db = createSupabaseReadClient(accessToken);

  const params = await searchParams;
  const connected = params.connected === "1";
  const warn = typeof params.warn === "string" ? params.warn : null;
  const errorParam = typeof params.error === "string" ? params.error : null;

  let connections: ConnectionRow[] = [];
  let brands: BrandOption[] = [];
  let loadError: string | null = null;

  try {
    // Workspaces of the user (RLS also scopes everything below, this is just
    // to scope the brand list explicitly).
    const { data: memberships, error: wsError } = await db
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id);
    if (wsError) throw wsError;
    const workspaceIds = (memberships ?? []).map((m) => m.workspace_id);

    if (workspaceIds.length > 0) {
      const [connRes, brandRes] = await Promise.all([
        db
          .from("ads_google_connections")
          .select(
            "id, google_email, status, is_engine_source, created_at, ads_connection_accounts(id, customer_id, descriptive_name, currency, time_zone, is_manager, enabled, brand_id)"
          )
          .in("workspace_id", workspaceIds)
          .order("created_at", { ascending: false }),
        db
          .from("brand_project")
          .select("id, name")
          .in("workspace_id", workspaceIds)
          .order("name"),
      ]);

      if (connRes.error) throw connRes.error;
      if (brandRes.error) throw brandRes.error;

      connections = (connRes.data ?? []).map((c) => ({
        id: c.id,
        google_email: c.google_email ?? null,
        status: c.status ?? null,
        is_engine_source: c.is_engine_source ?? null,
        created_at: c.created_at ?? null,
        accounts: (c.ads_connection_accounts ?? [])
          .map((a) => ({
            id: a.id,
            customer_id: a.customer_id ?? null,
            descriptive_name: a.descriptive_name ?? null,
            currency: a.currency ?? null,
            time_zone: a.time_zone ?? null,
            is_manager: a.is_manager ?? null,
            enabled: a.enabled ?? null,
            brand_id: a.brand_id ?? null,
          }))
          .sort((a, b) => (a.customer_id ?? "").localeCompare(b.customer_id ?? "")),
      }));
      brands = (brandRes.data ?? []).map((b) => ({
        id: b.id,
        name: b.name ?? null,
      }));
    } else {
      loadError =
        "No encontramos ningún workspace en tu cuenta. Crea uno primero en AI Rankia.";
    }
  } catch (e) {
    loadError =
      e instanceof Error
        ? e.message
        : "No se pudieron cargar tus conexiones. Recarga la página.";
  }

  return (
    <ConexionesClient
      connections={connections}
      brands={brands}
      connected={connected}
      warn={warn}
      errorParam={errorParam}
      loadError={loadError}
    />
  );
}
