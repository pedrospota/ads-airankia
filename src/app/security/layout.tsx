import { SectionNav } from "@/components/section-nav";

// Thin section layout: just the sub-nav bar + children — pages render their
// own <Header>.
export default function SecurityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SectionNav
        items={[
          { href: "/security", label: "Monitor" },
          { href: "/security/equipo", label: "Equipo" },
        ]}
      />
      {children}
    </>
  );
}
