// The delivery date read path (plan PR 10): which date an order is due, where
// it came from, the suggestion for our committed date, and the conflict
// rules. _lib/order-delivery-date.js, the SO PDF data builder, and the rows
// it adds to the exceptions list. Invented fixtures.

import { describe, it, expect } from "vitest";
import {
  poRequiredBy, orderDeliveryDate, lineDueDate, suggestedCommittedDate, deliveryDateConflicts,
  CONFLICT_RULES, todayIso, fmtDueDate, readDate,
} from "../api/_lib/order-delivery-date.js";
import { buildSalesOrderData } from "../api/orders/so_pdf.js";
import { buildSalesOrderAoa } from "../api/orders/export.js";
import { buildOrderExceptions, resolutionOptionsFor } from "../api/_lib/order-exceptions.js";

const NOW = new Date("2026-10-14T06:00:00Z");

const order = ({ header = null, lines = [null, null], committed = null, status = "DRAFT", legacy = null } = {}) => ({
  id: "ord-dd", status, customer_id: "c1", po_number: "PO-DD-1", committed_delivery_date: committed,
  preflight_payload: { last_validated_at: "2026-10-01" },
  result: {
    salesOrder: {
      ...(legacy ? { delivery_date: legacy } : {}),
      customer: { name: "Date Buyer", ...(header ? { delivery_date: header } : {}) },
      lineItems: lines.map((d, i) => ({ partNumber: "DD-" + i, qty: 1, rate: 10, ...(d ? { delivery_date: d } : {}) })),
    },
  },
});

describe("the PO's date and the summary's one date", () => {
  it("the header first, then the earliest line, then none", () => {
    expect(poRequiredBy(order({ header: "2026-11-30", lines: ["2026-11-10", null] }))).toMatchObject({ iso: "2026-11-30", source: "po_header" });
    expect(poRequiredBy(order({ lines: ["2026-11-20", "2026-11-10"] }))).toMatchObject({ iso: "2026-11-10", source: "po_line", line_index: 1 });
    expect(poRequiredBy(order())).toMatchObject({ iso: null, source: "none" });
  });

  it("the summary: the PO's date with its source, else committed by us, else none", () => {
    expect(orderDeliveryDate(order({ header: "2026-11-30", committed: "2026-12-05" }))).toMatchObject({ iso: "2026-11-30", source: "po_header" });
    expect(orderDeliveryDate(order({ lines: ["2026-11-20", null] }))).toMatchObject({ iso: "2026-11-20", source: "po_line" });
    expect(orderDeliveryDate(order({ committed: "2026-12-05" }))).toMatchObject({ iso: "2026-12-05", source: "committed" });
    expect(orderDeliveryDate(order())).toMatchObject({ source: "none" });
  });

  it("a date printed as words is kept as printed, and shown, but never compared", () => {
    const o = order({ header: "Week 46" });
    expect(poRequiredBy(o)).toMatchObject({ printed: "Week 46", iso: null, source: "po_header" });
    expect(fmtDueDate(poRequiredBy(o))).toBe("Week 46");
    expect(deliveryDateConflicts({ ...o, committed_delivery_date: "2026-12-30" }, { now: NOW })).toEqual([]);
    expect(readDate("15-Nov-2026")).toEqual({ printed: "15-Nov-2026", iso: "2026-11-15" });
  });
});

