import { AppShell } from "@/components/app-shell";

// Thin layout: global sidebar shell around the Copiloto section.
export default function CopilotoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
