// Tests for the Quotes panel on the opportunity detail card. Stubs
// quotes.list and asserts the panel renders rows + calls the API with
// the right opportunity_id filter.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { OpportunityQuotesPanel } from "./OpportunityQuotesPanel";

const QUOTES = [
  { id: "q1", quote_number: "Q-202605-0001", version: 1, status: "DRAFT", grand_total: 5000, expires_at: null, updated_at: new Date().toISOString() },
  { id: "q2", quote_number: "Q-202605-0002", version: 2, status: "SENT", grand_total: 7500, expires_at: new Date().toISOString(), updated_at: new Date().toISOString() },
];

describe("OpportunityQuotesPanel", () => {
  let listSpy: any;
  beforeEach(() => {
    listSpy = vi.fn(async () => ({ quotes: QUOTES }));
    installBackend({ quotes: { list: listSpy } });
  });

  it("calls quotes.list with the opportunity_id filter", async () => {
    render(<OpportunityQuotesPanel opportunityId="OPP-1" />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));
    expect(listSpy.mock.calls[0][0]).toMatchObject({ opportunity_id: "OPP-1" });
  });

  it("renders a row per quote with status + number", async () => {
    const { findByText, getByText } = render(<OpportunityQuotesPanel opportunityId="OPP-1" />);
    expect(await findByText("Q-202605-0001")).toBeTruthy();
    expect(getByText("Q-202605-0002")).toBeTruthy();
    expect(getByText("DRAFT")).toBeTruthy();
    expect(getByText("SENT")).toBeTruthy();
  });

  it("New quote opens the modal with this opportunity and its customer, and saves both", async () => {
    const createSpy = vi.fn(async (payload: any) => ({ quote: { id: "q-new", quote_number: "Q-202610-0001", ...payload } }));
    installBackend({
      quotes: { list: listSpy, create: createSpy },
      customers: {
        list: vi.fn(async () => ({ customers: [{ id: "CUST-1", customer_name: "Test Buyer Ltd" }] })),
        listContacts: vi.fn(async () => ({ contacts: [] })),
      },
      sales: {
        listOpportunities: vi.fn(async () => ({ opportunities: [
          { id: "OPP-1", customer_id: "CUST-1", opportunity_name: "Line 4 retrofit", stage: "RFQ" },
          { id: "OPP-2", customer_id: "CUST-1", opportunity_name: "Spares 2027", stage: "RFQ" },
        ] })),
      },
    });
    window.location.hash = "#/opps";
    const { findByText, getByText, getByLabelText } = render(<OpportunityQuotesPanel opportunityId="OPP-1" customerId="CUST-1" />);
    fireEvent.click(await findByText("New quote"));
    await findByText("Line 4 retrofit - RFQ");
    expect((getByLabelText("Customer") as HTMLSelectElement).value).toBe("CUST-1");
    expect((getByLabelText("Opportunity") as HTMLSelectElement).value).toBe("OPP-1");
    fireEvent.click(getByText("Create draft"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ customer_id: "CUST-1", opportunity_id: "OPP-1" });
    // Straight into the new draft's lines.
    await waitFor(() => expect(window.location.hash).toBe("#/quotes?id=q-new&tab=lines"));
  });

  it("offers no New quote without the opportunity's customer", async () => {
    const { findByText, queryByText } = render(<OpportunityQuotesPanel opportunityId="OPP-1" />);
    await findByText("Q-202605-0001");
    expect(queryByText("New quote")).toBeNull();
  });

  it("shows the empty-state when there are no quotes for the opp", async () => {
    installBackend({ quotes: { list: vi.fn(async () => ({ quotes: [] })) } });
    const { findByText } = render(<OpportunityQuotesPanel opportunityId="OPP-1" />);
    expect(await findByText(/No quotes yet/i)).toBeTruthy();
  });
});