describe("the due date of a line: schedule, PO line, PO header, committed, none", () => {
  const sched = [{ line_index: 0, scheduled_date: "2026-11-01" }];
  it("each step falls back to the next", () => {
    const full = order({ header: "2026-11-30", lines: ["2026-11-20", null], committed: "2026-12-05" });
    expect(lineDueDate(full, 0, sched)).toMatchObject({ iso: "2026-11-01", source: "schedule" });
    expect(lineDueDate(full, 0, [])).toMatchObject({ iso: "2026-11-20", source: "po_line" });
    expect(lineDueDate(full, 1, sched)).toMatchObject({ iso: "2026-11-30", source: "po_header" });
    expect(lineDueDate(order({ committed: "2026-12-05" }), 1)).toMatchObject({ iso: "2026-12-05", source: "committed" });
    expect(lineDueDate(order(), 1)).toMatchObject({ iso: null, source: "none" });
    // The older salesOrder.delivery_date key still counts as the header's.
    expect(lineDueDate(order({ legacy: "2026-11-25" }), 1)).toMatchObject({ iso: "2026-11-25", source: "po_header" });
  });

  it("buildSalesOrderData prints that order on the SO PDF", () => {
    const o = order({ header: "2026-11-30", lines: ["2026-11-20", null, null], committed: "2026-12-05" });
    const due = (orderObj, schedules = []) => buildSalesOrderData({ order: orderObj, customer: null, consigneeLoc: null, seller: null, contact: null, schedules }).items.map((it) => it.dueOn);
    expect(due(o, [{ line_index: 2, scheduled_date: "2026-11-02" }])).toEqual(["20-Nov-26", "30-Nov-26", "02-Nov-26"]);
    expect(due(order({ committed: "2026-12-05", lines: [null] }))).toEqual(["05-Dec-26"]);
    expect(due(order({ lines: [null] }))).toEqual([""]);
  });

  it("the Excel export prints the same due date as the PDF for every line", () => {
    const o = order({ header: "2026-11-30", lines: ["2026-11-20", null, "Week 46"], committed: "2026-12-05" });
    const schedules = [{ line_index: 1, scheduled_date: "2026-11-03" }];
    const pdf = buildSalesOrderData({ order: o, customer: null, consigneeLoc: null, seller: null, contact: null, schedules }).items.map((it) => it.dueOn);
    const aoa = buildSalesOrderAoa(o, { schedules });
    const head = aoa.findIndex((r) => r[0] === "#");
    const col = aoa[head].indexOf("Due On");
    const xl = aoa.slice(head + 1, head + 1 + o.result.salesOrder.lineItems.length).map((r) => r[col]);
    expect(xl).toEqual(pdf);
    expect(xl).toEqual(["20-Nov-26", "03-Nov-26", "Week 46"]);
  });
});

describe("the suggested committed date", () => {
  it("is a structure: value, source, rule, confidence, and the control that applies it", () => {
    expect(suggestedCommittedDate(order({ header: "15/11/2026" }))).toEqual({
      value: "2026-11-15", source: "po_header", rule: "po_header_date", confidence: "high", printed: "15/11/2026",
      applies_via: { kind: "endpoint", method: "PATCH", path: "/api/orders/{order_id}", body: "committed_delivery_date", control: "Header fields tab: Committed delivery date, then Save header", permission: "write" },
    });
    expect(suggestedCommittedDate(order({ lines: ["2026-11-20", "2026-11-12"] }))).toMatchObject({ value: "2026-11-12", source: "po_line", rule: "earliest_po_line_date", confidence: "high", line_index: 1 });
  });

  it("a date only in a description is low confidence; no date is no suggestion", () => {
    const o = order();
    o.result.salesOrder.lineItems[0].description = "Spindle assy. Delivery date : 05/12/2026";
    expect(suggestedCommittedDate(o)).toMatchObject({ value: "2026-12-05", source: "po_description", rule: "delivery_date_in_description", confidence: "low", line_index: 0 });
    expect(suggestedCommittedDate(order())).toBeNull();
  });

  it("is never applied: the order's committed date is left as it was", () => {
    const o = order({ header: "2026-11-30" });
    const out = buildOrderExceptions({ order: o, now: NOW });
    expect(o.committed_delivery_date).toBeNull();
    expect(out.delivery).toMatchObject({ committed: null, shown: { source: "po_header" }, suggestion: { value: "2026-11-30", confidence: "high" } });
  });
});

