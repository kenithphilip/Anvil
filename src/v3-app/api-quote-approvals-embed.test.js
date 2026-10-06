// Regression test for the Approvals queue embed/flatten in
// src/api/admin/quote_approvals.js (?type=approvals GET).
//
// Bug: the endpoint did select("*") on quote_approvals, whose schema
// (migration 006) has NO po_number / customer_name / order_mode /
// value_inr / margin_pct columns. The Approvals queue UI reads those
// fields, so every column rendered "—".
//
// Fix: embed order:order_id(... customer:customer_id(...)) and flatten
// the fields the UI expects, deriving line_count / value_inr /
// margin_pct from the order's result JSONB.
//
// These tests lock:
//   - the select() carries the nested order+customer embed (so a
//     future bare select("*") regression is caught)
//   - the response rows are flattened to the UI's expected shape
//   - empty / missing order data degrades gracefully (line_count 0,
//     value_inr null) instead of throwing
//   - raw quote_approvals columns (id, status, comments) survive

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: [],         // what the documents/quote_approvals query returns
  lastSelect: null, // captures the select() string
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => {}),
}));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: vi.fn(() => ({
    from: (table) => {
      const q = {
        _table: table,
        select: (sel) => { h.lastSelect = sel; return q; },
        eq: () => q,
        order: () => q,
        limit: () => q,
        // awaited at the end of the chain
        then: (resolve) => resolve({ data: h.rows, error: null }),
      };
      return q;
    },
  })),
}));

const { default: handler } = await import("../api/admin/quote_approvals.js");

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  send(p) { this.body = p; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  end() { return this; },
});

const run = async () => {
  const req = { method: "GET", headers: {}, query: { type: "approvals" } };
  const res = makeRes();
  await handler(req, res);
  return JSON.parse(res.body);
};

beforeEach(() => {
  h.rows = [];
  h.lastSelect = null;
});

describe("quote_approvals ?type=approvals embed + flatten", () => {
  it("selects the nested order + customer embed (not a bare *)", async () => {
    await run();
    expect(h.lastSelect).toContain("order:order_id(");
    expect(h.lastSelect).toContain("customer:customer_id(");
    expect(h.lastSelect).toContain("po_number");
    expect(h.lastSelect).toContain("customer_name");
    expect(h.lastSelect).not.toBe("*");
  });

  it("flattens po_number, customer_name, order_mode, line_count, value_inr, margin_pct", async () => {
    h.rows = [{
      id: "ap-1", order_id: "ord-1", status: "PENDING", comments: "needs sign-off",
      order: {
        po_number: "P250432265",
        quote_number: null,
        order_mode: "PROJECT_HSS",
        created_at: "2026-05-20T00:00:00Z",
        // Margin comes from priceComposition, not from a marginPct field on
        // salesOrder. An earlier version of this test INVENTED that field in
        // the fixture and asserted it back — which is why the queue shipped
        // with a margin column that was blank on every real row: nothing
        // writes marginPct, and no test noticed because the fixture supplied
        // it. Selling 3 x 100 = 300, landed 3 x 70 = 210, margin 30%.
        result: {
          salesOrder: {
            grandTotal: 696960,
            lineItems: [
              { sellerPartNo: "A", qty: 1, rate: 100 },
              { sellerPartNo: "B", qty: 1, rate: 100 },
              { sellerPartNo: "C", qty: 1, rate: 100 },
            ],
          },
          priceComposition: {
            lineItems: [
              { partNumber: "A", landedCostINR: 70 },
              { partNumber: "B", landedCostINR: 70 },
              { partNumber: "C", landedCostINR: 70 },
            ],
          },
        },
        customer: { customer_name: "Industrias Gogiba S.L", gstin: "27AAACA1234B1Z5", state_code: "27" },
      },
    }];
    const out = await run();
    expect(out.approvals).toHaveLength(1);
    const a = out.approvals[0];
    expect(a.po_number).toBe("P250432265");
    expect(a.customer_name).toBe("Industrias Gogiba S.L");
    expect(a.order_mode).toBe("PROJECT_HSS");
    expect(a.line_count).toBe(3);
    expect(a.value_inr).toBe(696960);
    expect(a.margin_pct).toBeCloseTo(30, 6);
    expect(a.margin_state).toBe("computed");
    expect(a.gstin).toBe("27AAACA1234B1Z5");
    expect(a.state_code).toBe("27");
    // raw quote_approvals columns survive
    expect(a.id).toBe("ap-1");
    expect(a.status).toBe("PENDING");
    expect(a.comments).toBe("needs sign-off");
    // the nested embed object is not leaked as `order`
    expect(a.order).toBeUndefined();
  });

  it("reports NOT COSTED rather than a bare null when there is no price composition", async () => {
    // This test used to assert that a snake_case margin_pct on salesOrder was
    // read when the camel one was absent. Neither is written by anything, so
    // it was locking in a belief rather than a behaviour. The honest answer
    // for an uncosted order is that the margin is unknown — which an approver
    // must be able to tell apart from a thin one.
    h.rows = [{
      id: "ap-2", order_id: "ord-2", status: "PENDING",
      order: { po_number: "X", result: { salesOrder: { grandTotal: 100, lineItems: [{ sellerPartNo: "A", qty: 1, rate: 100 }] } }, customer: null },
    }];
    const out = await run();
    expect(out.approvals[0].margin_pct).toBeNull();
    expect(out.approvals[0].margin_state).toBe("not_costed");
  });

  it("flags a PARTIALLY costed order with its coverage", async () => {
    // Margin over 1 of 2 lines is not the order's margin.
    h.rows = [{
      id: "ap-2b", order_id: "ord-2b", status: "PENDING",
      order: {
        po_number: "X2", customer: null,
        result: {
          salesOrder: { lineItems: [{ sellerPartNo: "A", qty: 1, rate: 100 }, { sellerPartNo: "B", qty: 1, rate: 100 }] },
          priceComposition: { lineItems: [{ partNumber: "A", landedCostINR: 50 }] },
        },
      },
    }];
    const out = await run();
    expect(out.approvals[0].margin_state).toBe("partial");
    expect(out.approvals[0].margin_lines_matched).toBe(1);
    expect(out.approvals[0].margin_lines_total).toBe(2);
  });

  it("degrades gracefully when the order has no result / no lines", async () => {
    h.rows = [{
      id: "ap-3", order_id: "ord-3", status: "PENDING",
      order: { po_number: "Y", order_mode: "SPARES", result: {}, customer: { customer_name: "Acme" } },
    }];
    const out = await run();
    const a = out.approvals[0];
    expect(a.line_count).toBe(0);
    expect(a.value_inr).toBeNull();
    expect(a.margin_pct).toBeNull();
    expect(a.margin_state).toBe("not_costed");
    expect(a.po_number).toBe("Y");
    expect(a.customer_name).toBe("Acme");
  });

  it("degrades gracefully when the order embed is null (orphaned approval)", async () => {
    h.rows = [{ id: "ap-4", order_id: "missing", status: "PENDING", order: null }];
    const out = await run();
    const a = out.approvals[0];
    expect(a.po_number).toBeNull();
    expect(a.customer_name).toBeNull();
    expect(a.line_count).toBe(0);
    expect(a.value_inr).toBeNull();
    expect(a.id).toBe("ap-4");
  });
});
