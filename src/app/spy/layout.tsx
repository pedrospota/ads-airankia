import { SpyShell } from "@/components/spy-shell";

export default function SpyLayout({ children }: { children: React.ReactNode }) {
  return <SpyShell>{children}</SpyShell>;
}
