// The quote header must be rolled up from the PERSISTED quote_lines rows.
//
// Regression: a quote created empty (NewQuoteModal sends no lines) got
// subtotal/tax_total/grand_total = 0 from computeTotals([]). The drawer then
// wrote lines to the quote_lines TABLE only, and nothing recomputed the header
// -- so quotes/send.js emailed the customer "for INR 0.00" no matter what was
// on the quote.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { totalsFromQuoteLines, refreshQuoteTotals } from "../api/quotes/_lib/quote-build.js";

describe("totalsFromQuoteLines", () => {
  it("sums line_amount and the per-component GST percentages (migration 108 shape)", () => {
    const t = totalsFromQuoteLines([
      { qty: 5, listed_unit_price: 100, line_amount: 500, cgst_pct: 9, sgst_pct: 9 },
      { qty: 2, listed_unit_price: 250, line_amount: 500, igst_pct: 18 },
    ]);
    expect(t.subtotal).toBe(1000);
    expect(t.tax_total).toBe(180);      // 500*18% + 500*18%
    expect(t.grand_total).toBe(1180);
  });

  it("prefers line_amount (already discounted) over qty x price", () => {
    const t = totalsFromQuoteLines([
      { qty: 10, listed_unit_price: 100, discount_pct: 0.1, discounted_unit_price: 90, line_amount: 900 },
    ]);
    expect(t.subtotal).toBe(900);
  });

  it("falls back to qty x discounted price when line_amount is absent", () => {
    const t = totalsFromQuoteLines([{ qty: 3, listed_unit_price: 100, discounted_unit_price: 80 }]);
    expect(t.subtotal).toBe(240);
  });

  it("is zero-safe on an empty / malformed set", () => {
    expect(totalsFromQuoteLines([]).grand_total).toBe(0);
    expect(totalsFromQuoteLines(null).grand_total).toBe(0);
    expect(totalsFromQuoteLines([{ qty: "x", listed_unit_price: null }]).grand_total).toBe(0);
  });

  it("ignores a line with no price rather than counting it as free", () => {
    const t = totalsFromQuoteLines([
      { qty: 5, line_amount: 500, igst_pct: 18 },
      { qty: 5 },  // unpriced draft line
    ]);
    expect(t.subtotal).toBe(500);
    expect(t.grand_total).toBe(590);
  });
});

describe("refreshQuoteTotals", () => {
  const makeSvc = (rows, opts = {}) => {
    const svc = { updated: null };
    svc.from = (table) => {
      const api = {
        select: () => api,
        eq: () => api,
        update(v) { svc.updated = v; return { eq: () => ({ eq: async () => ({ error: opts.updateError || null }) }) }; },
        then: (r) => r({ data: table === "quote_lines" ? rows : [], error: opts.selectError || null }),
      };
      return api;
    };
    return svc;
  };

  it("writes the rolled-up totals back onto the quote", async () => {
    const svc = makeSvc([{ qty: 5, line_amount: 500, cgst_pct: 9, sgst_pct: 9 }]);
    const t = await refreshQuoteTotals(svc, "t-1", "q-1");
    expect(t).toEqual({ subtotal: 500, tax_total: 90, grand_total: 590 });
    expect(svc.updated).toEqual({ subtotal: 500, tax_total: 90, grand_total: 590 });
  });

  it("is best-effort: a read or write failure returns null and never throws", async () => {
    expect(await refreshQuoteTotals(makeSvc([], { selectError: { message: "boom" } }), "t-1", "q-1")).toBeNull();
    expect(await refreshQuoteTotals(makeSvc([{ line_amount: 1 }], { updateError: { message: "boom" } }), "t-1", "q-1")).toBeNull();
    expect(await refreshQuoteTotals({ from: () => { throw new Error("x"); } }, "t-1", "q-1")).toBeNull();
  });
});

describe("the admin quote_lines endpoint refreshes the header", () => {
  it("calls refreshQuoteTotals on both write and delete", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(process.cwd(), "src/api/admin/quote_lines.js"), "utf8");
    // POST path and DELETE path each roll the header up.
    expect(src).toMatch(/refreshQuoteTotals\(svc, ctx\.tenantId, body\.quote_id\)/);
    expect(src).toMatch(/refreshQuoteTotals\(svc, ctx\.tenantId, owner\.data\.quote_id\)/);
    // The delete path must resolve the parent BEFORE deleting the row.
    expect(src.indexOf('select("quote_id")')).toBeLessThan(src.indexOf(".delete()"));
  });
});
