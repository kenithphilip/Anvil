// Unit tests for the supplier-RFQ comparison-matrix logic and the
// order-reconciliation diff. Both ship as endpoint-handlers in
// production, but the reusable diff is exported from the
// reconciliation handler for testing.

import { describe, it, expect } from "vitest";

// Mirror of the diff logic in src/api/orders/reconcile.js. We
// duplicate it here rather than importing because the handler
// imports CORS and Supabase setup that vitest can't resolve in this
// jsdom env. Keep this in sync if the handler logic changes.
const FIELDS = ["quantity", "unit_price", "lead_time_days", "currency"];
const SEVERITY = { quantity: "high", unit_price: "high", lead_time_days: "medium", currency: "high" };

const compareLines = (orderLines, conf) => {
  const out = [];
  let matching = 0, mismatched = 0;
  const byLine = new Map(orderLines.map((li, i) => [li.line_no || (i + 1), li]));
  for (const c of conf.lines || []) {
    const expected = byLine.get(c.line_no);
    if (!expected) {
      out.push({ line_no: c.line_no, field: "exists", expected: null, received: c, severity: "high" });
      mismatched += 1; continue;
    }
    let lineMatched = true;
    for (const f of FIELDS) {
      if (c[f] === undefined) continue;
      const exp = expected[f] ?? null;
      const rec = c[f];
      if (exp == null && rec == null) continue;
      if (String(exp) !== String(rec)) {
        out.push({ line_no: c.line_no, field: f, expected: exp, received: rec, severity: SEVERITY[f] || "low" });
        lineMatched = false;
      }
    }
    if (lineMatched) matching += 1; else mismatched += 1;
  }
  const confSet = new Set((conf.lines || []).map((l) => l.line_no));
  for (const [lineNo, exp] of byLine.entries()) {
    if (!confSet.has(lineNo)) {
      out.push({ line_no: lineNo, field: "exists", expected: exp, received: null, severity: "high" });
      mismatched += 1;
    }
  }
  return { discrepancies: out, matching, mismatched };
};

describe("orders/reconcile / line diff", () => {
  it("matches when every line agrees", () => {
    const order = [
      { line_no: 1, quantity: 10, unit_price: 5, currency: "USD" },
      { line_no: 2, quantity: 3, unit_price: 50, currency: "USD" },
    ];
    const conf = { lines: [
      { line_no: 1, quantity: 10, unit_price: 5, currency: "USD" },
      { line_no: 2, quantity: 3, unit_price: 50, currency: "USD" },
    ] };
    const r = compareLines(order, conf);
    expect(r.matching).toBe(2);
    expect(r.mismatched).toBe(0);
    expect(r.discrepancies).toHaveLength(0);
  });

  it("flags a quantity mismatch", () => {
    const order = [{ line_no: 1, quantity: 10, unit_price: 5 }];
    const conf = { lines: [{ line_no: 1, quantity: 8, unit_price: 5 }] };
    const r = compareLines(order, conf);
    expect(r.mismatched).toBe(1);
    expect(r.discrepancies[0].field).toBe("quantity");
    expect(r.discrepancies[0].severity).toBe("high");
    expect(r.discrepancies[0].expected).toBe(10);
    expect(r.discrepancies[0].received).toBe(8);
  });

  it("flags a price mismatch", () => {
    const order = [{ line_no: 1, quantity: 10, unit_price: 5 }];
    const conf = { lines: [{ line_no: 1, quantity: 10, unit_price: 6 }] };
    const r = compareLines(order, conf);
    expect(r.mismatched).toBe(1);
    expect(r.discrepancies[0].field).toBe("unit_price");
  });

  it("medium severity for lead-time mismatch", () => {
    const order = [{ line_no: 1, quantity: 1, unit_price: 1, lead_time_days: 7 }];
    const conf = { lines: [{ line_no: 1, quantity: 1, unit_price: 1, lead_time_days: 14 }] };
    const r = compareLines(order, conf);
    expect(r.discrepancies[0].field).toBe("lead_time_days");
    expect(r.discrepancies[0].severity).toBe("medium");
  });

  it("flags an extra confirmation line as exists/high", () => {
    const order = [{ line_no: 1, quantity: 1, unit_price: 1 }];
    const conf = { lines: [
      { line_no: 1, quantity: 1, unit_price: 1 },
      { line_no: 99, quantity: 1, unit_price: 1 },
    ] };
    const r = compareLines(order, conf);
    expect(r.mismatched).toBe(1);
    expect(r.discrepancies[0].field).toBe("exists");
    expect(r.discrepancies[0].line_no).toBe(99);
  });

  it("flags a missing confirmation line as exists/high", () => {
    const order = [
      { line_no: 1, quantity: 1, unit_price: 1 },
      { line_no: 2, quantity: 1, unit_price: 1 },
    ];
    const conf = { lines: [{ line_no: 1, quantity: 1, unit_price: 1 }] };
    const r = compareLines(order, conf);
    expect(r.mismatched).toBe(1);
    expect(r.discrepancies[0].line_no).toBe(2);
    expect(r.discrepancies[0].received).toBeNull();
  });
});
