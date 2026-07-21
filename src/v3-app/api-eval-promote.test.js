// CM P4: promoting an APPROVED order into a golden eval_case (the free
// ground-truth flywheel). Uses an in-memory Supabase-style stub that captures
// the upserted eval_cases row.

import { describe, it, expect } from "vitest";
import { promoteApprovedOrder } from "../api/eval/promote.js";

const makeSvc = (capture) => ({
  from(table) {
    const b = {
      select() { return b; },
      eq() { return b; },
      in() { return b; },
      upsert(row) { capture.evalCase = row; return b; },
      single() { return b; },
      maybeSingle() { return b; },
      then(resolve) {
        if (table === "eval_cases") return Promise.resolve({ data: { id: "ec-1" }, error: null }).then(resolve);
        // order_documents / documents: no source docs in these tests.
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return b;
  },
});

const approvedOrder = () => ({
  id: "ord-1",
  tenant_id: "t-src",
  status: "APPROVED",
  po_number: "0066026562",
  customer_id: "cust-1",
  payload_hash: "ph-1",
  approved_by: "u-1",
  approved_at: "2026-07-21T00:00:00Z",
  doc_fingerprint: "fp-1",
  preflight_payload: { extraction_run_id: "run-1" },
  approval: { payloadHash: "ph-1", approvedBy: "u-1" },
  result: {
    salesOrder: {
      customer: { name: "MAHINDRA & MAHINDRA LTD", po_number: "0066026562", po_date: "4/8/2026" },
      lineItems: [{ partNumber: "TWS-092-90-2", quantity: 5, unitPrice: 100, customerItemCode: "A12060OBAR010003" }],
    },
  },
});

describe("promoteApprovedOrder", () => {
  it("snapshots an approved order into a golden case in the scorer vocabulary", async () => {
    const capture = {};
    const res = await promoteApprovedOrder(makeSvc(capture), approvedOrder(), {
      targetTenantId: "t-golden", nowIso: "2026-07-21T00:00:00Z",
    });
    expect(res.promoted).toBe(true);
    expect(res.case_id).toBe("0066026562");
    expect(res.tenant_id).toBe("t-golden");

    const ec = capture.evalCase;
    expect(ec.tenant_id).toBe("t-golden");         // routed to the shared corpus
    expect(ec.suite).toBe("po-extraction");
    expect(ec.case_id).toBe("0066026562");
    expect(ec.enabled).toBe(true);
    expect(ec.expected.poNumber).toBe("0066026562");
    expect(ec.expected.poDate).toBe("4/8/2026");
    expect(ec.expected.customer).toBe("MAHINDRA & MAHINDRA LTD");
    expect(ec.expected.lineItems).toEqual([
      { partNo: "TWS-092-90-2", customerItemCode: "A12060OBAR010003", qty: 5, rate: 100 },
    ]);
  });

  it("captures reproducibility provenance inside expected._provenance", async () => {
    const capture = {};
    await promoteApprovedOrder(makeSvc(capture), approvedOrder(), { targetTenantId: "t-golden", nowIso: "2026-07-21T00:00:00Z" });
    const p = capture.evalCase.expected._provenance;
    expect(p.order_id).toBe("ord-1");
    expect(p.source_tenant_id).toBe("t-src");
    expect(p.extraction_run_id).toBe("run-1");
    expect(p.payload_hash).toBe("ph-1");
    expect(p.approved_by).toBe("u-1");
    expect(p.customer_id).toBe("cust-1");
  });

  it("falls back to the order's own tenant when no shared corpus is configured", async () => {
    const capture = {};
    const res = await promoteApprovedOrder(makeSvc(capture), approvedOrder(), {});
    expect(res.tenant_id).toBe("t-src");
    expect(capture.evalCase.tenant_id).toBe("t-src");
  });

  it("skips a non-approved order", async () => {
    const capture = {};
    const res = await promoteApprovedOrder(makeSvc(capture), { ...approvedOrder(), status: "DRAFT" }, {});
    expect(res).toEqual({ promoted: false, reason: "not_approved" });
    expect(capture.evalCase).toBeUndefined();
  });

  it("skips an approved order with no extracted lines", async () => {
    const capture = {};
    const order = approvedOrder();
    order.result.salesOrder.lineItems = [];
    const res = await promoteApprovedOrder(makeSvc(capture), order, {});
    expect(res.promoted).toBe(false);
    expect(res.reason).toBe("no_lines");
  });

  it("uses the order id as case_id when no PO number is present", async () => {
    const capture = {};
    const order = approvedOrder();
    order.po_number = null;
    delete order.result.salesOrder.customer.po_number;
    const res = await promoteApprovedOrder(makeSvc(capture), order, {});
    expect(res.case_id).toBe("ord-1");
  });
});
