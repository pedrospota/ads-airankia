import { redirect } from "next/navigation";
import { getAdminUser } from "@/lib/admin";
import { Header } from "@/components/header";
import { AdminModelSettings } from "./admin-model-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await getAdminUser();
  // Not signed in OR not an admin → bounce to login (no admin hint leaked).
  if (!admin) redirect("/login");

  return (
    <div className="min-h-screen">
      <Header breadcrumbs={[{ label: "Admin" }]} />
      <main className="max-w-3xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Admin settings</h1>
          <p className="mt-2" style={{ opacity: 0.5 }}>
            Choose the brain the agents use to create the campaigns.
          </p>
        </div>
        <AdminModelSettings />
      </main>
    </div>
  );
}
