// v3.0 — service-role Supabase client for the equipo (team management) route
// ONLY. This is the one place in the app that bypasses RLS, so containment
// is the design: server-only, imported solely by /api/command/equipo, and
// every caller re-checks requireAdmin() before touching it. Missing key →
// null → the route answers 501 (fail closed, discoverable).
//
// This file is server-only (imported by the equipo API route, never by client
// components). The repo has no `server-only` package dependency and no
// runtime guard convention for this — every other "server-only" file in
// src/lib is enforced by doc comment alone — so this follows the same
// convention rather than importing a package that isn't installed.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createSupabaseAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
