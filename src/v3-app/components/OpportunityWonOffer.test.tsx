// The SO workspace proposes CLOSE_WON when a customer PO is linked to an
// open opportunity (decision D15). It never moves the stage by itself: the
// move is one click plus a confirm, through the opportunity stage API, and
// a refusal from that API is shown as it was worded.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { OpportunityWonOffer } from "./OpportunityWonOffer";

const ORDER = { id: "ord-1", status: "PENDING_REVIEW", po_number: "PO-TEST-77", customer_id: "cust-1", opportunity_id: "opp-1" };
const OPEN = { id: "opp-1", customer_id: "cust-1", opportunity_name: "Line 4 retrofit", stage: "NEGOTIATION_REVIEW" };

describe("OpportunityWonOffer", () => {
  let listSpy: any;
  let updateSpy: any;
  const install = (opps: any[]) => {
    listSpy = vi.fn(async () => ({ opportunities: opps }));
    updateSpy = vi.fn(async (p: any) => ({ opportunity: { ...OPEN, stage: p.stage } }));
    installBackend({ sales: { listOpportunities: listSpy, updateOpportunity: updateSpy } });
  };
  beforeEach(() => install([OPEN]));
  afterEach(() => { try { window.localStorage.removeItem("anvil:v3_role"); } catch (_) { /* no storage */ } });

  it("offers the win, and moves the stage only after the click and the confirm", async () => {
    const { findByText, getByText, queryByText } = render(<OpportunityWonOffer order={ORDER} />);
    await findByText("This PO is linked to an open opportunity");
    expect(listSpy).toHaveBeenCalledWith({ customer_id: "cust-1" });
    // Shown, not done: nothing moved yet.
    expect(updateSpy).not.toHaveBeenCalled();
    fireEvent.click(getByText("Mark opportunity won"));
    expect(updateSpy).not.toHaveBeenCalled();
    fireEvent.click(getByText("Mark won"));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith({ id: "opp-1", stage: "CLOSE_WON" }));
    expect(updateSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(queryByText("This PO is linked to an open opportunity")).toBeNull());
  });

  it("does nothing when the operator says not now", async () => {
    const { findByText, getByText } = render(<OpportunityWonOffer order={ORDER} />);
    fireEvent.click(await findByText("Mark opportunity won"));
    fireEvent.click(getByText("Not now"));
    expect(updateSpy).not.toHaveBeenCalled();
    expect(getByText("This PO is linked to an open opportunity")).toBeTruthy();
  });

  it("shows the stage API's 409 as it was worded", async () => {
    updateSpy.mockImplementationOnce(async () => {
      const err: any = new Error("Cannot move opportunity from CLOSE_LOST to CLOSE_WON directly.");
      err.status = 409;
      throw err;
    });
    const { findByText, getByText } = render(<OpportunityWonOffer order={ORDER} />);
    fireEvent.click(await findByText("Mark opportunity won"));
    fireEvent.click(getByText("Mark won"));
    expect(await findByText("The stage change was refused")).toBeTruthy();
    expect(getByText("Cannot move opportunity from CLOSE_LOST to CLOSE_WON directly.")).toBeTruthy();
  });

  it("is not offered for an opportunity that is already closed", async () => {
    install([{ ...OPEN, stage: "CLOSE_WON" }]);
    const { queryByText } = render(<OpportunityWonOffer order={ORDER} />);
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    // Let the lookup land before checking that nothing is offered.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(queryByText("Mark opportunity won")).toBeNull();
  });

  it("is not offered for an order with no customer PO", async () => {
    const { queryByText } = render(<OpportunityWonOffer order={{ ...ORDER, po_number: null }} />);
    await Promise.resolve();
    expect(listSpy).not.toHaveBeenCalled();
    expect(queryByText("Mark opportunity won")).toBeNull();
  });

  it("is not offered for an order with no opportunity", async () => {
    const { queryByText } = render(<OpportunityWonOffer order={{ ...ORDER, opportunity_id: null }} />);
    await Promise.resolve();
    expect(listSpy).not.toHaveBeenCalled();
    expect(queryByText("Mark opportunity won")).toBeNull();
  });

  it("is not offered on a cancelled order", async () => {
    const { queryByText } = render(<OpportunityWonOffer order={{ ...ORDER, status: "CANCELLED" }} />);
    await Promise.resolve();
    expect(listSpy).not.toHaveBeenCalled();
    expect(queryByText("Mark opportunity won")).toBeNull();
  });

  it("is not offered to a role that cannot edit opportunities", async () => {
    window.localStorage.setItem("anvil:v3_role", "procurement");
    const { queryByText } = render(<OpportunityWonOffer order={ORDER} />);
    await Promise.resolve();
    expect(listSpy).not.toHaveBeenCalled();
    expect(queryByText("Mark opportunity won")).toBeNull();
  });
});
