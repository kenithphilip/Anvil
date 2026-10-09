// Tests for the create-from-scratch entry modal. Verifies the
// customer list loads, a selection enables the create button, and
// submitting POSTs the right payload + hands the new quote back.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { NewQuoteModal } from "./NewQuoteModal";

const CUSTOMERS = [
  { id: "cust-1", customer_name: "Meridian Motor India Ltd", customer_key: "hyundai", default_quote_validity_days: 45, currency: "USD" },
  { id: "cust-2", customer_name: "Comet Motors", customer_key: "tata" },
];

const CONTACTS: Record<string, any[]> = {
  "cust-1": [
    { id: "ct-1a", name: "Asha Rao", email: "asha@hyundai.example", is_primary: true, role: "procurement" },
    { id: "ct-1b", name: "Vikram Shah", email: "vikram@hyundai.example", is_primary: false, role: "accounts" },
  ],
  "cust-2": [],
};

// Opportunities per customer, as GET /api/sales/opportunities?customer_id=
// returns them. cust-1 has two open and one lost; cust-2 has one open.
const OPPS: Record<string, any[]> = {
  "cust-1": [
    { id: "opp-1", customer_id: "cust-1", opportunity_name: "Line 4 retrofit", stage: "NEGOTIATION_REVIEW" },
    { id: "opp-2", customer_id: "cust-1", opportunity_name: "Spares 2027", stage: "RFQ" },
    { id: "opp-3", customer_id: "cust-1", opportunity_name: "Old robot cell", stage: "CLOSE_LOST" },
  ],
  "cust-2": [
    { id: "opp-9", customer_id: "cust-2", opportunity_name: "Weld line", stage: "QUALIFICATION" },
  ],
};