describe("the conflict rules", () => {
  it("are the three, named plainly", () => {
    expect(CONFLICT_RULES).toEqual(["committed_after_po_date", "line_differs_from_header", "date_in_past"]);
  });

  it("committed later than the PO's date", () => {
    const c = deliveryDateConflicts(order({ header: "2026-11-30", committed: "2026-12-05" }), { now: NOW });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ rule: "committed_after_po_date", severity: "high", detail: "Committed 2026-12-05 vs PO 2026-11-30 (from the PO header)" });
    expect(deliveryDateConflicts(order({ header: "2026-11-30", committed: "2026-11-30" }), { now: NOW })).toEqual([]);
    expect(deliveryDateConflicts(order({ lines: ["2026-11-20"], committed: "2026-11-21" }), { now: NOW })[0].rule).toBe("committed_after_po_date");
  });

  it("a line's date differs from the header's", () => {
    const c = deliveryDateConflicts(order({ header: "2026-11-30", lines: ["2026-11-30", "2026-12-10"] }), { now: NOW });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ rule: "line_differs_from_header", detail: "Header 2026-11-30; line 2 2026-12-10", payload: { line_indexes: [1] } });
  });

  it("a date in the past, at review time only", () => {
    const o = order({ header: "2026-10-01", committed: "2026-09-30" });
    const c = deliveryDateConflicts(o, { now: NOW });
    expect(c.map((x) => x.rule)).toEqual(["date_in_past"]);
    expect(c[0].detail).toBe("PO header 2026-10-01, committed 2026-09-30; today is 2026-10-14");
    expect(deliveryDateConflicts({ ...o, status: "APPROVED" }, { now: NOW })).toEqual([]);
    // Today itself is not in the past.
    expect(deliveryDateConflicts(order({ header: "2026-10-14" }), { now: NOW })).toEqual([]);
  });

  it("today is judged in India time by default", () => {
    expect(todayIso(new Date("2026-10-14T20:00:00Z"))).toBe("2026-10-15");
    expect(todayIso(new Date("2026-10-14T20:00:00Z"), "UTC")).toBe("2026-10-14");
  });
});

describe("a conflict is an exception row", () => {
  const out = buildOrderExceptions({
    order: order({ header: "2026-11-30", lines: ["2026-12-10", null], committed: "2026-12-05" }),
    customer: { customer_name: "Date Buyer" }, now: NOW,
  });

  it("type delivery_date_conflict, keyed by its rule, with the suggestion on the payload", () => {
    const rows = out.rows.filter((r) => r.type === "delivery_date_conflict");
    expect(rows.map((r) => r.key).sort()).toEqual([
      "delivery_date_conflict|rule:committed_after_po_date",
      "delivery_date_conflict|rule:line_differs_from_header",
    ]);
    const late = rows.find((r) => r.payload.rule === "committed_after_po_date");
    expect(late).toMatchObject({
      source: "delivery_date", severity: "high", agent_policy: "human_only",
      action: { tab: "header", control: "committed_date" },
      payload: { po_value: "2026-11-30", committed_value: "2026-12-05", suggestion: { value: "2026-11-30", source: "po_header", confidence: "high" } },
    });
    const lines = rows.find((r) => r.payload.rule === "line_differs_from_header");
    expect(lines).toMatchObject({ severity: "warn", agent_policy: "propose", action: { tab: "recon", target: "lines[0]" } });
  });

  it("offers accept_suggested_date, applied by the existing committed-date update", () => {
    const opts = resolutionOptionsFor("delivery_date_conflict");
    expect(opts.map((o) => o.option)).toEqual(["accept_suggested_date", "set_value", "request_amendment"]);
    expect(opts[0].applies_via).toMatchObject({ kind: "endpoint", method: "PATCH", path: "/api/orders/{order_id}", body: "committed_delivery_date", control: "Header fields tab: Save header" });
    expect(opts[2].applies_via.kind).toBe("not_available_yet");
  });
});
