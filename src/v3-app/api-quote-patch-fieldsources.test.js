// Tests for the quote PATCH path: extended editFields (restores the
// silently-dropped 106-era header fields) + operator_override stamps on
// field_sources.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  current: null, // the existing quote row returned by maybeSingle
  updated: null, // the patch payload captured on update
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
  const state = { filters: {}, op: "select", payload: null };
  const q = {
    select() { return q; },
    eq(k, v) { state.filters[k] = v; return q; },
    update(p) { state.op = "update"; state.payload = p; return q; },
    maybeSingle() { return Promise.resolve(resolve(state, "maybeSingle")); },
    single() { return Promise.resolve(resolve(state, "single")); },
    then(onF, onR) { return Promise.resolve(resolve(state, "list")).then(onF, onR); },
  };
  return q;
};

const resolver = (table) => (state, mode) => {
  if (table !== "quotes") return { data: [], error: null };
  if (state.op === "update") {
    h.updated = { ...h.current, ...state.payload };
    return { data: h.updated, error: null };
  }
  return { data: h.current, error: null };
};

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: vi.fn(() => ({ from: (t) => makeQuery(resolver(t)) })),
}));

vi.mock("../api/_lib/quote-margin.js", () => ({
  belowFloorLines: vi.fn(async () => []),
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

const patch = async (body) => {
  const req = { method: "PATCH", headers: {}, query: { id: "q-1" }, body };
  const res = makeRes();
  await handler(req, res);
  return { res, parsed: res.body ? JSON.parse(res.body) : null };
};

beforeEach(() => {
  h.current = {
    id: "q-1", tenant_id: "t-1", status: "DRAFT",
    quote_number: "Q-1", version: 1, currency: "INR", validity_days: 30,
    your_ref: null, attention_contact: null, template_id: null,
    fx_snapshot: null, conversion_factor: null,
    customer_contact_id: null, field_sources: {},
  };
  h.updated = null;
  h.audits = [];
});

describe("PATCH /api/quotes — restored editFields persist", () => {
  it("persists attention_contact (previously silently dropped)", async () => {
    const { res } = await patch({ attention_contact: "Mr. Prashant Shinde" });
    expect(res.statusCode).toBe(200);
    expect(h.updated.attention_contact).toBe("Mr. Prashant Shinde");
  });

  it("persists your_ref / template_id / fx_snapshot / conversion_factor", async () => {
    const { res } = await patch({
      your_ref: "RFQ-2026-Q1",
      template_id: "tpl-1",
      fx_snapshot: { INR: 1, USD: 83.5 },
      conversion_factor: 1.63,
    });
    expect(res.statusCode).toBe(200);
    expect(h.updated.your_ref).toBe("RFQ-2026-Q1");
    expect(h.updated.template_id).toBe("tpl-1");
    expect(h.updated.fx_snapshot).toEqual({ INR: 1, USD: 83.5 });
    expect(h.updated.conversion_factor).toBe(1.63);
  });
});

describe("PATCH /api/quotes — field_sources operator_override", () => {
  it("stamps operator_override for each changed editField", async () => {
    const { res } = await patch({ attention_contact: "Asha Rao", your_ref: "RFQ-7" });
    expect(res.statusCode).toBe(200);
    expect(h.updated.field_sources).toMatchObject({
      attention_contact: "operator_override",
      your_ref: "operator_override",
    });
  });

  it("does not stamp override when the body re-sends the same value", async () => {
    h.current.currency = "USD";
    const { res } = await patch({ currency: "USD" });
    expect(res.statusCode).toBe(200);
    expect(h.updated.field_sources?.currency).toBeUndefined();
  });

  it("merges into existing field_sources without clobbering prior entries", async () => {
    h.current.field_sources = { currency: "customer.currency", validity_days: "customer.default_quote_validity_days" };
    const { res } = await patch({ attention_contact: "Asha Rao" });
    expect(res.statusCode).toBe(200);
    expect(h.updated.field_sources).toMatchObject({
      currency: "customer.currency",
      validity_days: "customer.default_quote_validity_days",
      attention_contact: "operator_override",
    });
  });

  it("blocks edits on non-DRAFT quotes with 409 (unchanged behaviour)", async () => {
    h.current.status = "SENT";
    const { res } = await patch({ attention_contact: "Asha Rao" });
    expect(res.statusCode).toBe(409);
  });
});
