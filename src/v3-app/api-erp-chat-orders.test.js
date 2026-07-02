// Regression test for src/api/_lib/erp-chat-tools.js.
//
// The `orders` table stores SO totals + currency inside the `result`
// JSONB (result.salesOrder.grandTotal / .currency) — there are no
// top-level `currency` / `total_value` / `tally_status` columns. The
// search_orders + customer_history tools previously selected those
// columns directly, which threw "column orders.currency does not exist"
// and surfaced as "Failed to load orders" in the ERP-chat / insights
// paths. This test locks in that the tools select `result` and flatten
// the derived fields, never referencing a phantom column.

import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({ selects: [], rows: [] }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from: () => {
      const q = {
        select: (s) => { H.selects.push(s); return q; },
        eq: () => q, or: () => q, gte: () => q, ilike: () => q,
        order: () => q, limit: () => q,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve) => resolve({ data: H.rows, error: null }),
      };
      return q;
    },
  }),
}));

const { dispatchErpChatTool } = await import("../api/_lib/erp-chat-tools.js");

const PHANTOM = /\b(currency|total_value|tally_status)\b/;

describe("erp-chat tools / orders.currency phantom-column fix", () => {
  it("search_orders selects result JSONB, never phantom columns, and flattens currency/total", async () => {
    H.selects = [];
    H.rows = [{ id: "o1", quote_number: "Q1", po_number: "PO1", status: "EXPORTED_TO_TALLY", customer_id: "c1", created_at: "2026-06-01", result: { salesOrder: { grandTotal: 3500, currency: "INR" } } }];
    const out = await dispatchErpChatTool("t-1", "search_orders", {});
    // No orders select may name a column that does not exist on the table.
    for (const s of H.selects) expect(s).not.toMatch(PHANTOM);
    expect(H.selects.some((s) => s.includes("result"))).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.rows[0]).toMatchObject({ currency: "INR", total_value: 3500, tally_status: "EXPORTED_TO_TALLY" });
  });

  it("customer_history selects result from orders (no phantom columns)", async () => {
    H.selects = [];
    H.rows = [{ id: "o2", quote_number: "Q2", po_number: "PO2", status: "DRAFT", customer_id: "c2", created_at: "2026-06-02", result: { salesOrder: { grandTotal: 900, currency: "USD" } } }];
    const out = await dispatchErpChatTool("t-1", "customer_history", { customer_id_or_name: "11111111-1111-1111-1111-111111111111" });
    const ordersSelects = H.selects.filter((s) => s.includes("quote_number") || s.includes("po_number"));
    for (const s of ordersSelects) expect(s).not.toMatch(PHANTOM);
    expect(out.error).toBeUndefined();
    // orders rows are flattened; DRAFT is not a tally status
    expect(out.orders[0]).toMatchObject({ currency: "USD", total_value: 900, tally_status: null });
  });
});
