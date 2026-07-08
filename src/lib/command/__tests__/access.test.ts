import { describe, expect, test } from "bun:test";
import { resolveCommandScope } from "../access";

describe("resolveCommandScope — the v3.0 role/allow-list matrix (spec §a)", () => {
  const W1 = "11111111-1111-1111-1111-111111111111";
  const W2 = "22222222-2222-2222-2222-222222222222";

  test("admin: role=admin, keeps ALL memberships, allow-list ignored", () => {
    const scope = resolveCommandScope({ isAdmin: true, membershipWorkspaceIds: [W1, W2], allowlistRaw: W2 });
    expect(scope).toEqual({ role: "admin", workspaceIds: [W1, W2] });
  });

  test("admin with zero memberships still gets in (today's behavior preserved)", () => {
    const scope = resolveCommandScope({ isAdmin: true, membershipWorkspaceIds: [], allowlistRaw: undefined });
    expect(scope).toEqual({ role: "admin", workspaceIds: [] });
  });

  test("non-admin + unset allow-list → null (fail-closed to today's admin-only posture)", () => {
    expect(resolveCommandScope({ isAdmin: false, membershipWorkspaceIds: [W1], allowlistRaw: undefined })).toBeNull();
  });

  test("non-admin + empty-string allow-list → null (empty ≠ allow-everything)", () => {
    expect(resolveCommandScope({ isAdmin: false, membershipWorkspaceIds: [W1], allowlistRaw: "" })).toBeNull();
  });

  test("operator: memberships filtered to the allow-list intersection", () => {
    const scope = resolveCommandScope({ isAdmin: false, membershipWorkspaceIds: [W1, W2], allowlistRaw: W1 });
    expect(scope).toEqual({ role: "operator", workspaceIds: [W1] });
  });

  test("non-admin whose memberships are all OUTSIDE the allow-list → null, never an empty-scope operator", () => {
    expect(resolveCommandScope({ isAdmin: false, membershipWorkspaceIds: [W1], allowlistRaw: W2 })).toBeNull();
  });

  test("allow-list parsing: commas, whitespace, empty segments", () => {
    const scope = resolveCommandScope({
      isAdmin: false,
      membershipWorkspaceIds: [W1, W2],
      allowlistRaw: ` ${W1} , ,${W2},`,
    });
    expect(scope).toEqual({ role: "operator", workspaceIds: [W1, W2] });
  });

  test("non-admin with no memberships at all → null even with a permissive allow-list", () => {
    expect(resolveCommandScope({ isAdmin: false, membershipWorkspaceIds: [], allowlistRaw: `${W1},${W2}` })).toBeNull();
  });
});
