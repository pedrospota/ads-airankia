import { AppSidebar } from "./app-sidebar";
import { CommandPaletteMount } from "./command-palette";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { isAdminEmail } from "@/lib/admin";

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
export async function AppShell({ children }: { children: React.ReactNode }) {
  // Centro de Mando (beta): only computed when the flag is on, and only
  // ever true for admins — keeps the nav/palette byte-unchanged otherwise.
  let commandCenter = false;
  if (process.env.COMMAND_CENTER_BETA === "true") {
    const authClient = await createSupabaseServerClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    commandCenter = Boolean(user?.email && isAdminEmail(user.email));
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        minHeight: "100vh",
      }}
    >
      <AppSidebar commandCenter={commandCenter} />
      {/* Global Cmd/Ctrl+K launcher. Renders an overlay only when open. */}
      <CommandPaletteMount commandCenter={commandCenter} />
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
