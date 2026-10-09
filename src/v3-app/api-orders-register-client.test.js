// The anvil-client methods the register screen calls, executed for real
// (test-setup.ts loads the client IIFE; fetch is the only stub). The screen
// test stubs AnvilBackend, so this is where the method-to-route wiring is
// proven.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dispatch } from "../api/router.js";

const client = window.AnvilBackend;

let fetchMock;
beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* no storage: setConfig below still runs */ }
  client.setConfig({ url: "https://api.test", tenantId: "t-1" });
  fetchMock = vi.fn(async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ rows: [] }),
    blob: async () => new Blob(["x"]),
    headers: { get: () => 'attachment; filename="SO_register_2026-10-09.xlsx"' },
  }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

const lastUrl = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0];

describe("orders client: register", () => {
  it("GETs /api/orders/register with the filters, dropping empty ones", async () => {
    await client.orders.register({ page: 2, page_size: 50, channel: "email", customer: "", has_flags: "1", status: null });
    expect(lastUrl()).toBe("https://api.test/api/orders/register?page=2&page_size=50&channel=email&has_flags=1");
    await client.orders.register();
    expect(lastUrl()).toBe("https://api.test/api/orders/register");
  });

  it("exports with format=xlsx and the same filters, without the page", async () => {
    const out = await client.orders.registerExportBlob({ page: 3, page_size: 50, channel: "voice", from: "" });
    expect(lastUrl()).toBe("https://api.test/api/orders/register?channel=voice&format=xlsx");
    expect(out.filename).toBe("SO_register_2026-10-09.xlsx");
  });

  it("is a static route the API serves, not an order id", async () => {
    const req = { url: "/api/orders/register?page=1", method: "GET", query: {}, headers: {} };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = JSON.stringify(o); return res; };
    res.send = (b) => { res.body = b; return res; };
    try { await dispatch(req, res); } catch (_) { /* the handler may fail without a database */ }
    expect(res.statusCode).not.toBe(404);
    // The dynamic /orders/<id> route would have injected an id.
    expect(req.query.id).toBeUndefined();
    expect(req.query.page).toBe("1");
  });
});
