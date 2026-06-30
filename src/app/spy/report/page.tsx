import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { ReportClient } from "./report-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ReportPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");
  return <ReportClient />;
}
