// A quote_variance line must not reach Tally.
//
// It is a line an operator added because the QUOTE owes it, not because the
// customer ordered it. Pushing it creates a voucher for goods the buyer never
// authorised on their PO.
//
// The gate is at the PUSH, not at approval, and deliberately so: an approver
// can legitimately approve an order carrying a known variance while chasing a
// PO amendment. Push is the point of no return.

import { describe, it, expect, vi, beforeEach } from "vitest";

let orderRow = null;

const chainable = () => {
  const api = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "then") return (resolve) => resolve({ data: [], error: null });
      if (prop === "maybeSingle" || prop === "single") return async () => ({ data: orderRow, error: null });
      return () => api;
    },
  });
  return api;
};

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => chainable() }));
// The bridge-config check runs BEFORE the order read, so without this the
// handler 409s on BRIDGE_NOT_CONFIGURED and never reaches the gate under test.
vi.mock("../api/_lib/tally-client.js", () => ({
  tallyResolveCompany: async () => ({
    id: "tc1", bridge_url: "https://bridge.example", company_name: "ACME",
    default_sales_voucher_type: "Sales",
  }),
  // Never actually reached in these cases; present so the import resolves.
  tallyPush: async () => ({ ok: true, data: {} }),
  tallyIsRecoverable: () => false,
}));
vi.mock("../api/_lib/tally-voucher-type.js", () => ({ resolveSalesVoucherType: () => "Sales" }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: "t1", user: { id: "u1" }, role: "admin" }),
  requirePermission: () => true,
}));
vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false,
  readBody: async (req) => req.body,
  json: (res, status, body) => { res.__status = status; res.__body = body; return res; },
  sendError: (res, err) => { res.__status = 500; res.__body = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {} }));

const APPROVED = {
  id: "o1", tenant_id: "t1", po_number: "0066026562",
  approval: { payloadHash: "hash-1" }, payload_hash: "hash-1",
  status: "APPROVED", customer_gstin: "27AAACM3025E1ZZ",
};
const withLines = (lineItems) => ({ ...APPROVED, result: { salesOrder: { lineItems } } });

const push = async () => {
  const handler = (await import("../api/tally/push.js")).default;
  const req = { method: "POST", headers: {}, body: { orderId: "o1" }, on: () => {} };
  const res = { setHeader: () => {}, end: () => {}, __status: 0, __body: null };
  await handler(req, res);
  return res;
};

beforeEach(() => { vi.clearAllMocks(); });

describe("the gate", () => {
  it("blocks the push with 409 when a variance line is present", async () => {
    orderRow = withLines([
      { partNumber: "P-1", quantity: 1, unitPrice: 100 },
      { partNumber: "P-2", quantity: 1, unitPrice: 200, _origin: "quote_variance" },
    ]);
    const res = await push();
    expect(res.__status).toBe(409);
    expect(res.__body.error.code).toBe("quote_variance_unresolved");
  });

  it("names the offending lines so the operator knows what to resolve", async () => {
    orderRow = withLines([{ partNumber: "P-2", _origin: "quote_variance" }]);
    const res = await push();
    expect(res.__body.error.lines).toEqual(["P-2"]);
  });

  it("says what resolution looks like, not just that it refused", async () => {
    orderRow = withLines([{ partNumber: "P-2", _origin: "quote_variance" }]);
    const res = await push();
    expect(res.__body.error.message).toMatch(/amends the PO|removed/i);
  });

  it("counts correctly when several lines are unresolved", async () => {
    orderRow = withLines([
      { partNumber: "P-2", _origin: "quote_variance" },
      { partNumber: "P-3", _origin: "quote_variance" },
    ]);
    const res = await push();
    expect(res.__body.error.message).toMatch(/^2 lines are/);
  });
});

describe("what the gate must NOT block", () => {
  it("lets an ordinary extracted order through", async () => {
    orderRow = withLines([{ partNumber: "P-1", quantity: 1, unitPrice: 100 }]);
    const res = await push();
    expect(res.__status).not.toBe(409);
  });

  it("lets an operator_recovered line through — that one IS on the PO", async () => {
    // The whole point of the two origins: a recovered line is something the
    // document says and extraction missed. It is invoice-able.
    orderRow = withLines([
      { partNumber: "P-1", quantity: 1, unitPrice: 100 },
      { partNumber: "P-45", quantity: 1, unitPrice: 20070, _origin: "operator_recovered" },
    ]);
    const res = await push();
    expect(res.__status).not.toBe(409);
  });

  it("does not trip on an order with no lines recorded at all", async () => {
    orderRow = { ...APPROVED, result: {} };
    const res = await push();
    expect(res.__body?.error?.code).not.toBe("quote_variance_unresolved");
  });

  it("still enforces the pre-existing approval guard first", async () => {
    // A variance check must not accidentally let an unapproved order past.
    orderRow = { ...withLines([{ partNumber: "P-1" }]), approval: null };
    const res = await push();
    expect(res.__status).toBe(409);
    expect(res.__body.error.message).toMatch(/approval/i);
  });
});
