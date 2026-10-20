// GET /api/sales/pending_sales_orders: a line's open value is rate x the
// BALANCE still to supply. It was rate x the ordered quantity, so a line
// that was mostly despatched still showed its whole value as pending.
// The REAL handler against the in-memory Supabase. Invented ids and parts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "sales_engineer" })) };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));

const { default: handler } = await import("../api/sales/pending_sales_orders.js");

const CUST = "0ccccccc-0000-4000-8000-000000000001";

beforeEach(() => {
  H.db = createMemoryDb({
    customers: [{ id: CUST, tenant_id: "t-1", customer_name: "Test Buyer" }],
    orders: [{
      id: "o-1", tenant_id: "t-1", customer_id: CUST, status: "APPROVED", po_number: "PO-PEND-1", po_date: "2026-10-01",
      result: { salesOrder: { lineItems: [
        { partNo: "PX-1", description: "Part one", qty: 10, rate: 100 },
        { partNo: "PX-2", description: "Part two", qty: 5, rate: 40 },
      ] } },
    }],
    // 4 of the 10 on line 0 are despatched; line 1 has no despatch yet.
    dispatch_lines: [{ tenant_id: "t-1", order_id: "o-1", line_index: 0, part_no: "PX-1", dispatched_qty: 4, dispatch_date: "2026-10-05" }],
    order_schedule_lines: [],
    source_pos: [],
  });
});

describe("pending sales orders open value", () => {
  it("values each open line at rate x balance", async () => {
    const r = await callHandler(handler, { query: { customer_id: CUST } });
    expect(r.status).toBe(200);
    const byPart = Object.fromEntries(r.body.rows.map((row) => [row.part_no, row]));
    expect(byPart["PX-1"].balance_qty).toBe(6);
    expect(byPart["PX-1"].value).toBe(600);
    expect(byPart["PX-2"].value).toBe(200);
  });
});
