// The anvil-client methods the account-owner screen calls, executed for real
// (test-setup.ts loads the client IIFE; fetch is the only stub). The screen
// tests stub AnvilBackend, so this is where the method-to-route wiring is
// proven: a method that called the wrong path would leave every screen test
// green and the button dead.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const client = window.AnvilBackend;

let fetchMock;
beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* no storage: setConfig below still runs */ }
  client.setConfig({ url: "https://api.test", tenantId: "t-1" });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : null };
};

describe("customers client: account owner", () => {
  it("assignOwner POSTs the payload to /api/customers/owner", async () => {
    await client.customers.assignOwner({ customer_ids: ["cust-1"], owner_user_id: "u-2", move_open_opportunities: false });
    expect(lastCall()).toEqual({
      url: "https://api.test/api/customers/owner",
      method: "POST",
      body: { customer_ids: ["cust-1"], owner_user_id: "u-2", move_open_opportunities: false },
    });
  });

  it("ownerSuggestions GETs suggest=1, optionally for one customer", async () => {
    await client.customers.ownerSuggestions();
    expect(lastCall()).toMatchObject({ url: "https://api.test/api/customers/owner?suggest=1", method: "GET" });
    await client.customers.ownerSuggestions({ customer_id: "cust-1" });
    expect(lastCall().url).toBe("https://api.test/api/customers/owner?suggest=1&customer_id=cust-1");
  });

  it("list passes the owner filter, and is unchanged without one", async () => {
    await client.customers.list({ owner: "me" });
    expect(lastCall().url).toBe("https://api.test/api/customers?owner=me");
    await client.customers.list();
    expect(lastCall().url).toBe("https://api.test/api/customers");
  });
});
