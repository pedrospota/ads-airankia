import { AppShell } from "@/components/app-shell";
import { SpyShell } from "@/components/spy-shell";

// Global sidebar OUTSIDE the spy shell: SpyShell keeps its own internal tools
// sidebar; AppShell just adds the cross-section column to its left.
export default function SpyLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <SpyShell>{children}</SpyShell>
    </AppShell>
  );
}
