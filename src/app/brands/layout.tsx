import { AppShell } from "@/components/app-shell";

// Thin layout: wrap the whole /brands section (grid, benchmark, citations,
// campaigns…) in the global sidebar shell. Pages keep their own <Header>.
export default function BrandsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
