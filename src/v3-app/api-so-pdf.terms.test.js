// The SO PDF prints the payment terms and the dispatch mode the order says,
// never a default no document gave. It used to print the customer's default
// payment terms or a literal "30 Days", and "By Road" when the order had no
// dispatch mode.
//
// Payment terms, in order: the term a decision on the terms check settled on
// (migration 250, only where the check is on), the PO's own terms as
// extracted, the customer's default, else "Not stated". Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null, rendered: [] }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-pt", role: "sales_engineer" })) };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc(), userClient: () => ({}) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));
vi.mock("../api/_lib/pdf-renderer.js", () => ({
  renderSalesOrder: vi.fn(async (data) => { H.rendered.push(data); return Buffer.from("%PDF terms"); }),
}));

const { default: soPdf, buildSalesOrderData, decidedPaymentTerm, PAYMENT_TERMS_NOT_STATED } = await import("../api/orders/so_pdf.js");
const { historyByFlag } = await import("../api/_lib/terms/decisions.js");

const build = ({ order = {}, customer = null, decidedTerm = null } = {}) => buildSalesOrderData({
  order: { id: "o-1", po_number: "PO-PT-1", created_at: "2026-10-01", result: { salesOrder: { lineItems: [] } }, ...order },
  customer, consigneeLoc: null, seller: null, contact: null, schedules: [], decidedTerm,
});
const withPoTerms = (terms) => ({ result: { salesOrder: { customer: { payment_terms: terms }, lineItems: [] } } });

describe("buildSalesOrderData: payment terms and dispatch mode", () => {
  it("an order with PO terms and no customer default shows the PO terms", () => {
    expect(build({ order: withPoTerms("45 days from invoice"), customer: { customer_name: "Acme Test" } }).modeOfPayment)
      .toBe("45 days from invoice");
  });

  it("the PO's terms win over the customer's default", () => {
    expect(build({ order: withPoTerms("60 days net"), customer: { default_payment_terms: "15 days" } }).modeOfPayment)
      .toBe("60 days net");
  });

  it("reads the PO's terms from the sales order head too", () => {
    expect(build({ order: { result: { salesOrder: { payment_terms: "Advance 50%", lineItems: [] } } } }).modeOfPayment)
      .toBe("Advance 50%");
  });

  it("with no PO terms, the customer's default", () => {
    expect(build({ customer: { default_payment_terms: "15 days" } }).modeOfPayment).toBe("15 days");
  });

  it("an order with nothing shows the not-stated value, not 30 Days", () => {
    const d = build({ customer: { customer_name: "Acme Test", default_payment_terms: "  " } });
    expect(d.modeOfPayment).toBe(PAYMENT_TERMS_NOT_STATED);
    expect(d.modeOfPayment).toBe("Not stated");
  });

  it("dispatch mode is the order's, else blank, never By Road", () => {
    expect(build({ order: { dispatch_mode: "By Air" } }).dispatchedThrough).toBe("By Air");
    expect(build().dispatchedThrough).toBe("");
    expect(build({ order: { dispatch_mode: null } }).dispatchedThrough).toBe("");
  });

  it("a decided term wins over the PO's terms", () => {
    expect(build({ order: withPoTerms("90 days"), decidedTerm: { text: "45 days", poRefused: true } }).modeOfPayment).toBe("45 days");
  });

  it("a refused PO term is never printed, even when no term replaced it", () => {
    expect(build({ order: withPoTerms("90 days"), customer: { default_payment_terms: "30 days net" }, decidedTerm: { text: null, poRefused: true } }).modeOfPayment)
      .toBe("30 days net");
    expect(build({ order: withPoTerms("90 days"), decidedTerm: { text: null, poRefused: true } }).modeOfPayment)
      .toBe(PAYMENT_TERMS_NOT_STATED);
  });

  it("a customer default worded as the refused PO term is that term again, so it is not printed", () => {
    const decidedTerm = { text: null, poRefused: true, poText: "90 days from receipt" };
    expect(build({ order: withPoTerms("90 days from receipt"), customer: { default_payment_terms: " 90 DAYS  from Receipt " }, decidedTerm }).modeOfPayment)
      .toBe(PAYMENT_TERMS_NOT_STATED);
    // The same when only the flag holds the PO's wording.
    expect(build({ customer: { default_payment_terms: "90 days from receipt" }, decidedTerm }).modeOfPayment)
      .toBe(PAYMENT_TERMS_NOT_STATED);
  });
});

describe("decidedPaymentTerm", () => {
  const f = (id, primary, quoteText) => ({
    id, clause: "payment_terms", superseded_at: null,
    po: { text: "90 days from receipt" },
    quote: { text: quoteText, primary, quote_id: "q-" + id },
  });
  const d = (flag_id, decision) => ({ id: "d-" + flag_id, flag_id, decision, decided_at: "2026-10-03T10:00:00Z" });

  it("with several quotes, the primary quote's decision is read first", () => {
    // The non-primary flag comes first and was rejected; the primary one was accepted.
    const flags = [f("f-other", false, "60 days from invoice"), f("f-primary", true, "30 days from invoice")];
    const history = historyByFlag([d("f-other", "reject_term"), d("f-primary", "accept")]);
    expect(decidedPaymentTerm(flags, history)).toMatchObject({ text: "90 days from receipt", poRefused: false, amendmentOpen: false });
  });

  it("a requested amendment gives our quote's term and keeps the PO's term out", () => {
    const flags = [f("f-primary", true, "30 days from invoice")];
    expect(decidedPaymentTerm(flags, historyByFlag([d("f-primary", "request_amendment")])))
      .toMatchObject({ text: "30 days from invoice", poRefused: false, amendmentOpen: true, poText: "90 days from receipt" });
  });
});

