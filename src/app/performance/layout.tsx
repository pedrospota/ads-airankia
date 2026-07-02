import { AppShell } from "@/components/app-shell";
import { SectionNav } from "@/components/section-nav";

// Section layout: global sidebar (AppShell) + sub-nav bar + children. It also
// wraps the account detail pages (/performance/[id]) — pages render their own
// <Header>.
export default function PerformanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppShell>
      <SectionNav
        items={[
          { href: "/performance", label: "Cockpit" },
          { href: "/performance/recomendaciones", label: "Recomendaciones" },
          { href: "/performance/simulacion", label: "Simulación" },
          { href: "/performance/backtest", label: "Backtest" },
          { href: "/performance/costos", label: "Costos" },
          { href: "/performance/salud", label: "Salud" },
        ]}
      />
      {children}
    </AppShell>
  );
}
