// Tests for the customer_name attach on /api/quotes GET (list). The
// handler used to return raw quote rows, so the screen rendered "—" for
// every customer column. It now does a second .in() lookup against
// customers and stamps `customer: { customer_name }` per row.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ quotes: [], customers: [] }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin", anonymous: false })),
  requirePermission: vi.fn(() => {}),
  hasPermission: () => true,
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

const makeQuery = (resolve) => {
  const state = { filters: {}, op: "select", inField: null, inVals: null };
  const q = {
    select() { return q; },
    eq(k, v) { state.filters[k] = v; return q; },
    in(k, v) { state.inField = k; state.inVals = v; return q; },
    lte() { return q; },
    order() { return q; },
    limit() { return q; },
    then(onF, onR) { return Promise.resolve(resolve(state)).then(onF, onR); },
  };
  return q;
};

const resolver = (table) => (state) => {
  if (table === "quotes") return { data: h.quotes, error: null };
  if (table === "customers") {
    const want = new Set(state.inVals || []);
    return { data: h.customers.filter((c) => want.has(c.id)), error: null };
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

const listQuotes = async () => {
  const req = { method: "GET", headers: {}, query: {}, body: null };
  const res = makeRes();
  await handler(req, res);
  return res.body ? JSON.parse(res.body) : null;
};

beforeEach(() => {
  h.quotes = [];
  h.customers = [];
});

describe("/api/quotes GET — customer_name attach", () => {
  it("attaches customer.customer_name from a single .in() lookup", async () => {
    h.quotes = [
      { id: "q1", customer_id: "c1", quote_number: "Q-1", status: "DRAFT" },
      { id: "q2", customer_id: "c2", quote_number: "Q-2", status: "SENT" },
      { id: "q3", customer_id: "c1", quote_number: "Q-3", status: "DRAFT" },
    ];
    h.customers = [
      { id: "c1", customer_name: "Hyundai Motor India Ltd" },
      { id: "c2", customer_name: "Tata Motors" },
    ];
    const parsed = await listQuotes();
    expect(parsed.quotes).toHaveLength(3);
    expect(parsed.quotes[0].customer.customer_name).toBe("Hyundai Motor India Ltd");
    expect(parsed.quotes[1].customer.customer_name).toBe("Tata Motors");
    expect(parsed.quotes[2].customer.customer_name).toBe("Hyundai Motor India Ltd");
  });

  it("skips the lookup when there are no quotes with customer_id", async () => {
    h.quotes = [{ id: "q1", customer_id: null, quote_number: "Q-1", status: "DRAFT" }];
    const parsed = await listQuotes();
    expect(parsed.quotes).toHaveLength(1);
    expect(parsed.quotes[0].customer).toBeUndefined();
  });

  it("leaves customer unset for rows whose customer_id has no master row", async () => {
    h.quotes = [{ id: "q1", customer_id: "missing", quote_number: "Q-1", status: "DRAFT" }];
    h.customers = []; // customer_id refers to a row that was deleted
    const parsed = await listQuotes();
    expect(parsed.quotes[0].customer).toBeUndefined();
  });
});
