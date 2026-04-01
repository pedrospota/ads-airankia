import { createClient } from "@supabase/supabase-js";

// READ-ONLY client for the main airankia Supabase project
// Used to fetch: brand_project, queries, query_run_results
export function createSupabaseReadClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
