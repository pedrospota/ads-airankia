import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import {
  appBaseUrl,
  encryptSecret,
  exchangeCode,
  listAccessibleCustomers,
  GOOGLE_ADS_SCOPE,
} from "@/lib/ads-connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "gads_oauth_state";

function redirectToConexiones(params: Record<string, string>): NextResponse {
  const url = new URL("/conexiones", appBaseUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url, { status: 302 });
  // one-shot cookie — always clear it
  res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

// GET /api/connections/callback — Google redirects here after consent.
// Exchanges the code, stores the encrypted refresh token as a connection and
// discovers the accessible Google Ads accounts (all disabled by default).
export async function GET(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    // Browser navigation mid-flow with an expired session: a raw 401 would be a
    // dead end — send them to login instead.
    return NextResponse.redirect(new URL("/login", appBaseUrl()), { status: 302 });
  }

  const searchParams = request.nextUrl.searchParams;

  // User denied consent (or Google errored) — nothing to store.
  const oauthError = searchParams.get("error");
  if (oauthError) {
    return redirectToConexiones({
      error: `Google canceló la autorización (${oauthError}).`,
    });
  }

  const code = searchParams.get("code");
  if (!code) {
    return redirectToConexiones({ error: "Falta el código de autorización de Google." });
  }

  // CSRF: the state must match the cookie we set at /start.
  const state = searchParams.get("state");
  const cookieState = request.cookies.get(STATE_COOKIE)?.value;
  if (!state || !cookieState || state !== cookieState) {
    return redirectToConexiones({
      error: "La sesión de autorización expiró o no es válida. Vuelve a intentarlo.",
    });
  }

  try {
    // 1. Exchange the code for a refresh token + connected email.
    const { refreshToken, email, scopes } = await exchangeCode(code);

    // 2. Resolve the user's workspace (first membership) with RLS applied.
    const {
      data: { session },
    } = await authClient.auth.getSession();
    const db = createSupabaseReadClient(session?.access_token);

    const { data: memberships, error: wsError } = await db
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1);
    const workspaceId = memberships?.[0]?.workspace_id;
    if (wsError || !workspaceId) {
      return redirectToConexiones({
        error: "No encontramos un workspace en tu cuenta. Crea uno primero en AI Rankia.",
      });
    }

    // 3. Store the connection with the refresh token encrypted at rest.
    const { data: connection, error: insertError } = await db
      .from("ads_google_connections")
      .insert({
        workspace_id: workspaceId,
        provider: "google_ads",
        google_email: email,
        refresh_token_enc: encryptSecret(refreshToken),
        scopes: scopes ?? GOOGLE_ADS_SCOPE,
        status: "active",
        created_by: user.id,
      })
      .select("id")
      .single();
    if (insertError || !connection) {
      console.error("[connections/callback] insert connection failed", insertError);
      return redirectToConexiones({
        error: "No se pudo guardar la conexión. Vuelve a intentarlo.",
      });
    }

    // 4. Discover accessible accounts (best-effort — the connection is already
    //    saved; a discovery failure shouldn't lose the token).
    try {
      const accounts = await listAccessibleCustomers(refreshToken);
      if (accounts.length > 0) {
        const rows = accounts.map((a) => ({
          connection_id: connection.id,
          customer_id: a.customer_id,
          descriptive_name: a.descriptive_name,
          currency: a.currency,
          time_zone: a.time_zone,
          is_manager: a.is_manager,
          enabled: false, // the user activates accounts one by one
          brand_id: null,
        }));
        const { error: accError } = await db
          .from("ads_connection_accounts")
          .insert(rows);
        if (accError) {
          console.error("[connections/callback] insert accounts failed", accError);
          return redirectToConexiones({ connected: "1", warn: "cuentas" });
        }
      }
    } catch (e) {
      console.error("[connections/callback] account discovery failed", e);
      return redirectToConexiones({ connected: "1", warn: "cuentas" });
    }

    return redirectToConexiones({ connected: "1" });
  } catch (e) {
    console.error("[connections/callback] oauth exchange failed", e);
    return redirectToConexiones({
      error: e instanceof Error ? e.message : "Error al conectar con Google.",
    });
  }
}
