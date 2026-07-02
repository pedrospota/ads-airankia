import { AppShell } from "@/components/app-shell";

// Thin layout: global sidebar shell around the connections section.
export default function ConexionesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
