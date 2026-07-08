import { AppSidebar } from "./app-sidebar";
import { CommandPaletteMount } from "./command-palette";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { isAdminEmail } from "@/lib/admin";
import { getCommandAccess } from "@/lib/command/access";

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
  // v3.0: commandCenter now includes allow-listed operators, not only admins.
  // isPlatformAdmin gates the Admin nav item; it must be computed even when
  // getCommandAccess() is null (admin with the beta flag off, or a plain
  // logged-in user) — hence the fallback auth read.
  const access = await getCommandAccess();
  const commandCenter = Boolean(access);
  let isPlatformAdmin = access?.role === "admin";
  if (!access) {
    const authClient = await createSupabaseServerClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    isPlatformAdmin = Boolean(user?.email && isAdminEmail(user.email));
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
      <AppSidebar commandCenter={commandCenter} isPlatformAdmin={isPlatformAdmin} />
      {/* Global Cmd/Ctrl+K launcher. Renders an overlay only when open. */}
      <CommandPaletteMount commandCenter={commandCenter} isPlatformAdmin={isPlatformAdmin} />
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
