import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { buildAuthUrl } from "@/lib/ads-connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "gads_oauth_state";

// GET /api/connections/start — kick off the Google Ads OAuth flow.
// 302 to Google's consent screen with a CSRF state (echoed on the callback).
export async function GET() {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let authUrl: string;
  const state = randomBytes(16).toString("hex");
  try {
    authUrl = buildAuthUrl(state);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "OAuth no configurado" },
      { status: 500 }
    );
  }

  const res = NextResponse.redirect(authUrl, { status: 302 });
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 min — plenty for a consent screen round-trip
  });
  return res;
}
