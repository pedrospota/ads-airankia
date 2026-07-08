import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCommandAccess } from "@/lib/command/access";

// Centro de Mando (beta): stealth gate. getCommandAccess owns the whole
// decision (flag → session → role/allow-list) — v3.0 operators pass, plain
// users 404, flag-off 404s for everyone. Same posture as before, one owner.
export const dynamic = "force-dynamic";

export default async function CommandLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getCommandAccess();
  if (!access) notFound();
  return <AppShell>{children}</AppShell>;
}
