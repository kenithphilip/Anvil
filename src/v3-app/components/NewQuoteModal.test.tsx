// Tests for the create-from-scratch entry modal. Verifies the
// customer list loads, a selection enables the create button, and
// submitting POSTs the right payload + hands the new quote back.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { NewQuoteModal } from "./NewQuoteModal";

const CUSTOMERS = [
  { id: "cust-1", customer_name: "Hyundai Motor India Ltd", customer_key: "hyundai", default_quote_validity_days: 45, currency: "USD" },
  { id: "cust-2", customer_name: "Tata Motors", customer_key: "tata" },
];

const CONTACTS: Record<string, any[]> = {
  "cust-1": [
    { id: "ct-1a", name: "Asha Rao", email: "asha@hyundai.example", is_primary: true, role: "procurement" },
    { id: "ct-1b", name: "Vikram Shah", email: "vikram@hyundai.example", is_primary: false, role: "accounts" },
  ],
  "cust-2": [],
};

describe("NewQuoteModal", () => {
  let createSpy: any;
  let listContactsSpy: any;
  beforeEach(() => {
    createSpy = vi.fn(async (payload: any) => ({ quote: { id: "q-new", quote_number: "Q-202605-0001", ...payload } }));
    listContactsSpy = vi.fn(async ({ customer_id }: any) => ({ contacts: CONTACTS[customer_id] || [] }));
    installBackend({
      customers: {
        list: vi.fn(async () => ({ customers: CUSTOMERS })),
        listContacts: listContactsSpy,
      },
      quotes: { create: createSpy },
    });
  });

  it("loads customers and disables create until one is chosen", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Hyundai Motor India Ltd")).toBeTruthy());
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
    await waitFor(() => expect(getByText("Tata Motors")).toBeTruthy());
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
    await waitFor(() => expect(getByText("Hyundai Motor India Ltd")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-1" } });
    expect((getByLabelText("Validity days") as HTMLInputElement).value).toBe("45");
  });

  it("prefills currency from the customer when set", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Hyundai Motor India Ltd")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-1" } });
    expect((getByLabelText("Currency") as HTMLInputElement).value).toBe("USD");
  });

  it("loads the customer's contacts and defaults to the primary", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Hyundai Motor India Ltd")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-1" } });
    await waitFor(() => expect(listContactsSpy).toHaveBeenCalledWith({ customer_id: "cust-1" }));
    await waitFor(() => expect((getByLabelText("Contact") as HTMLSelectElement).value).toBe("ct-1a"));
  });

  it("includes the picked customer_contact_id in the create payload", async () => {
    const { getByText, getByLabelText } = render(
      <NewQuoteModal open onClose={() => undefined} onCreated={() => undefined} />
    );
    await waitFor(() => expect(getByText("Hyundai Motor India Ltd")).toBeTruthy());
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
    await waitFor(() => expect(getByText("Tata Motors")).toBeTruthy());
    fireEvent.change(getByLabelText("Customer"), { target: { value: "cust-2" } });
    await waitFor(() => expect(listContactsSpy).toHaveBeenCalledWith({ customer_id: "cust-2" }));
    fireEvent.click(getByText("Create draft"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ customer_id: "cust-2", customer_contact_id: null });
  });
});