describe("NewQuoteModal", () => {
  let createSpy: any;
  let listContactsSpy: any;
  let listOppsSpy: any;
  beforeEach(() => {
    createSpy = vi.fn(async (payload: any) => ({ quote: { id: "q-new", quote_number: "Q-202605-0001", ...payload } }));
    listContactsSpy = vi.fn(async ({ customer_id }: any) => ({ contacts: CONTACTS[customer_id] || [] }));
    listOppsSpy = vi.fn(async ({ customer_id }: any) => ({ opportunities: OPPS[customer_id] || [] }));
    installBackend({
      customers: {
        list: vi.fn(async () => ({ customers: CUSTOMERS })),
        listContacts: listContactsSpy,
      },
      quotes: { create: createSpy },
      sales: { listOpportunities: listOppsSpy },
    });
  });

  it("lists the customer's open opportunities and saves the one picked", async () => {
    const { getByText, getByLabelText, queryByText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Meridian Motor India Ltd")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-1" } });
    await waitFor(() => expect(listOppsSpy).toHaveBeenCalledWith({ customer_id: "cust-1" }));
    await waitFor(() => expect(getByText("Spares 2027 - RFQ")).toBeTruthy());
    expect(getByText("Line 4 retrofit - NEGOTIATION_REVIEW")).toBeTruthy();
    // A lost opportunity takes no new quote.
    expect(queryByText(/Old robot cell/)).toBeNull();
    // Two open ones: nothing is preselected.
    expect((getByLabelText("Opportunity") as HTMLSelectElement).value).toBe("");
    fireEvent.change(getByLabelText("Opportunity"), { target: { value: "opp-2" } });
    fireEvent.click(getByText("Create draft"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ customer_id: "cust-1", opportunity_id: "opp-2" });
  });

  it("preselects the customer's only open opportunity", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Comet Motors")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-2" } });
    await waitFor(() => expect((getByLabelText("Opportunity") as HTMLSelectElement).value).toBe("opp-9"));
  });

  it("starts with the opportunity and customer it was opened from", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined}
                     initialCustomerId="cust-1" initialOpportunityId="opp-1" />
    );
    await waitFor(() => expect(getByText("Line 4 retrofit - NEGOTIATION_REVIEW")).toBeTruthy());
    expect((getByLabelText("Customer") as HTMLSelectElement).value).toBe("cust-1");
    expect((getByLabelText("Opportunity") as HTMLSelectElement).value).toBe("opp-1");
    // The customer's own defaults still apply.
    await waitFor(() => expect((getByLabelText("Currency") as HTMLInputElement).value).toBe("USD"));
    fireEvent.click(getByText("Create draft"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ customer_id: "cust-1", opportunity_id: "opp-1" });
  });

  it("drops the opportunity when the customer changes", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined}
                     initialCustomerId="cust-1" initialOpportunityId="opp-1" />
    );
    await waitFor(() => expect((getByLabelText("Opportunity") as HTMLSelectElement).value).toBe("opp-1"));
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-2" } });
    await waitFor(() => expect(getByText("Weld line - QUALIFICATION")).toBeTruthy());
    fireEvent.click(getByText("Create draft"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    // The new customer's only open opportunity, never the old customer's.
    expect(createSpy.mock.calls[0][0]).toMatchObject({ customer_id: "cust-2", opportunity_id: "opp-9" });
  });

  it("sends opportunity_id = null when the operator picks no opportunity", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Comet Motors")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-2" } });
    await waitFor(() => expect((getByLabelText("Opportunity") as HTMLSelectElement).value).toBe("opp-9"));
    fireEvent.change(getByLabelText("Opportunity"), { target: { value: "" } });
    fireEvent.click(getByText("Create draft"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ customer_id: "cust-2", opportunity_id: null });
  });

  it("loads customers and disables create until one is chosen", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Meridian Motor India Ltd")).toBeTruthy());
    const createBtn = getByText("Create draft") as HTMLButtonElement;
    expect(createBtn.hasAttribute("disabled")).toBe(true);
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-1" } });
    expect((getByText("Create draft") as HTMLButtonElement).hasAttribute("disabled")).toBe(false);
  });

  it("posts customer_id + defaults and returns the created quote", async () => {
    const onCreated = vi.fn();
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={onCreated} />
    );
    await waitFor(() => expect(getByText("Comet Motors")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-2" } });
    fireEvent.click(getByText("Create draft"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ customer_id: "cust-2", currency: "INR", validity_days: 30 });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "q-new" })));
  });

  it("adopts the customer's default quote validity when set", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Meridian Motor India Ltd")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-1" } });
    expect((getByLabelText("Validity days") as HTMLInputElement).value).toBe("45");
  });

  it("prefills currency from the customer when set", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Meridian Motor India Ltd")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-1" } });
    expect((getByLabelText("Currency") as HTMLInputElement).value).toBe("USD");
  });

  it("loads the customer's contacts and defaults to the primary", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Meridian Motor India Ltd")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-1" } });
    await waitFor(() => expect(listContactsSpy).toHaveBeenCalledWith({ customer_id: "cust-1" }));
    await waitFor(() => expect((getByLabelText("Contact") as HTMLSelectElement).value).toBe("ct-1a"));
  });

  it("includes the picked customer_contact_id in the create payload", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Meridian Motor India Ltd")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-1" } });
    await waitFor(() => expect((getByLabelText("Contact") as HTMLSelectElement).value).toBe("ct-1a"));
    fireEvent.change(getByLabelText("Contact"), { target: { value: "ct-1b" } });
    fireEvent.click(getByText("Create draft"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ customer_id: "cust-1", customer_contact_id: "ct-1b" });
  });

  it("sends customer_contact_id = null when the customer has no contacts", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Comet Motors")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-2" } });
    await waitFor(() => expect(listContactsSpy).toHaveBeenCalledWith({ customer_id: "cust-2" }));
    fireEvent.click(getByText("Create draft"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ customer_id: "cust-2", customer_contact_id: null });
  });
});
