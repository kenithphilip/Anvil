// Tests for the customer-portal client (src/v3-app/portal/api.ts): login posts
// credentials + returns a session, view builds the right URL and sends the
// session as a Bearer header (token NOT in the URL).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PortalAPI, getSession } from "./portal/api";

const ok = (payload: any) => async () => ({ ok: true, status: 200, json: async () => payload });

describe("PortalAPI", () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* noop */ } vi.restoreAllMocks(); });

  it("login POSTs { email, password } and returns a session", async () => {
    const fetchMock = vi.fn(ok({ session: { access_token: "JWT1", refresh_token: "R1", expires_at: 123 }, user: { customer_id: "c1", email: "a@b.com", role: "portal_member" } }));
    vi.stubGlobal("fetch", fetchMock);
    const s = await PortalAPI.login("a@b.com", "pw");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/auth/login");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ email: "a@b.com", password: "pw" });
    expect(s.access_token).toBe("JWT1");
    expect(s.customer_id).toBe("c1");
  });

  it("view builds the kind + extra query string", async () => {
    const fetchMock = vi.fn(ok({ spare_matrices: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await PortalAPI.view("spare_matrix", "&matrix_id=m1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/portal/view?kind=spare_matrix&matrix_id=m1");
  });

  it("sends the session as an Authorization: Bearer header (never in the URL)", async () => {
    vi.stubGlobal("fetch", vi.fn(ok({ session: { access_token: "JWT2" }, user: {} })));
    await PortalAPI.login("a@b.com", "pw");
    expect(getSession()?.access_token).toBe("JWT2");   // persisted
    const viewMock = vi.fn(ok({ spare_matrices: [] }));
    vi.stubGlobal("fetch", viewMock);
    await PortalAPI.view("spares");
    const [url, opts] = viewMock.mock.calls[0];
    expect(url).not.toContain("JWT2");                 // token NOT in the URL
    expect(opts.headers.Authorization).toBe("Bearer JWT2");
  });

  it("clears the session on a 401 so the user is bounced to login", async () => {
    vi.stubGlobal("fetch", vi.fn(ok({ session: { access_token: "JWT3" }, user: {} })));
    await PortalAPI.login("a@b.com", "pw");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "Invalid session" } }) })));
    await expect(PortalAPI.me()).rejects.toThrow();
    expect(getSession()).toBeNull();
  });
});
