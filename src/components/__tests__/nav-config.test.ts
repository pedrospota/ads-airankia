import { describe, expect, test } from "bun:test";
import { navGroups, paletteDestinations } from "../nav-config";

const allHrefs = (groups: ReturnType<typeof navGroups>) =>
  groups.flatMap((g) => g.items.map((i) => i.href));

describe("navGroups — role-aware nav (spec §a finding #1)", () => {
  test("plain user: no /admin, no /command", () => {
    const hrefs = allHrefs(navGroups(false, false));
    expect(hrefs).not.toContain("/admin");
    expect(hrefs.some((h) => h.startsWith("/command"))).toBe(false);
  });

  test("operator (commandCenter, NOT platform admin): /command yes, /admin NEVER", () => {
    const hrefs = allHrefs(navGroups(true, false));
    expect(hrefs).toContain("/command");
    expect(hrefs).not.toContain("/admin");
  });

  test("platform admin with command: both", () => {
    const hrefs = allHrefs(navGroups(true, true));
    expect(hrefs).toContain("/command");
    expect(hrefs).toContain("/admin");
  });

  test("platform admin with beta off: /admin still visible (nav must not regress for admins)", () => {
    const hrefs = allHrefs(navGroups(false, true));
    expect(hrefs).toContain("/admin");
    expect(hrefs.some((h) => h.startsWith("/command"))).toBe(false);
  });

  test("Conexiones stays in Cuenta for everyone (only Admin was gated)", () => {
    expect(allHrefs(navGroups(false, false))).toContain("/conexiones");
  });
});

describe("paletteDestinations — same matrix for ⌘K", () => {
  const hrefs = (cc: boolean, admin: boolean) => paletteDestinations(cc, admin).map((d) => d.href);

  test("operator: command destinations yes, /admin never", () => {
    expect(hrefs(true, false)).toContain("/command");
    expect(hrefs(true, false)).not.toContain("/admin");
  });

  test("plain user: neither", () => {
    expect(hrefs(false, false)).not.toContain("/admin");
    expect(hrefs(false, false)).not.toContain("/command");
  });

  test("admin: both", () => {
    expect(hrefs(true, true)).toContain("/admin");
    expect(hrefs(true, true)).toContain("/command");
  });
});
