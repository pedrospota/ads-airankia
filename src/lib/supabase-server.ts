import { createClient } from "@supabase/supabase-js";

// READ-ONLY client (no auth, service-level reads)
// Safe to import from both server and client components
export function createSupabaseReadClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