// The handler reads the decision itself, from the current check.
const T = "t-pt";
const flag = (over = {}) => ({
  id: "f-pay", tenant_id: T, order_id: "o-pt", check_id: "chk-1", clause: "payment_terms", outcome: "deviates",
  severity: "high", superseded_at: null,
  po: { clause: "payment_terms", side: "po", text: "90 days from receipt" },
  quote: { clause: "payment_terms", side: "quote", text: "30 days from invoice", primary: true, quote_id: "q-1" },
  ...over,
});
const decision = (decision, decided_at, flag_id = "f-pay") => ({
  id: "d-" + decided_at, tenant_id: T, order_id: "o-pt", flag_id, decision, reason: "decided in a test", decided_at,
});

const seed = ({ mode = "on", decisions = [], flags = [flag()] } = {}) => {
  H.db = createMemoryDb({
    orders: [{
      id: "o-pt", tenant_id: T, status: "APPROVED", po_number: "PO-PT-2", customer_id: "c-pt", created_at: "2026-10-01",
      rule_findings: [], dispatch_mode: null,
      result: { salesOrder: { customer: { payment_terms: "90 days from receipt" }, lineItems: [] } },
    }],
    customers: [{ id: "c-pt", tenant_id: T, customer_name: "Acme Test", default_payment_terms: "15 days" }],
    tenant_settings: mode == null ? [] : [{ tenant_id: T, terms_check_mode: mode }],
    order_term_checks: [{ id: "chk-1", tenant_id: T, order_id: "o-pt", po_terms_status: "read", created_at: "2026-10-02", superseded_at: null }],
    order_term_flags: flags,
    order_term_decisions: decisions,
  }, {}, { project: true });
};

const render = async () => {
  H.rendered = [];
  const r = await callHandler(soPdf, { query: { orderId: "o-pt" } });
  expect(r.status).toBe(200);
  return H.rendered[0];
};

describe("GET /api/orders/so_pdf: the decided payment term", () => {
  beforeEach(() => seed());

  it("with no decision, the PO's terms; dispatch blank", async () => {
    const d = await render();
    expect(d.modeOfPayment).toBe("90 days from receipt");
    expect(d.dispatchedThrough).toBe("");
  });

  it("rejecting the PO's term prints our quote's term", async () => {
    seed({ decisions: [decision("reject_term", "2026-10-03T10:00:00Z")] });
    expect((await render()).modeOfPayment).toBe("30 days from invoice");
  });

  it("accepting the PO's term prints the PO's term", async () => {
    seed({ decisions: [decision("reject_term", "2026-10-03T10:00:00Z"), decision("accept", "2026-10-04T10:00:00Z")] });
    expect((await render()).modeOfPayment).toBe("90 days from receipt");
  });

  it("the newest decision is the current one", async () => {
    seed({ decisions: [decision("accept", "2026-10-03T10:00:00Z"), decision("reject_term", "2026-10-04T10:00:00Z")] });
    expect((await render()).modeOfPayment).toBe("30 days from invoice");
  });

  it("while an amendment is requested, our quote's term prints, not the PO's term we asked them to amend", async () => {
    seed({ decisions: [decision("request_amendment", "2026-10-03T10:00:00Z")] });
    expect((await render()).modeOfPayment).toBe("30 days from invoice");
  });

  it("a requested amendment with no quote term prints the customer default, never the PO's term", async () => {
    seed({ flags: [flag({ outcome: "po_only", quote: null })], decisions: [decision("request_amendment", "2026-10-03T10:00:00Z")] });
    expect((await render()).modeOfPayment).toBe("15 days");
  });

  it("a rejected term with no quote term never prints the PO's term", async () => {
    seed({ flags: [flag({ outcome: "po_only", quote: null })], decisions: [decision("reject_term", "2026-10-03T10:00:00Z")] });
    expect((await render()).modeOfPayment).toBe("15 days");
  });

  it("a rejected term with no quote term does not print a customer default worded as the PO's term", async () => {
    seed({ flags: [flag({ outcome: "po_only", quote: null })], decisions: [decision("reject_term", "2026-10-03T10:00:00Z")] });
    H.db.tables.customers[0].default_payment_terms = "90 Days From Receipt";
    expect((await render()).modeOfPayment).toBe(PAYMENT_TERMS_NOT_STATED);
  });

  it("a decision on a superseded check is not read", async () => {
    seed({ decisions: [decision("reject_term", "2026-10-03T10:00:00Z")] });
    H.db.tables.order_term_checks[0].superseded_at = "2026-10-05";
    expect((await render()).modeOfPayment).toBe("90 days from receipt");
  });

  it("in shadow mode, or with the check off, a decision does not reach the PDF", async () => {
    for (const mode of ["shadow", "off", null]) {
      seed({ mode, decisions: [decision("reject_term", "2026-10-03T10:00:00Z")] });
      expect((await render()).modeOfPayment).toBe("90 days from receipt");
    }
  });

  it("a mode that cannot be read fails the PDF instead of printing a term that may be refused", async () => {
    seed({ decisions: [decision("reject_term", "2026-10-03T10:00:00Z")] });
    H.db.failRead.tenant_settings = { message: "connection reset" };
    H.rendered = [];
    const r = await callHandler(soPdf, { query: { orderId: "o-pt" } });
    expect(r.status).toBe(500);
    expect(H.rendered).toEqual([]);
  });
});
