import { AppShell } from "@/components/app-shell";
import { SectionNav } from "@/components/section-nav";

// Section layout: global sidebar (AppShell) + sub-nav bar + children — pages
// render their own <Header>.
export default function SecurityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppShell>
      <SectionNav
        items={[
          { href: "/security", label: "Monitor" },
          { href: "/security/equipo", label: "Equipo" },
        ]}
      />
      {children}
    </AppShell>
  );
}
