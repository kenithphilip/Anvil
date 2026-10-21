// The UI role comes from the server, not from a localStorage default.
//
// Before: RBAC.getRole() read "v3_role" and fell back to sales_engineer. Only
// the top-bar switcher wrote that key, so on a fresh browser an admin saw
// cancel and return for fix disabled ("needs sales_manager / admin") on an
// order the server let them cancel. Now app.tsx reads /api/auth/profile
// (which returns ctx.role) once the session is valid, the switcher can only
// narrow that role, and a failed read means viewer.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import App from "./app";
import { RBAC } from "./lib/rbac";

const realBackend = (window as { AnvilBackend?: unknown }).AnvilBackend;
const w = window as unknown as Record<string, unknown>;
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

const clearRoleKeys = () => {
  for (const k of ["v3_role", "v3_server_role"]) {
    window.localStorage.removeItem("anvil:" + k);
    window.localStorage.removeItem("obara:" + k);
  }
};

const roleMenuItems = async (container: HTMLElement): Promise<string[]> => {
  const trigger = await waitFor(() => {
    const t = container.querySelector<HTMLButtonElement>('button[title="Switch role"]');
    expect(t).not.toBeNull();
    return t as HTMLButtonElement;
  });
  fireEvent.click(trigger);
  return Array.from(container.querySelectorAll('[role="menuitem"]')).map((b) => b.querySelector("span")?.textContent || "");
};

describe("app load: the RBAC role follows the server role", () => {
  let session: { access_token: string; expires_at: number } | null = null;
  let getProfile: () => Promise<unknown>;
  let profileCalls = 0;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    window.location.hash = "#/home";
    clearRoleKeys();
    window.localStorage.removeItem("anvil:auth_profile");
    session = { access_token: "tok", expires_at: FUTURE };
    profileCalls = 0;
    w.AnvilBackend = {
      isReady: () => true,
      getConfig: () => ({}),
      setSession: () => undefined,
      getSession: () => session,
      health: async () => ({}),
      auth: { getProfile: () => { profileCalls += 1; return getProfile(); } },
    };
  });

  afterEach(() => { cleanup(); w.AnvilBackend = realBackend; clearRoleKeys(); });

  it("a server admin on a fresh browser gets admin, so cancel is allowed", async () => {
    getProfile = async () => ({ user: { email: "a@example.test" }, memberships: [], role: "admin" });
    expect(RBAC.role()).toBe("viewer");
    render(<App />);
    await waitFor(() => expect(RBAC.role()).toBe("admin"));
    expect(RBAC.canDo("so.cancel")).toBe(true);
  });

  it("re-reads the role on every load, even with a cached profile", async () => {
    // The old effect skipped the read when auth_profile was cached.
    window.localStorage.setItem("anvil:auth_profile", JSON.stringify({ user: { email: "a@example.test" } }));
    window.localStorage.setItem("anvil:v3_server_role", "sales_engineer");
    getProfile = async () => ({ user: { email: "a@example.test" }, memberships: [], role: "sales_manager" });
    render(<App />);
    await waitFor(() => expect(RBAC.role()).toBe("sales_manager"));
    expect(profileCalls).toBeGreaterThan(0);
  });

  it("fails closed to viewer when the profile read fails, over a cached admin", async () => {
    window.localStorage.setItem("anvil:v3_server_role", "admin");
    getProfile = async () => { throw new Error("network"); };
    render(<App />);
    await waitFor(() => expect(RBAC.role()).toBe("viewer"));
    expect(RBAC.canDo("so.cancel")).toBe(false);
  });

  it("a profile with no role is viewer", async () => {
    window.localStorage.setItem("anvil:v3_server_role", "admin");
    getProfile = async () => ({ user: { email: "a@example.test" }, memberships: [] });
    render(<App />);
    await waitFor(() => expect(RBAC.role()).toBe("viewer"));
  });

  it("reads the role when the user signs in in this tab", async () => {
    session = null;
    getProfile = async () => ({ user: { email: "a@example.test" }, memberships: [], role: "finance" });
    render(<App />);
    expect(profileCalls).toBe(0);
    session = { access_token: "tok", expires_at: FUTURE };
    await act(async () => { window.dispatchEvent(new CustomEvent("anvil:session")); });
    await waitFor(() => expect(RBAC.role()).toBe("finance"));
  });

  it("the switcher offers only the server role and viewer to a non-admin", async () => {
    getProfile = async () => ({ user: { email: "a@example.test" }, memberships: [], role: "sales_engineer" });
    const { container } = render(<App />);
    await waitFor(() => expect(RBAC.role()).toBe("sales_engineer"));
    const items = await roleMenuItems(container);
    expect(items).toHaveLength(2);
    expect(items.join(" ").toLowerCase()).not.toContain("admin");
  });

  it("the switcher offers every role to a server admin", async () => {
    getProfile = async () => ({ user: { email: "a@example.test" }, memberships: [], role: "admin" });
    const { container } = render(<App />);
    await waitFor(() => expect(RBAC.role()).toBe("admin"));
    const items = await roleMenuItems(container);
    expect(items).toHaveLength(RBAC.ROLES.length);
  });
});
