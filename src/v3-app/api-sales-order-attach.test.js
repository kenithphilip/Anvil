// The join that makes the Mode A/B comparison possible.
//
// A sales order is the ERP's reply to a customer purchase order, and it says
// which one: the buyer's reference is printed on its face, and
// orders.po_number holds the other side. The document's OWN voucher number is
// the ERP's internal sequence — matching on it would match nothing.
//
// The caller does not supply the order. Making somebody find and pick the
// order they have just uploaded a document ABOUT is exactly the manual step
// the product exists to remove.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { poKey, matchSalesOrderToOrders, comparability, NO_MATCH } from "../api/_lib/sales-order-match.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

const so = (over = {}) => ({
  classification: "sales_order",
  buyer_ref_order_no: "25AB0001234",
  voucher_no: "4417",
  lines: [{ description: "Bend Adapter", partNumber: "3-000000-0-I", quantity: 1 }],
  ...over,
});
const order = (over = {}) => ({ id: "o1", po_number: "25AB0001234", status: "APPROVED", ...over });

describe("poKey", () => {
  it("trims and uppercases, like the PO matching already in the repo", () => {
    expect(poKey("  25ab0001234 ")).toBe("25AB0001234");
  });

  it("does NOT strip punctuation, unlike the part-number key", () => {
    // "25PO0008243" and "25-PO-0008243" may be different documents, and the
    // cost is not symmetric: a missed match asks a person to pick the order,
    // a false one files the sales order against somebody else's and every
    // number compared afterwards is compared against the wrong thing.
    expect(poKey("25-AB-0001234")).not.toBe(poKey("25AB0001234"));
  });

  it("survives null", () => {
    expect(poKey(null)).toBe("");
    expect(poKey(undefined)).toBe("");
  });
});

describe("matching a sales order to its order", () => {
  it("matches on the buyer's reference", () => {
    const r = matchSalesOrderToOrders(so(), [order()]);
    expect(r.matched).toBe(true);
    expect(r.order.id).toBe("o1");
  });

  it("ignores case and padding on both sides", () => {
    const r = matchSalesOrderToOrders(so({ buyer_ref_order_no: " 25ab0001234 " }), [order({ po_number: "25AB0001234" })]);
    expect(r.matched).toBe(true);
  });

  it("does NOT match on the document's own voucher number", () => {
    // The voucher number is the ERP's internal sequence. An order that happens
    // to carry it is a coincidence, not the answer.
    const r = matchSalesOrderToOrders(so(), [order({ id: "wrong", po_number: "4417" })]);
    expect(r.matched).toBe(false);
    expect(r.reason).toBe(NO_MATCH.NOT_FOUND);
  });

  it("says so when the document has no reference at all", () => {
    // A different problem from "no order found", and it sends an operator
    // looking somewhere else entirely.
    const r = matchSalesOrderToOrders(so({ buyer_ref_order_no: null }), [order()]);
    expect(r.reason).toBe(NO_MATCH.NO_REFERENCE);
  });

  it("REFUSES to guess when two orders share the reference", () => {
    // A real situation — a re-issued order, an amendment, a duplicate intake.
    // Picking the newer one would be a coin flip dressed as a decision, and
    // everything downstream would compare the wrong pair without saying so.
    const r = matchSalesOrderToOrders(so(), [order(), order({ id: "o2" })]);
    expect(r.matched).toBe(false);
    expect(r.reason).toBe(NO_MATCH.AMBIGUOUS);
  });

  it("returns the candidates so the next call can name one", () => {
    const r = matchSalesOrderToOrders(so(), [order(), order({ id: "o2", status: "DRAFT" })]);
    expect(r.candidates.map((c) => c.id).sort()).toEqual(["o1", "o2"]);
    expect(r.candidates[0]).toHaveProperty("status");
  });

  it("survives empty and malformed input", () => {
    expect(matchSalesOrderToOrders(null, null).matched).toBe(false);
    expect(matchSalesOrderToOrders(so(), []).reason).toBe(NO_MATCH.NOT_FOUND);
  });
});

describe("what the document will support, decided before storing", () => {
  it("is comparable when it read as a sales order with lines and a reference", () => {
    expect(comparability(so()).comparable).toBe(true);
  });

  it("is not comparable when it read as something else", () => {
    expect(comparability(so({ classification: "non_sales_order" }))).toMatchObject({
      comparable: false, reason: "not_a_sales_order",
    });
  });

  it("is not comparable with no lines", () => {
    expect(comparability(so({ lines: [] })).reason).toBe("no_lines");
  });

  it("is not comparable with no buyer reference", () => {
    expect(comparability(so({ buyer_ref_order_no: "" })).reason).toBe(NO_MATCH.NO_REFERENCE);
  });
});

describe("the route", () => {
  const src = read("src/api/orders/attach_sales_order.js");

  it("does not require the caller to name the order", () => {
    // The document names it. Asking a person to find the order they just
    // uploaded a document about is the manual step being removed.
    expect(src).toMatch(/if \(!documentId\) \{/);
    expect(src).not.toMatch(/if \(!orderId \|\| !documentId\)/);
  });

  it("accepts an override for the two cases the match cannot decide", () => {
    expect(src).toMatch(/if \(body\?\.order_id\) \{/);
    expect(src).toMatch(/via = "explicit"/);
  });

  it("verifies an overridden order against the tenant", () => {
    // An order id in a request body is not proof the caller may attach to it.
    const block = src.slice(src.indexOf('if (body?.order_id) {'));
    expect(block.slice(0, 500)).toMatch(/\.eq\("tenant_id", ctx\.tenantId\)/);
  });

  it("records when a person overrode a reference pointing elsewhere", () => {
    // Not an error — an amended PO number is ordinary — but a fact the
    // comparison should carry rather than lose.
    expect(src).toMatch(/overrode_reference/);
  });

  it("reports a failed match rather than throwing", () => {
    // The caller is told which of the three things went wrong, and ambiguity
    // comes back with candidates so the next call can name one.
    expect(src).toMatch(/attached: false,\s*\n\s*match,/);
  });

  it("scopes the candidate lookup to the reference", () => {
    // The matcher is pure and would filter a hundred thousand rows in memory;
    // the database should not have to send them.
    expect(src).toMatch(/\.ilike\("po_number"/);
  });

  it("names migration 222 when the role is not permitted", () => {
    // A CHECK rejection is 23514 and its message names neither the column nor
    // the migration.
    expect(src).toMatch(/sales_order_role_not_permitted/);
    expect(src).toMatch(/migration 222/);
    expect(src).toMatch(/link\.error\.code === "23514"/);
  });

  it("says the comparison has not run, rather than implying it has", () => {
    // PR 4. A response shaped like it should hold a verdict and never does is
    // worse than one that says so.
    expect(src).toMatch(/compared: false/);
  });
});

describe("the role is permitted", () => {
  const sql = read("supabase/migrations/222_sales_order_document_role.sql");

  it("adds sales_order without dropping the existing roles", () => {
    for (const role of ["purchase_order", "quote", "price_composition", "attachment", "supplier_ack", "sales_order"]) {
      expect(sql).toContain(`'${role}'`);
    }
  });

  it("is idempotent", () => {
    expect(sql).toMatch(/drop constraint order_documents_role_check/);
    expect(sql).toMatch(/conname = 'order_documents_role_check'/);
  });
});
