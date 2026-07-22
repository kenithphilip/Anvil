// Issue #22 GenOps safe action: post_tally_voucher. The confirm handler
// ENQUEUES (builds the voucher + inserts a pending tally_retry_queue row); the
// proven cron does the actual bridge post. No external HTTP in the confirm.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/tally-client.js", () => ({ tallyResolveCompany: vi.fn() }));
vi.mock("../api/_lib/tally-voucher-type.js", () => ({ resolveSalesVoucherType: () => "Sales" }));
vi.mock("../api/_lib/tally-build-voucher.js", () => ({ buildSalesVoucherXml: () => ({ xml: "<VOUCHER/>", metadata: {} }) }));

import { enqueueTallyVoucher } from "../api/_lib/tally-enqueue.js";
import { tallyResolveCompany } from "../api/_lib/tally-client.js";
import { erpChatTools, erpChatToolScope } from "../api/_lib/erp-chat-tools.js";

const CTX = { tenantId: "t1" };
const APPROVED = { id: "o1", tenant_id: "t1", po_number: "PO-1", approval: { payloadHash: "h1" }, payload_hash: "h1", customer_id: null };

const makeSvc = (seed = {}) => {
  const store = { tally_retry_queue: [], ...seed };
  return {
    store,
    from(t) {
      let rows = [...(store[t] || [])]; let mode = "select"; let patch = null; let single = false;
      const b = {
        select: () => b,
        eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
        maybeSingle: () => { single = true; return b; },
        single: () => { single = true; return b; },
        insert: (row) => { mode = "insert"; patch = row; return b; },
        then: (fn) => Promise.resolve(fn(term())),
      };
      const term = () => {
        if (mode === "insert") { const r = { id: t + "-1", ...patch }; (store[t] = store[t] || []).push(r); return { data: single ? r : [r], error: null }; }
        return { data: single ? rows[0] || null : rows, error: null };
      };
      return b;
    },
  };
};

beforeEach(() => { tallyResolveCompany.mockReset(); });

describe("enqueueTallyVoucher", () => {
  it("enqueues a pending tally_retry_queue row for an approved order (no bridge post)", async () => {
    tallyResolveCompany.mockResolvedValue({ id: "co1", name: "Acme Co", bridge_url: "http://bridge" });
    const svc = makeSvc({ orders: [APPROVED] });
    const r = await enqueueTallyVoucher(svc, CTX, { orderId: "o1" });
    expect(r).toMatchObject({ ok: true, queued: true, order_id: "o1", voucher_no: "SO:PO-1", voucher_type: "Sales", company: "Acme Co" });
    const q = svc.store.tally_retry_queue;
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ order_id: "o1", voucher_type: "Sales", payload_xml: "<VOUCHER/>", payload_hash: "h1", status: "pending", attempt_count: 0 });
  });

  it("refuses when no Tally company / bridge is configured", async () => {
    tallyResolveCompany.mockResolvedValue(null);
    const r = await enqueueTallyVoucher(makeSvc({ orders: [APPROVED] }), CTX, { orderId: "o1" });
    expect(r).toMatchObject({ ok: false, code: "BRIDGE_NOT_CONFIGURED" });
  });

  it("refuses an unapproved order (no payload hash)", async () => {
    tallyResolveCompany.mockResolvedValue({ id: "co1", name: "Acme Co", bridge_url: "http://bridge" });
    const svc = makeSvc({ orders: [{ id: "o2", tenant_id: "t1", po_number: "PO-2", approval: null }] });
    const r = await enqueueTallyVoucher(svc, CTX, { orderId: "o2" });
    expect(r).toMatchObject({ ok: false, code: "NOT_APPROVED" });
    expect(svc.store.tally_retry_queue).toHaveLength(0);
  });

  it("requires an orderId", async () => {
    const r = await enqueueTallyVoucher(makeSvc(), CTX, {});
    expect(r).toMatchObject({ ok: false, code: "ORDER_REQUIRED" });
  });
});

describe("post_tally_voucher tool", () => {
  it("is registered as a propose-only write.erp action", () => {
    expect(erpChatTools().map((t) => t.name)).toContain("post_tally_voucher");
    expect(erpChatToolScope("post_tally_voucher")).toBe("write.erp");
    // write.* is default-deny for MCP tokens (must be granted explicitly)
    expect("write.erp".startsWith("write.")).toBe(true);
  });
});
