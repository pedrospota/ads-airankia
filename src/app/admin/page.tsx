import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { isAdminEmail } from "@/lib/admin";
import { Header } from "@/components/header";
import { AdminModelSettings } from "./admin-model-settings";
import { AdminCostsPanel } from "./admin-costs-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Not signed in → bounce to login.
  if (!user) redirect("/login");

  // Signed in but not on the admin allow-list → show a clear notice (with the
  // email actually in use) instead of a confusing redirect, so it's obvious WHY
  // the settings are hidden and which account/email to fix. No settings leaked.
  if (!isAdminEmail(user.email)) {
    return (
      <div className="min-h-screen">
        <Header breadcrumbs={[{ label: "Admin" }]} />
        <main className="max-w-3xl mx-auto px-6 py-10">
          <h1 className="text-3xl font-bold">Admin settings</h1>
          <p className="mt-3" style={{ opacity: 0.75 }}>
            You&apos;re signed in as <strong>{user.email}</strong>, which isn&apos;t
            on the admin list, so the model settings stay hidden.
          </p>
          <p className="mt-2" style={{ opacity: 0.5, fontSize: 14 }}>
            Sign in with an admin account, or add this email to the{" "}
            <code>ADMIN_EMAILS</code> setting on the server.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header breadcrumbs={[{ label: "Admin" }]} />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Admin settings</h1>
          <p className="mt-2" style={{ opacity: 0.5 }}>
            Choose the brain the agents use to create the campaigns.
          </p>
        </div>
        <AdminModelSettings />

        <div
          style={{
            borderTop: "1px solid rgba(255,255,255,0.08)",
            margin: "40px 0 28px",
          }}
        />
        <AdminCostsPanel />
      </main>
    </div>
  );
}
