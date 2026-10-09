// The SO workspace proposes CLOSE_WON for a PO linked to an open opportunity
// (decision D15). It never moves the stage on load; one click and a confirm
// call the opportunity stage API, and the order itself is not written.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-won-1";
const makeOrder = (extra: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  status: "PENDING_REVIEW",
  po_number: "PO-WON-1",
  customer_id: "cust-1",
  customer_name: "Won Fixture",
  opportunity_id: "opp-1",
  result: { salesOrder: { lineItems: [{ partNumber: "WG-1", description: "gun", qty: 1, rate: 10, uom: "NOS" }] } },
  preflight_payload: {},
  documents: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...extra,
});

let orderUpdateSpy: any;
let oppUpdateSpy: any;
let oppListSpy: any;

const mount = async (order: Record<string, unknown>) => {
  installBackend({
    orders: { get: vi.fn(async () => ({ order })), update: orderUpdateSpy },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
    sales: { listOpportunities: oppListSpy, updateOpportunity: oppUpdateSpy },
  });
  const mod = await import("./so-workspace");
  return renderScreen(mod.default);
};

beforeEach(() => {
  orderUpdateSpy = vi.fn(async () => ({}));
  oppUpdateSpy = vi.fn(async (p: any) => ({ opportunity: { id: p.id, stage: p.stage } }));
  oppListSpy = vi.fn(async () => ({ opportunities: [
    { id: "opp-1", customer_id: "cust-1", opportunity_name: "Line 4 retrofit", stage: "NEGOTIATION_REVIEW" },
  ] }));
  (window as any).notifyError = vi.fn();
  (window as any).notifySuccess = vi.fn();
  installRbac("sales_manager");
  window.location.hash = "#/so?id=" + ORDER_ID;
});

describe("SoWorkspace opportunity win offer", () => {
  it("offers the win for a PO linked to an open opportunity, and calls the stage API on click", async () => {
    const { findByText, getByText } = await mount(makeOrder());
    const offer = await findByText("Mark opportunity won");
    expect(oppUpdateSpy).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(offer); });
    await act(async () => { fireEvent.click(getByText("Mark won")); });
    await waitFor(() => expect(oppUpdateSpy).toHaveBeenCalledWith({ id: "opp-1", stage: "CLOSE_WON" }));
    // The order is not written by the offer.
    expect(orderUpdateSpy).not.toHaveBeenCalled();
  });

  it("offers nothing when the order is not linked to an opportunity", async () => {
    const { findByText, queryByText } = await mount(makeOrder({ opportunity_id: null }));
    await findByText(/PO-WON-1/);
    expect(oppListSpy).not.toHaveBeenCalled();
    expect(queryByText("Mark opportunity won")).toBeNull();
  });
});
