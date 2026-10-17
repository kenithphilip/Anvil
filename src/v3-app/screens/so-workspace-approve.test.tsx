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
let notifyWarn: any;
let getSpy: any;

const mount = async (order: Record<string, unknown>) => {
  getSpy = vi.fn(async () => ({ order }));
  installBackend({
    orders: { get: getSpy, update: updateSpy },
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
  notifyWarn = vi.fn();
  (window as any).notifyError = notifyError;
  (window as any).notifyWarn = notifyWarn;
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

  it("reloads the order and says it changed when the server finds the hash stale", async () => {
    // The client's apiFetch error for 409 STALE_APPROVAL (src/api/orders/[id].js).
    updateSpy = vi.fn(async () => {
      throw Object.assign(new Error("This order changed since you opened it."), {
        status: 409, body: { error: { code: "STALE_APPROVAL", message: "This order changed since you opened it." } },
      });
    });
    const btn = await mount(makeOrder({ payload_hash: "hash-ws-old" }));
    const loads = getSpy.mock.calls.length;
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => {
      expect(notifyWarn).toHaveBeenCalledWith("This order changed since you opened it", expect.stringMatching(/reloaded/));
    });
    expect(notifyError).not.toHaveBeenCalled();
    await waitFor(() => expect(getSpy.mock.calls.length).toBeGreaterThan(loads));
  });

  it("shows the server's words and reloads when an open exception blocks the approval", async () => {
    // The client's apiFetch error for 409 ORDER_HAS_BLOCKING_EXCEPTION
    // (src/api/_lib/order-move-gate.js): the message names the rows.
    const message = "Cannot approve this order. Blocked by: Liquidated damages: only the PO states it. Decide it on the order first.";
    updateSpy = vi.fn(async () => {
      throw Object.assign(new Error(message), { status: 409, body: { error: { code: "ORDER_HAS_BLOCKING_EXCEPTION", message } } });
    });
    const btn = await mount(makeOrder({ payload_hash: "hash-ws-1" }));
    const loads = getSpy.mock.calls.length;
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(notifyWarn).toHaveBeenCalledWith("An open exception blocks this order", message));
    expect(notifyError).not.toHaveBeenCalled();
    await waitFor(() => expect(getSpy.mock.calls.length).toBeGreaterThan(loads));
  });

  it("still reports any other approve failure as an error", async () => {
    updateSpy = vi.fn(async () => {
      throw Object.assign(new Error("Cannot approve: unresolved blocking finding"), { status: 409, body: { error: { code: "ORDER_HAS_UNRESOLVED_BLOCKER" } } });
    });
    const btn = await mount(makeOrder({ payload_hash: "hash-ws-1" }));
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(notifyError).toHaveBeenCalledWith("Approve failed", expect.stringMatching(/blocking finding/)));
    expect(notifyWarn).not.toHaveBeenCalled();
  });

  it("says why, and sends nothing, when the order has no payload hash", async () => {
    const btn = await mount(makeOrder());
    await act(async () => { fireEvent.click(btn); });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith("Approve failed", expect.stringMatching(/no payload hash/));
  });
});
