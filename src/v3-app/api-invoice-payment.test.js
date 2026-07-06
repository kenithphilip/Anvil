// Unit tests for src/api/_lib/payments.js — the shared cash-application
// core used by the manual record-payment fallback (/api/invoices/payment)
// and, later, the automated bank-statement matching path.

import { describe, it, expect } from "vitest";
import { applyPayment, PAYMENT_METHODS, __test__ } from "../api/_lib/payments.js";

// Supabase shim. insert()/update() capture the payload and resolve via
// maybeSingle() to {id, ...payload}; the dedup select().eq().eq().limit()
// resolves to a configurable response.
const makeSvc = (config = {}) => {
  const captured = { inserts: [], updates: [] };
  const dedup = config.dedup ? [...config.dedup] : [];
  const from = (table) => {
    let mode = "select";
    let payload = null;
    const b = {
      select() { return b; },
      eq() { return b; },
      limit() { return Promise.resolve(dedup.length ? dedup.shift() : { data: [], error: null }); },
      insert(row) { mode = "insert"; payload = row; captured.inserts.push({ table, row }); return b; },
      update(row) { mode = "update"; payload = row; captured.updates.push({ table, row }); return b; },
      maybeSingle() {
        if (mode === "insert") return Promise.resolve({ data: { id: "pay-1", ...payload }, error: null });
        if (mode === "update") return Promise.resolve({ data: { id: "inv-1", ...payload }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
    };
    return b;
  };
  return { svc: { from }, captured };
};

const baseInvoice = { id: "inv-1", tenant_id: "t1", grand_total: 1000, paid_amount: 0, currency: "INR", paid_at: null };

describe("applyPayment", () => {
  it("full payment flips status to paid and records the receipt", async () => {
    const { svc, captured } = makeSvc();
    const out = await applyPayment(svc, baseInvoice, { amount: 1000, method: "upi", reference: "UTR123", actorId: "u1" });
    expect(out.status).toBe("paid");
    expect(out.applied).toBe(1000);
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0].row).toMatchObject({
      tenant_id: "t1", invoice_id: "inv-1", amount: 1000, currency: "INR", method: "upi",
    });
    expect(captured.inserts[0].row.raw).toMatchObject({ reference: "UTR123", recorded_by: "u1", source: "manual" });
    expect(captured.updates[0].row).toMatchObject({ paid_amount: 1000, status: "paid" });
    expect(captured.updates[0].row.paid_at).toBeTruthy();
  });

  it("partial payment flips status to partial and leaves paid_at null", async () => {
    const { svc, captured } = makeSvc();
    const out = await applyPayment(svc, baseInvoice, { amount: 400, method: "cheque" });
    expect(out.status).toBe("partial");
    expect(captured.updates[0].row).toMatchObject({ paid_amount: 400, status: "partial", paid_at: null });
  });

  it("accumulates onto a prior partial payment", async () => {
    const { svc, captured } = makeSvc();
    const partial = { ...baseInvoice, paid_amount: 600 };
    const out = await applyPayment(svc, partial, { amount: 400, method: "neft" });
    expect(out.status).toBe("paid");
    expect(captured.updates[0].row.paid_amount).toBe(1000);
  });

  it("uses integer-cents math (no binary-float drift)", async () => {
    const { svc, captured } = makeSvc();
    const inv = { ...baseInvoice, grand_total: 0.3, paid_amount: 0.1 };
    const out = await applyPayment(svc, inv, { amount: 0.2, method: "cash" });
    // 0.1 + 0.2 must equal 0.3 exactly, not 0.30000000000000004.
    expect(captured.updates[0].row.paid_amount).toBe(0.3);
    expect(out.status).toBe("paid");
  });

  it("cash receipt plus TDS withholding clears the invoice in full", async () => {
    // OEM pays 980 cash and withholds 20 TDS on a 1000 invoice. This is
    // the two-posting sequence the /invoices/payment endpoint runs.
    const { svc, captured } = makeSvc();
    const r1 = await applyPayment(svc, baseInvoice, { amount: 980, method: "bank_transfer" });
    expect(r1.status).toBe("partial");
    const afterCash = { ...baseInvoice, ...r1.invoice };
    const r2 = await applyPayment(svc, afterCash, { amount: 20, method: "tds", note: "TDS withheld at source" });
    expect(r2.status).toBe("paid");
    expect(captured.inserts.map((i) => i.row.method)).toEqual(["bank_transfer", "tds"]);
    expect(captured.updates[1].row.paid_amount).toBe(1000);
  });

  it("dedups matched payments by externalId and skips the insert", async () => {
    const { svc, captured } = makeSvc({ dedup: [{ data: [{ id: "existing" }], error: null }] });
    const out = await applyPayment(svc, baseInvoice, { amount: 1000, method: "bank_transfer", externalId: "UTR-DUP" });
    expect(out).toEqual({ duplicate: true });
    expect(captured.inserts).toHaveLength(0);
    expect(captured.updates).toHaveLength(0);
  });

  it("rejects a non-positive amount", async () => {
    const { svc } = makeSvc();
    await expect(applyPayment(svc, baseInvoice, { amount: 0 })).rejects.toThrow(/positive/);
    await expect(applyPayment(svc, baseInvoice, { amount: -5 })).rejects.toThrow(/positive/);
  });
});

describe("PAYMENT_METHODS", () => {
  it("includes the corporate OEM rails and TDS", () => {
    for (const m of ["bank_transfer", "rtgs", "neft", "wire", "cheque", "tds"]) {
      expect(PAYMENT_METHODS.has(m)).toBe(true);
    }
  });
});

describe("integer-cents helpers", () => {
  it("round-trips through cents", () => {
    expect(__test__.toCents(12.34)).toBe(1234);
    expect(__test__.fromCents(1234)).toBe(12.34);
    expect(__test__.toCents(0.1) + __test__.toCents(0.2)).toBe(__test__.toCents(0.3));
  });
});
