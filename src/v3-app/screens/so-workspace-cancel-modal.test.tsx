// The cancel action used a native confirm(), which a browser can suppress
// ("don't allow more dialogs") — clicking Cancel then silently did nothing, so
// the order looked un-cancellable. It's now an in-app Modal: clicking Cancel
// opens a confirmation (no PATCH yet); only the modal's "Cancel order" button
// fires the status → CANCELLED update.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-cancel-1";
const order = {
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
};

let updateSpy: any;

beforeEach(() => {
  updateSpy = vi.fn(async () => ({}));
  installBackend({
    orders: { get: vi.fn(async () => ({ order })), update: updateSpy },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  // sales_manager holds the so.cancel action, so the button is enabled.
  installRbac("sales_manager");
  // If the native confirm were still in play, this would auto-accept it — the
  // test asserts the PATCH does NOT fire on the first click, proving it's gone.
  vi.stubGlobal("confirm", () => true);
  window.location.hash = "#/so?id=" + ORDER_ID;
});

const findCancelButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("title") === "Set order status to CANCELLED",
  ) as HTMLButtonElement | undefined;

describe("SoWorkspace cancel confirmation", () => {
  it("opens an in-app modal instead of a native confirm, and only cancels on confirm", async () => {
    const mod = await import("./so-workspace");
    const { container } = renderScreen(mod.default);

    let cancelBtn: HTMLButtonElement | undefined;
    await waitFor(() => {
      cancelBtn = findCancelButton(container);
      expect(cancelBtn).toBeTruthy();
      expect(cancelBtn!.disabled).toBe(false);
    });

    // Clicking Cancel must NOT fire the PATCH — it opens the confirmation.
    await act(async () => { fireEvent.click(cancelBtn!); });
    expect(updateSpy).not.toHaveBeenCalled();

    // The in-app confirmation is now shown.
    await waitFor(() => {
      expect(document.body.textContent || "").toContain("Cancel this sales order?");
    });

    // The modal's "Cancel order" button performs the status change.
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Cancel order",
    ) as HTMLButtonElement | undefined;
    expect(confirmBtn).toBeTruthy();

    await act(async () => { fireEvent.click(confirmBtn!); });
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(ORDER_ID, { status: "CANCELLED" });
    });
  });
});
