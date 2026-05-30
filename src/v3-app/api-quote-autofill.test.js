// Tests for the customer-default auto-fill on quote create
// (/api/quotes POST). The handler falls back currency + validity_days
// from the customer when the body omits them, and records a
// `quote_auto_populate` audit listing which fields were filled.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  customer: null,
  inserted: null,
  audits: [],
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin", anonymous: false })),
  requirePermission: vi.fn(() => {}),
  hasPermission: () => true,
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async (_ctx, a) => { h.audits.push(a); }),
  recordEvent: vi.fn(async () => {}),
}));

const makeQuery = (resolve) => {
  const state = { filters: {}, op: "select", payload: null, count: false };
  const q = {
    select(_cols, opts) { if (opts && opts.head) state.count = true; return q; },
    eq(k, v) { state.filters[k] = v; return q; },
    like() { return q; },
    insert(p) { state.op = "insert"; state.payload = p; return q; },
    maybeSingle() { return Promise.resolve(resolve(state, "maybeSingle")); },
    single() { return Promise.resolve(resolve(state, "single")); },
    then(onF, onR) { return Promise.resolve(resolve(state, "list")).then(onF, onR); },
  };
  return q;
};

const resolver = (table) => (state, mode) => {
  if (table === "customers") {
    return { data: h.customer, error: null };
  }
  if (table === "quotes") {
    if (state.count) return { count: 0, error: null }; // generateQuoteNumber count
    if (state.op === "insert") {
      h.inserted = { id: "q-new", ...state.payload };
      return { data: h.inserted, error: null };
    }
    return { data: null, error: null };
  }
  return { data: [], error: null };
};

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: vi.fn(() => ({ from: (t) => makeQuery(resolver(t)) })),
}));

const { default: handler } = await import("../api/quotes/index.js");

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  send(p) { this.body = p; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  end() { return this; },
});

const post = async (body) => {
  const req = { method: "POST", headers: {}, query: {}, body };
  const res = makeRes();
  await handler(req, res);
  return { res, parsed: res.body ? JSON.parse(res.body) : null };
};

beforeEach(() => {
  h.customer = null;
  h.inserted = null;
  h.audits = [];
});

describe("POST /api/quotes — customer-default auto-fill", () => {
  it("fills currency + validity_days from customer when body omits both", async () => {
    h.customer = { currency: "USD", default_quote_validity_days: 45 };
    const { res } = await post({ customer_id: "c-1" });
    expect(res.statusCode).toBe(201);
    expect(h.inserted.currency).toBe("USD");
    expect(h.inserted.validity_days).toBe(45);
    const ap = h.audits.find((a) => a.action === "quote_auto_populate");
    expect(ap).toBeTruthy();
    expect(ap.after.auto_filled).toMatchObject({
      currency: "customer.currency",
      validity_days: "customer.default_quote_validity_days",
    });
  });

  it("explicit body values win over customer defaults (and no auto-populate audit)", async () => {
    h.customer = { currency: "USD", default_quote_validity_days: 45 };
    const { res } = await post({ customer_id: "c-1", currency: "INR", validity_days: 30 });
    expect(res.statusCode).toBe(201);
    expect(h.inserted.currency).toBe("INR");
    expect(h.inserted.validity_days).toBe(30);
    expect(h.audits.some((a) => a.action === "quote_auto_populate")).toBe(false);
  });

  it("partial fill: body has currency, validity fills from customer (only that field audited)", async () => {
    h.customer = { currency: "USD", default_quote_validity_days: 45 };
    const { res } = await post({ customer_id: "c-1", currency: "EUR" });
    expect(res.statusCode).toBe(201);
    expect(h.inserted.currency).toBe("EUR");
    expect(h.inserted.validity_days).toBe(45);
    const ap = h.audits.find((a) => a.action === "quote_auto_populate");
    expect(ap.after.auto_filled).toEqual({ validity_days: "customer.default_quote_validity_days" });
  });

  it("falls back to hardcoded defaults (INR/30) when the customer has no defaults", async () => {
    h.customer = { currency: null, default_quote_validity_days: null };
    const { res } = await post({ customer_id: "c-1" });
    expect(res.statusCode).toBe(201);
    expect(h.inserted.currency).toBe("INR");
    expect(h.inserted.validity_days).toBe(30);
    expect(h.audits.some((a) => a.action === "quote_auto_populate")).toBe(false);
  });
});
