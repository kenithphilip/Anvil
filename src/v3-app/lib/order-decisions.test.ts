// orderDecisions reads an order's audit rows into the Approval tab's
// decision history. Invented rows.

import { describe, it, expect } from "vitest";
import { orderDecisions, DECISION_LABEL } from "./order-decisions";

const row = (over: Record<string, unknown>) => ({ object_type: "order", created_at: "2026-10-10T10:00:00Z", ...over });

describe("orderDecisions", () => {
  it("lists approvals, returns and cancels with their reasons, newest first", () => {
    const out = orderDecisions([
      row({ action: "approve_order", actor_role: "finance", created_at: "2026-10-10T10:00:00Z" }),
      row({ action: "manager_requested_correction", actor_role: "sales_manager", reason: "  Wrong rate on line 3 ", created_at: "2026-10-11T10:00:00Z" }),
      row({ action: "update_order", actor_role: "admin", reason: "Duplicate of another PO", created_at: "2026-10-12T10:00:00Z", before_payload: { status: "DRAFT" }, after_payload: { status: "CANCELLED" } }),
    ]);
    expect(out).toEqual([
      { kind: "cancelled", at: "2026-10-12T10:00:00Z", role: "admin", reason: "Duplicate of another PO" },
      { kind: "returned", at: "2026-10-11T10:00:00Z", role: "sales_manager", reason: "Wrong rate on line 3" },
      { kind: "approved", at: "2026-10-10T10:00:00Z", role: "finance", reason: null },
    ]);
    expect(out.map((d) => DECISION_LABEL[d.kind])).toEqual(["Cancelled", "Returned for fix", "Approved"]);
  });

  it("leaves out edits that are not decisions", () => {
    expect(orderDecisions([
      row({ action: "update_order", before_payload: { status: "DRAFT" }, after_payload: { status: "DRAFT" } }),
      row({ action: "update_order", before_payload: { status: "DRAFT" }, after_payload: { status: "PENDING_REVIEW" } }),
      row({ action: "order_finding_resolved", reason: "false positive" }),
      row({ action: "update_order", before_payload: { status: "CANCELLED" }, after_payload: { status: "CANCELLED" } }),
    ])).toEqual([]);
  });

  it("is safe on anything that is not a list of rows", () => {
    expect(orderDecisions(null)).toEqual([]);
    expect(orderDecisions({ events: [] })).toEqual([]);
    expect(orderDecisions([null, 42, "x"])).toEqual([]);
  });
});
