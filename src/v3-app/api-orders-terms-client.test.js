// The anvil-client methods for the terms check, executed for real
// (test-setup.ts loads the client IIFE; fetch is the only stub), and the
// router serving both paths as static routes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dispatch } from "../api/router.js";

const client = window.AnvilBackend;
const ORDER = "00000000-0000-4000-8000-0000000000d1";

let fetchMock;
beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* no storage: setConfig below still runs */ }
  client.setConfig({ url: "https://api.test", tenantId: "t-1" });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ flags: [] }) }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1];

describe("orders client: terms", () => {
  it("GETs /api/orders/terms, with include_shadow only when asked", async () => {
    await client.orders.terms(ORDER);
    expect(lastCall()[0]).toBe("https://api.test/api/orders/terms?order_id=" + ORDER);
    await client.orders.terms(ORDER, { includeShadow: true });
    expect(lastCall()[0]).toBe("https://api.test/api/orders/terms?order_id=" + ORDER + "&include_shadow=1");
  });

  it("POSTs the re-check to /api/orders/terms_check", async () => {
    await client.orders.termsCheck(ORDER);
    expect(lastCall()[0]).toBe("https://api.test/api/orders/terms_check");
    expect(lastCall()[1].method).toBe("POST");
    expect(JSON.parse(lastCall()[1].body)).toEqual({ order_id: ORDER });
  });

  it("POSTs a decision to /api/orders/terms_decide", async () => {
    await client.orders.termsDecide(ORDER, "flag-1", "request_amendment", "Ask the buyer to cap LD at 5%.");
    expect(lastCall()[0]).toBe("https://api.test/api/orders/terms_decide");
    expect(lastCall()[1].method).toBe("POST");
    expect(JSON.parse(lastCall()[1].body)).toEqual({
      order_id: ORDER, flag_id: "flag-1", decision: "request_amendment", reason: "Ask the buyer to cap LD at 5%.",
    });
  });

  it("all three are static routes the API serves, not an order id", async () => {
    for (const path of ["/api/orders/terms?order_id=" + ORDER, "/api/orders/terms_check", "/api/orders/terms_decide"]) {
      const req = { url: path, method: path.includes("check") ? "POST" : "GET", query: {}, headers: {} };
      const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (o) => { res.body = JSON.stringify(o); return res; };
      res.send = (b) => { res.body = b; return res; };
      try { await dispatch(req, res); } catch (_) { /* the handler may fail without a database */ }
      expect(res.statusCode).not.toBe(404);
      expect(req.query.id).toBeUndefined();
    }
  });
});
