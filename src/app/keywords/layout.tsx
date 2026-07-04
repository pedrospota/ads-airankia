import { AppShell } from "@/components/app-shell";

// Thin layout: global sidebar shell around the keyword tool section.
export default function KeywordsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
