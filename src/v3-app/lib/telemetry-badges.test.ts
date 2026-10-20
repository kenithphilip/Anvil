// The nav badges count from each order's stage (plan R-M1, C-10). The SO
// badge counted RECONCILED as active (it excluded statuses that do not
// exist), and a Mode B order that was done stayed active for ever.
// Invented fixtures; stages from the server's own orderStage().

import { describe, it, expect } from "vitest";
import { computeBadges } from "./telemetry";
import { orderStage } from "../../api/_lib/order-stage.js";

const HASH = "hash-1";
const order = (id: string, status: string, over: Record<string, unknown> = {}, mode = "A") => {
  const o = { id, status, payload_hash: HASH, created_at: "2026-10-01T05:00:00.000Z", updated_at: "2026-10-09T05:00:00.000Z", ...over };
  return { ...o, stage: orderStage(o, { mode }) };
};
const approvedB = (id: string, over: Record<string, unknown> = {}) =>
  order(id, "APPROVED", { approval: { payloadHash: HASH }, approved_at: "2026-10-03T05:00:00.000Z", ...over }, "B");

describe("computeBadges", () => {
  it("counts only orders with a next move on the SO badge", () => {
    const b = computeBadges([
      order("d1", "DRAFT"),
      order("p1", "PENDING_REVIEW"),
      approvedB("b1"),
      approvedB("b2", { tally_status: "reconciled" }),
      order("r1", "RECONCILED"),
      order("c1", "CANCELLED"),
      order("x1", "DUPLICATE"),
    ], []);
    // d1, p1 and b1. Verified (b2, r1), cancelled and parked orders are out.
    expect(b.so).toEqual({ v: "3", k: undefined });
  });

  it("counts orders in approval on the Approvals badge, and nothing approved", () => {
    const b = computeBadges([order("p1", "PENDING_REVIEW"), order("p2", "PENDING_REVIEW"), approvedB("b1")], []);
    expect(b.approvals).toEqual({ v: "2", k: "warn" });
  });

  it("counts orders being verified or returned on the Intake badge, not those in approval", () => {
    const b = computeBadges([
      order("d1", "DRAFT"),
      order("d2", "DRAFT", { correction_reason: "Wrong rate" }),
      order("p1", "PENDING_REVIEW"),
      order("x1", "DUPLICATE"),
    ], []);
    expect(b.intake).toEqual({ v: "2", k: "live" });
  });

  it("reads the status when an endpoint sends no stage", () => {
    const b = computeBadges([{ status: "RECONCILED" }, { status: "PENDING_REVIEW" }], []);
    expect(b.so).toEqual({ v: "1", k: undefined });
    expect(b.approvals).toEqual({ v: "1", k: "warn" });
  });
});
