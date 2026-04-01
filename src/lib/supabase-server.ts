import { createClient } from "@supabase/supabase-js";

// Read client for airankia Supabase — pass user's access token so RLS works
export function createSupabaseReadClient(accessToken?: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false },
      ...(accessToken && {
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
    }
  );
}
