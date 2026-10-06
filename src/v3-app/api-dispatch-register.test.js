// Customer-facing DISPATCH REGISTER — per PO line, what was despatched.
//
// The two load-bearing properties, asserted here:
//   * REDUNDANCY, NOT A WATERFALL — a despatch matches its PO line by line_index
//     (the 0-based ordinal into orders.result PO line items), else part_no; an
//     unmatched despatch is still shown; a line with nothing despatched is
//     'awaited'; and with NO line-grain data the register degrades to shipment
//     headers. Never blocks.
//   * FAIL-SAFE VISIBILITY — only known customer-safe columns render; a template
//     extra field appears ONLY if explicitly visibility:'customer'; internal
//     context is never emitted by omission.
//
// The ORDERED side is the customer's PO line items (orders.result.salesOrder.
// lineItems[]) — NOT order_schedule_lines, which is the one-to-many delivery
// schedule and would double-count the order.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDispatchRegister, renderDispatchRegisterText, isDispatchRegisterEmpty,
  resolveColumns, DEFAULT_COLUMNS, dispatchRegisterSubject, extractPoLines,
} from "../api/_lib/dispatch-register.js";

const ORDER = { id: "o1", po_number: "PO-5567", po_date: "2026-02-20", customer_id: "c1" };
const CUSTOMER = { id: "c1", customer_name: "TI INDIA — SHIKARAPUR PUNE" };
// Raw PO line items, as they sit in orders.result.salesOrder.lineItems[].
const PO_LINES = [
  { partNumber: "SIV-21N", description: "Timer", quantity: 100 },   // ordinal 0
  { partNumber: "TRF-9", quantity: 50 },                            // ordinal 1
  { itemCode: "CBL-2", quantity: 20 },                              // ordinal 2
  { partNumber: "BOX-7", quantity: 10 },                            // ordinal 3
];
const DISPATCH = [
  { id: "d1", line_index: 0, dispatched_qty: 40, dispatch_date: "2026-03-12", lr_number: "LR4471", invoice_number: "INV-882", carrier: "VRL" },
  { id: "d2", line_index: 1, dispatched_qty: 50, dispatch_date: "2026-03-14", lr_number: "LR4480", invoice_number: "INV-883" },
  { id: "d3", part_no: "cbl-2", dispatched_qty: 20, dispatch_date: "2026-03-15" },  // part_no, case-insensitive
  { id: "d4", part_no: "MISC-1", dispatched_qty: 5, dispatch_date: "2026-03-16", lr_number: "LR9", cost_internal: 999 }, // unmatched + stray internal field
];

const byLine = (reg) => Object.fromEntries(reg.lines.map((l) => [String(l.part_no ?? l.line_no), l]));

describe("the ordered side comes from the PO line items", () => {
  it("extractPoLines reads salesOrder.lineItems (with shape fallbacks)", () => {
    expect(extractPoLines({ result: { salesOrder: { lineItems: PO_LINES } } })).toHaveLength(4);
    expect(extractPoLines({ result: { lineItems: [{ partNumber: "X" }] } })).toHaveLength(1);
    expect(extractPoLines({ result: {} })).toEqual([]);
  });
});

describe("matches a despatch to its PO line, degrading through the keys", () => {
  const reg = buildDispatchRegister({ order: ORDER, customer: CUSTOMER, poLines: PO_LINES, dispatchLines: DISPATCH });
  const L = byLine(reg);

  it("matches by line_index ordinal and computes partial + balance", () => {
    expect(L["SIV-21N"].matched).toBe("line_index");
    expect(L["SIV-21N"].ordered_qty).toBe(100);       // from the PO line, not a schedule
    expect(L["SIV-21N"].dispatched_qty).toBe(40);
    expect(L["SIV-21N"].balance_qty).toBe(60);
    expect(L["SIV-21N"].status).toBe("partial");
    expect(L["SIV-21N"].invoice_numbers).toEqual(["INV-882"]);
    expect(L["SIV-21N"].lr_numbers).toEqual(["LR4471"]);
  });

  it("falls back to part_no (case-insensitive) when line_index is absent", () => {
    expect(L["TRF-9"].matched).toBe("line_index");
    expect(L["TRF-9"].status).toBe("complete");
    expect(L["CBL-2"].matched).toBe("part_no");
    expect(L["CBL-2"].status).toBe("complete");
    expect(L["CBL-2"].balance_qty).toBe(0);
  });

  it("a line with nothing despatched is 'awaited', not dropped", () => {
    expect(L["BOX-7"].status).toBe("pending");
    expect(L["BOX-7"].dispatched_qty).toBeNull();
    expect(L["BOX-7"].balance_qty).toBe(10);
  });

  it("an unmatched despatch is still listed on its own", () => {
    expect(L["MISC-1"].matched).toBe("unmatched-dispatch");
    expect(L["MISC-1"].dispatched_qty).toBe(5);
    expect(L["MISC-1"].ordered_qty).toBeNull();
  });

  it("summary counts are right", () => {
    expect(reg.summary.line_count).toBe(5);           // 4 PO lines + 1 unmatched
    expect(reg.summary.dispatched_line_count).toBe(4);
    expect(reg.summary.pending_line_count).toBe(1);
    expect(reg.summary.complete_count).toBe(2);
    expect(reg.summary.partial_count).toBe(1);
    expect(reg.summary.total_dispatched_qty).toBe(115);
  });

  it("does NOT double-count: one PO line yields exactly one row", () => {
    expect(reg.lines.filter((l) => l.part_no === "SIV-21N")).toHaveLength(1);
  });

  it("never emits a stray internal field carried on a despatch row", () => {
    expect(JSON.stringify(reg)).not.toMatch(/cost_internal|999/);
  });
});

