import { AppSidebar } from "./app-sidebar";
import { CommandPaletteMount } from "./command-palette";

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
 * itself is a client component), so layouts can keep fetching data. The
 * ⌘K / Ctrl+K command palette is mounted via <CommandPaletteMount/> — a
 * tiny client island that owns its own open state + window keydown listener,
 * so this shell never needs "use client".
 *
 * Page rhythm: the main area inherits the themed body background
 * (#09090B dark / #FCFCFC light, set by ThemeProvider) plus a faint top
 * radial accent glow (globals.css `main` rule); children render inside a
 * 1150px centered column with 40px/32px padding.
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
      {/* Global Cmd/Ctrl+K launcher. Renders an overlay only when open. */}
      <CommandPaletteMount />
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
