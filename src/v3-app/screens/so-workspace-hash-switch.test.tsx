// The router re-renders only when the ROUTE changes, so a link from one order
// to another (#/so?id=A to #/so?id=B) used to leave the workspace on order A
// until some unrelated render. The challan upload's "Open order" link is such
// a link. The workspace now re-renders on hashchange and loads order B.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const mkOrder = (id: string, po: string) => ({
  id, status: "DRAFT", po_number: po, customer_id: "cust-1", customer_name: "Fixture",
  result: { salesOrder: { lineItems: [{ partNumber: "WG-1", description: "gun", qty: 1, rate: 10, uom: "NOS" }] } },
  preflight_payload: {}, documents: [],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});

let getSpy: any;

beforeEach(() => {
  getSpy = vi.fn(async (id: string) => ({ order: mkOrder(id, id === "ord-A" ? "PO-AAA" : "PO-BBB") }));
  installBackend({
    orders: { get: getSpy, update: vi.fn(async () => ({})) },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  installRbac("sales_manager");
  window.location.hash = "#/so?id=ord-A";
});

describe("SO workspace follows an in-place order switch", () => {
  it("loads the order named by the new hash without any other render", async () => {
    const mod = await import("./so-workspace");
    const { container } = renderScreen(mod.default);
    await waitFor(() => expect(getSpy).toHaveBeenCalledWith("ord-A"));
    // Let order A settle completely, so no pending load can re-render the
    // screen by accident after the hash changes.
    await waitFor(() => expect(container.textContent).toContain("PO-AAA"));
    for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    const callsBefore = getSpy.mock.calls.length;

    await act(async () => {
      window.location.hash = "#/so?id=ord-B&tab=invoice_check";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(getSpy).toHaveBeenCalledWith("ord-B"));
    expect(getSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
