// "New quote" on the opportunity detail card opens the quote form with the
// opportunity and its customer already chosen, and the created quote carries
// both. Kept apart from opps.test.tsx so the drawer's other controls can
// change without touching this.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

let createSpy: any;

beforeEach(() => {
  createSpy = vi.fn(async (p: any) => ({ quote: { id: "q-new", quote_number: "Q-202610-0002", ...p } }));
  installBackend({
    sales: {
      listOpportunities: async () => ({ opportunities: [
        { id: "o-1", opportunity_name: "Line 4 retrofit", customer_id: "c-1", customer_name: "Test Buyer Ltd", stage: "RFQ", value: 100000 },
        { id: "o-2", opportunity_name: "Spares 2027", customer_id: "c-1", customer_name: "Test Buyer Ltd", stage: "RFQ", value: 5000 },
      ] }),
    },
    customers: {
      list: async () => ({ customers: [{ id: "c-1", customer_name: "Test Buyer Ltd" }] }),
      listContacts: async () => ({ contacts: [] }),
    },
    quotes: { list: async () => ({ quotes: [] }), create: createSpy },
  });
  installRbac("sales_engineer");
  window.location.hash = "#/opps?id=o-1";
});
afterEach(() => { window.location.hash = ""; });

describe("Opps detail: New quote", () => {
  it("opens the quote form for this opportunity and its customer", async () => {
    const { default: Opps } = await import("./opps");
    const { findByRole, findByLabelText, getByText } = renderScreen(Opps);
    fireEvent.click(await findByRole("button", { name: "New quote" }));
    const opp = (await findByLabelText("Opportunity")) as HTMLSelectElement;
    await waitFor(() => expect(opp.value).toBe("o-1"));
    const customer = (await findByLabelText("Customer")) as HTMLSelectElement;
    await waitFor(() => expect(customer.value).toBe("c-1"));
    fireEvent.click(getByText("Create draft"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ customer_id: "c-1", opportunity_id: "o-1" });
  });
});
