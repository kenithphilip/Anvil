// The SO workspace's approve button and the pipeline kanban's Approve drop
// send one body, built by approvalPatch in lib/helpers. The server
// (src/api/orders/[id].js) refuses an approval without the order's payload
// hash, so this pins the body the button sends.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-approve-1";
const makeOrder = (extra: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  status: "PENDING_REVIEW",
  po_number: "PO-APPROVE-1",
  customer_id: "cust-1",
  customer_name: "Approve Fixture",
  result: { salesOrder: { lineItems: [{ partNumber: "WG-1", description: "gun", qty: 1, rate: 10, uom: "NOS" }] } },
  preflight_payload: {},
  documents: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...extra,
});

let updateSpy: any;
let notifyError: any;

const mount = async (order: Record<string, unknown>) => {
  installBackend({
    orders: { get: vi.fn(async () => ({ order })), update: updateSpy },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  const { container } = renderScreen(mod.default);
  let btn: HTMLButtonElement | undefined;
  await waitFor(() => {
    btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("title") === "Approve order",
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(false);
  });
  return btn!;
};

beforeEach(() => {
  updateSpy = vi.fn(async () => ({}));
  notifyError = vi.fn();
  (window as any).notifyError = notifyError;
  (window as any).notifySuccess = vi.fn();
  // sales_manager holds so.approve.
  installRbac("sales_manager");
  window.location.hash = "#/so?id=" + ORDER_ID;
});

describe("SoWorkspace approve", () => {
  it("sends the order's payload hash with the approval", async () => {
    const btn = await mount(makeOrder({ payload_hash: "hash-ws-1" }));
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(ORDER_ID, {
        status: "APPROVED",
        approval: { payloadHash: "hash-ws-1" },
      });
    });
  });

  it("says why, and sends nothing, when the order has no payload hash", async () => {
    const btn = await mount(makeOrder());
    await act(async () => { fireEvent.click(btn); });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith("Approve failed", expect.stringMatching(/no payload hash/));
  });
});
