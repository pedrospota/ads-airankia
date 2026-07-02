import { AppSidebar } from "./app-sidebar";

/**
 * Global app shell: persistent left sidebar + content column.
 *
 * NOT wired into the root layout on purpose — login/landing stay clean.
 * Section layouts opt in:
 *
 *   import { AppShell } from "@/components/app-shell";
 *   ...
 *   return <AppShell>{children}</AppShell>;
 *
 * Server-component friendly (this file has no "use client"; the sidebar
 * itself is a client component), so layouts can keep fetching data.
 *
 * Page rhythm: the main area inherits the themed body background
 * (#0A0A0B dark / #FFFFFF light, set by ThemeProvider); children render
 * inside a 1150px centered column with 40px/32px padding.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        minHeight: "100vh",
      }}
    >
      <AppSidebar />
      <main style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            maxWidth: 1150,
            margin: "0 auto",
            padding: "40px 32px",
          }}
        >
          {children}
        </div>
      </main>
    </div>
  );
}
