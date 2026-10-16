// The cancel action used a native confirm(), which a browser can suppress
// ("don't allow more dialogs"); clicking Cancel then silently did nothing, so
// the order looked un-cancellable. It then became an in-app confirmation that
// recorded no reason. It now opens the shared reason dialog: clicking Cancel
// opens it (no PATCH yet), a reason is required, and only the dialog's
// "Cancel order" button sends the status change WITH the reason, which the
// server records on the audit row.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-cancel-1";
const makeOrder = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  status: "DRAFT",
  po_number: "PO-CANCEL-1",
  customer_id: "cust-1",
  customer_name: "Cancel Fixture",
  result: { salesOrder: { lineItems: [{ partNumber: "WG-1", description: "gun", qty: 1, rate: 10, uom: "NOS" }] } },
  preflight_payload: {},
  documents: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

let updateSpy: any;

const mount = async (order: Record<string, unknown>) => {
  installBackend({
    orders: { get: vi.fn(async () => ({ order })), update: updateSpy },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  return renderScreen(mod.default);
};

beforeEach(() => {
  updateSpy = vi.fn(async () => ({}));
  // sales_manager holds the so.cancel action, so the button is enabled.
  installRbac("sales_manager");
  // If the native confirm were still in play, this would auto-accept it; the
  // test asserts the PATCH does NOT fire on the first click, proving it's gone.
  vi.stubGlobal("confirm", () => true);
  (window as any).notifySuccess = vi.fn();
  window.location.hash = "#/so?id=" + ORDER_ID;
});

const findCancelButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("title") === "Set order status to CANCELLED",
  ) as HTMLButtonElement | undefined;
const dialogButton = (label: string) =>
  Array.from(document.querySelectorAll("[role='dialog'] button")).find(
    (b) => (b.textContent || "").trim() === label,
  ) as HTMLButtonElement | undefined;
const reasonBox = () => document.querySelector("[role='dialog'] [data-testid='reason-input']") as HTMLTextAreaElement;

describe("SoWorkspace cancel", () => {
  it("opens the reason dialog, needs a reason, and sends it with the cancel", async () => {
    const { container } = await mount(makeOrder());

    let cancelBtn: HTMLButtonElement | undefined;
    await waitFor(() => {
      cancelBtn = findCancelButton(container);
      expect(cancelBtn).toBeTruthy();
      expect(cancelBtn!.disabled).toBe(false);
    });

    // Clicking Cancel must NOT fire the PATCH: it opens the dialog.
    await act(async () => { fireEvent.click(cancelBtn!); });
    expect(updateSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.querySelector("[role='dialog']")!.textContent).toContain("Cancel this sales order?");
    });

    // No reason, no cancel.
    expect(dialogButton("Cancel order")!.disabled).toBe(true);
    await act(async () => { fireEvent.change(reasonBox(), { target: { value: "dup" } }); });
    expect(dialogButton("Cancel order")!.disabled).toBe(true);

    await act(async () => { fireEvent.change(reasonBox(), { target: { value: "  Customer withdrew the PO by email  " } }); });
    expect(dialogButton("Cancel order")!.disabled).toBe(false);
    await act(async () => { fireEvent.click(dialogButton("Cancel order")!); });
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(ORDER_ID, { status: "CANCELLED", reason: "Customer withdrew the PO by email" });
    });
  });

  it("closes without a PATCH on Keep order", async () => {
    const { container } = await mount(makeOrder());
    await waitFor(() => expect(findCancelButton(container)?.disabled).toBe(false));
    await act(async () => { fireEvent.click(findCancelButton(container)!); });
    await act(async () => { fireEvent.click(dialogButton("Keep order")!); });
    expect(document.querySelector("[role='dialog']")).toBe(null);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("is not offered after the order is exported to Tally, where the server refuses it", async () => {
    const { container } = await mount(makeOrder({ status: "EXPORTED_TO_TALLY" }));
    await waitFor(() => expect(findCancelButton(container)).toBeTruthy());
    expect(findCancelButton(container)!.disabled).toBe(true);
  });
});