describe("degrades to shipment headers when there is no line grain", () => {
  const reg = buildDispatchRegister({
    order: ORDER, customer: CUSTOMER, poLines: [], dispatchLines: [],
    shipments: [
      { shipment_number: "SH-1", carrier: "VRL", shipper_invoice_no: "INV-900", customer_delivery_date: "2026-03-18" },
      { shipment_number: "SH-2", carrier: "TCI", shipper_invoice_no: "INV-901", customer_delivery_date: "2026-03-25" },
    ],
  });
  it("produces ONE row per consignment — never a singular arbitrary pick", () => {
    expect(reg.lines).toHaveLength(2);
    expect(reg.degraded?.header_fallback).toBe(true);
    expect(reg.lines[0].matched).toBe("shipment-header");
    expect(reg.lines.map((l) => l.invoice_numbers[0])).toEqual(["INV-900", "INV-901"]);
    expect(reg.lines[0].last_dispatch_date).toBe("2026-03-18");
  });
  it("the rendered body flags that only consignment detail is available", () => {
    const body = renderDispatchRegisterText(reg);
    expect(body).toMatch(/consignment/i);
  });
});

describe("fail-safe visibility via the column template", () => {
  it("drops an unknown extra column unless it is marked visibility:'customer'", () => {
    const cols = resolveColumns({ columns: [
      { key: "part_no", label: "Item" },
      { key: "dispatched_qty", label: "Sent" },
      { key: "cost", label: "Cost" },                              // extra, unmarked -> dropped
      { key: "po_line_ref", label: "Your PO line", visibility: "customer" }, // extra, customer -> kept
    ] });
    expect(cols.map((c) => c.key)).toEqual(["part_no", "dispatched_qty", "po_line_ref"]);
  });
  it("hides a known column when include:false, and relabels", () => {
    const cols = resolveColumns({ columns: [
      { key: "part_no", label: "Item" },
      { key: "status", include: false },
    ] });
    expect(cols.map((c) => c.key)).toEqual(["part_no"]);
    expect(cols[0].label).toBe("Item");
  });
  it("with no template, uses the built-in default columns", () => {
    expect(resolveColumns(null)).toBe(DEFAULT_COLUMNS);
  });
});

describe("renders + degrades gracefully", () => {
  const reg = buildDispatchRegister({ order: ORDER, customer: CUSTOMER, poLines: PO_LINES, dispatchLines: DISPATCH });
  const body = renderDispatchRegisterText(reg, { footer: "Please confirm receipt (GRN)." });

  it("carries the header, the lines, the invoice + LR, and the footer", () => {
    expect(body).toMatch(/Dispatch register — PO PO-5567/);
    expect(body).toMatch(/TI INDIA/);
    expect(body).toMatch(/SIV-21N/);
    expect(body).toMatch(/LR4471/);
    expect(body).toMatch(/INV-882/);
    expect(body).toMatch(/Please confirm receipt/);
  });

  it("omits a column that is empty for every row (no UOM anywhere)", () => {
    expect(body).not.toMatch(/UOM/);
  });

  it("subject names the PO", () => {
    expect(dispatchRegisterSubject(reg)).toBe("Dispatch register — PO PO-5567");
  });

  it("an order with nothing at all is empty for sending", () => {
    const empty = buildDispatchRegister({ order: ORDER, poLines: [], dispatchLines: [], shipments: [] });
    expect(isDispatchRegisterEmpty(empty)).toBe(true);
    expect(renderDispatchRegisterText(empty)).toBe("");
  });
});

describe("the endpoint drafts via commsRow (the #334 guard covers it too)", () => {
  it("uses commsRow + document_type dispatch_register + routing", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "api", "comms", "dispatch_register.js"), "utf8");
    expect(src).toMatch(/insert\(commsRow\(draft\)\)/);
    expect(src).toMatch(/document_type: "dispatch_register"/);
    expect(src).toMatch(/resolveForCustomer\(/);
  });

  it("register assembly (now shared with the auto-send path) unions einvoices + PO lines", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "api", "_lib", "dispatch-register-send.js"), "utf8");
    expect(src).toMatch(/einvoices/);                 // India GST invoices unioned
    expect(src).toMatch(/extractPoLines\(order\)/);   // ordered side = PO lines
  });
});
