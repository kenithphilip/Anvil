// The SO workspace stepper and next-step bar read the order's stage (plan
// R-M1, C-10). A Mode B order rests at APPROVED after the clerk keys it, so
// the stepper never completed; an approval a later edit cleared still showed
// as approved; and the bar was gone once the order left review.
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";
import { orderStage } from "../../api/_lib/order-stage.js";
import { buildOrderExceptions } from "../../api/_lib/order-exceptions.js";

const ORDER_ID = "ord-stage-1";
const HASH = "hash-1";
const base = (over: any = {}) => ({
  id: ORDER_ID, status: "APPROVED", po_number: "PO-STG-1", po_date: "2026-10-01", customer_id: "cust-1",
  customer: { customer_name: "Stage Buyer" }, payload_hash: HASH,
  approval: { payloadHash: HASH }, approved_at: "2026-10-03T05:00:00.000Z",
  preflight_payload: { source_document_id: "doc-1", last_validated_at: "2026-10-02T00:00:00Z" },
  documents: [{ id: "doc-1" }], created_at: "2026-10-01T05:00:00.000Z", updated_at: "2026-10-09T05:00:00.000Z",
  result: {
    salesOrder: {
      grandTotal: 1500,
      lineItems: [{ partNumber: "ST-1", description: "Part one", qty: 15, rate: 100, uom: "NOS", _match: { verdict: "matched", part_no: "ST-1" } }],
    },
    quoteReconciliation: { summary: { total: 1, matched: 1 }, flags: [], quoted_not_ordered: [] },
  },
  ...over,
});

let update: any;
const mount = async (o: any, { mode = "A", exceptions = undefined as any } = {}) => {
  window.location.hash = "#/so?id=" + o.id;
  update = vi.fn(async () => ({}));
  installBackend({
    orders: {
      get: vi.fn(async () => ({ order: o })), update,
      terms: vi.fn(async () => ({ mode: "off", visible: false, flags: [] })),
      ...(exceptions ? { exceptions: vi.fn(async () => exceptions) } : {}),
    },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
    docai: { soProcessingMode: vi.fn(async () => ({ mode })), getRun: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  const view = renderScreen(mod.default);
  await waitFor(() => expect(view.container.querySelectorAll(".step").length).toBe(6));
  return view;
};

const done = (c: HTMLElement) => c.querySelectorAll(".step.done").length;
const bar = (c: HTMLElement) => c.querySelector("[data-testid='so-next-step-bar']") as HTMLElement | null;

beforeEach(() => {
  installRbac("sales_engineer");
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
});

describe("the stepper reads the stage", () => {
  it("completes a Mode B order verified in Tally, and the bar says there is no next step", async () => {
    const { container } = await mount(base({ tally_status: "reconciled" }), { mode: "B" });
    await waitFor(() => expect(done(container)).toBe(6));
    expect(bar(container)!.getAttribute("data-action")).toBe("none");
    expect(bar(container)!.textContent).toContain("No next step (Verified in ERP)");
  });

  it("completes the order when the server's stage says keyed, from evidence this screen cannot see", async () => {
    const o = base();
    // An attached Tally SO PDF: only the server reads the link.
    const exceptions = { ...buildOrderExceptions({ order: o }), stage: orderStage(o, { mode: "B", erp_so: [{ document_id: "so-pdf-1" }] }) };
    const { container } = await mount(o, { mode: "B", exceptions });
    await waitFor(() => expect(done(container)).toBe(6));
    expect(bar(container)!.getAttribute("data-action")).toBe("verify_in_erp");
  });

  it("stops at Approve when a later edit cleared the approval", async () => {
    const { container } = await mount(base({ approval: null }));
    await waitFor(() => expect(bar(container)!.getAttribute("data-action")).toBe("resubmit_for_approval"));
    expect(done(container)).toBe(4);
    expect(container.querySelector(".step.cur")!.textContent).toContain("Approve");
  });
});

describe("the next-step bar sends a revised order for approval again", () => {
  it("moves the order back to DRAFT, then to PENDING_REVIEW", async () => {
    const { container } = await mount(base({ approval: null }));
    const btn = await waitFor(() => {
      const b = [...bar(container)!.querySelectorAll("button")].find((x) => (x.textContent || "").includes("send for approval again")) as HTMLButtonElement;
      expect(b && !b.disabled).toBe(true);
      return b;
    });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[0]).toEqual([ORDER_ID, { status: "DRAFT" }]);
    expect(update.mock.calls[1]).toEqual([ORDER_ID, { status: "PENDING_REVIEW" }]);
  });
});
