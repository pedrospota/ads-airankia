import { AppShell } from "@/components/app-shell";

// Thin layout: global sidebar shell around the admin section (the page itself
// stays admin-gated server-side).
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
