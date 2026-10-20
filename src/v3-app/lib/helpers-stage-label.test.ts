// One stage label and one order value for every screen (plan R-M1, C-10).
// The stages come from the server's own pure orderStage(), so the screens
// and the API read the same answer. Invented fixtures.

import { describe, it, expect } from "vitest";
import { awaitsAction, fmtOrderValue, orderValue, stageChip, stageKeyOf, stageLabel } from "./helpers";
import { orderStage } from "../../api/_lib/order-stage.js";

const HASH = "hash-1";
const approved = (over: Record<string, unknown> = {}) => ({
  id: "o-1", status: "APPROVED", approval: { payloadHash: HASH }, approved_at: "2026-10-03T05:00:00.000Z",
  payload_hash: HASH, created_at: "2026-10-01T05:00:00.000Z", updated_at: "2026-10-09T05:00:00.000Z", ...over,
});
const staged = <T extends Record<string, any>>(o: T, ev: Record<string, unknown> = {}) => ({ ...o, stage: orderStage(o, ev) });

describe("stageLabel and stageChip", () => {
  it("labels each server stage key as the server does", () => {
    expect(stageLabel("in_approval")).toBe("In approval");
    expect(stageLabel("approved")).toBe("Approved");
    expect(stageLabel("keyed")).toBe("Keyed in ERP");
    expect(stageLabel("verified")).toBe("Verified in ERP");
  });

  it("reads the stage the server sent, not the status", () => {
    // Mode B: status stays APPROVED after the clerk keys and the check passes.
    const o = staged(approved({ tally_status: "reconciled" }), { mode: "B" });
    expect(o.status).toBe("APPROVED");
    expect(stageChip(o)).toEqual({ label: "Verified in ERP", k: "good" });
  });

  it("shows an approval a later edit cleared as Verifying", () => {
    const o = staged(approved({ approval: null }));
    expect(stageChip(o).label).toBe("Verifying");
  });

  it("falls back to the status when an endpoint sends no stage", () => {
    expect(stageChip({ status: "PENDING_REVIEW" }).label).toBe("In approval");
    expect(stageChip({ status: "APPROVED" }).label).toBe("Approved");
    expect(stageChip({ status: "EXPORTED_TO_TALLY" }).label).toBe("Keyed in ERP");
    expect(stageChip({ status: "RECONCILED" }).label).toBe("Verified in ERP");
    expect(stageChip({ status: "CANCELLED" })).toEqual({ label: "Cancelled", k: "ghost" });
  });

  it("names a status the stage label hides", () => {
    expect(stageChip({ status: "BLOCKED" })).toEqual({ label: "Verifying, blocked", k: "bad" });
    expect(stageChip(staged(approved({ status: "FAILED_TALLY_IMPORT" })))).toEqual({ label: "Approved, push failed", k: "bad" });
  });

  it("gives a ghost chip for a status it does not know", () => {
    expect(stageKeyOf({ status: "WEIRD_STATE" })).toBe(null);
    expect(stageChip({ status: "WEIRD_STATE" })).toEqual({ label: "weird_state", k: "ghost" });
  });
});

describe("awaitsAction", () => {
  it("is false once the order is verified or cancelled", () => {
    expect(awaitsAction(staged(approved({ tally_status: "reconciled" }), { mode: "B" }))).toBe(false);
    expect(awaitsAction(staged({ id: "o-2", status: "CANCELLED" }))).toBe(false);
    expect(awaitsAction({ status: "RECONCILED" })).toBe(false);
  });

  it("is false for a parked order with no forward step", () => {
    expect(awaitsAction(staged({ id: "o-3", status: "DUPLICATE" }))).toBe(false);
  });

  it("is true while a Mode B order waits for its handoff, and for a keyed Mode A order", () => {
    expect(awaitsAction(staged(approved(), { mode: "B" }))).toBe(true);
    expect(awaitsAction(staged(approved({ status: "EXPORTED_TO_TALLY" })))).toBe(true);
    expect(awaitsAction({ status: "DRAFT" })).toBe(true);
  });
});

describe("orderValue and fmtOrderValue", () => {
  it("takes the printed grand total first", () => {
    expect(orderValue({ result: { salesOrder: { grandTotal: 5000, lineItems: [{ qty: 1, rate: 10 }] } } })).toBe(5000);
  });

  it("sums the line totals when the PO prints no grand total", () => {
    const o = { result: { salesOrder: { lineItems: [{ qty: 2, rate: 100, gst_pct: 18 }, { qty: 1, rate: 50 }] } } };
    expect(orderValue(o)).toBe(286);
    expect(fmtOrderValue(o)).toBe(fmtOrderValue({ result: { salesOrder: { grandTotal: 286 } } }));
  });

  it("sums the lines it is given, for unsaved edits", () => {
    expect(orderValue({ result: { salesOrder: { lineItems: [{ qty: 1, rate: 10 }] } } }, [{ qty: 3, rate: 10 }])).toBe(30);
  });

  it("is null for an order with no total and no priced line", () => {
    expect(orderValue({ result: { salesOrder: { lineItems: [{ qty: 1 }] } } })).toBe(null);
    expect(orderValue(null)).toBe(null);
  });

  it("prints the order's own currency", () => {
    expect(fmtOrderValue({ result: { salesOrder: { grandTotal: 1234.5, currency: "USD" } } })).toBe("$1,234.50");
    expect(fmtOrderValue({ result: { salesOrder: { grandTotal: 120000 } } }, { compact: true })).toBe("₹ 120k");
  });
});
