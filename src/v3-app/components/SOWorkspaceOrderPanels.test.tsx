// Tests for the SO workspace Header tab's delivery point contact picker.
// The picker used to fetch /api/customer_contacts, a route the router
// never had, so it only ever offered "Not set" and a saved contact was
// invisible. These render the real OrderHeaderEditor against a stubbed
// client and assert what the operator sees and what a save sends.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { OrderHeaderEditor } from "./SOWorkspaceOrderPanels";

const CONTACTS = [
  { id: "c1000000-0000-0000-0000-000000000001", name: "Asha Rao", email: "asha@buyer.example", is_active: true },
  { id: "c2000000-0000-0000-0000-000000000002", name: "Vikram Shah", email: "vikram@buyer.example", is_active: true },
  { id: "c3000000-0000-0000-0000-000000000003", name: "Old Buyer", email: "old@buyer.example", is_active: false },
];

const baseOrder = (over: Record<string, unknown> = {}) => ({
  id: "ord-0001-0000",
  customer_id: "cust-1",
  po_number: "PO-77",
  updated_at: "2026-10-01T00:00:00Z",
  delivery_point_contact_id: null,
  ...over,
});

const optionTexts = (sel: HTMLSelectElement) => Array.from(sel.options).map((o) => o.textContent);
const selectedText = (sel: HTMLSelectElement) => sel.options[sel.selectedIndex]?.textContent;

describe("OrderHeaderEditor delivery point contact", () => {
  let listContacts: any;
  let update: any;
  beforeEach(() => {
    listContacts = vi.fn(async () => ({ contacts: CONTACTS }));
    update = vi.fn(async () => ({ ok: true }));
    installBackend({
      customers: { listContacts },
      orders: { update },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists the customer's active contacts by name and selects the saved one", async () => {
    const { getByLabelText, findByText } = render(
      <OrderHeaderEditor order={baseOrder({ delivery_point_contact_id: CONTACTS[1].id })} onSaved={() => {}} />,
    );
    await findByText("Asha Rao");
    expect(listContacts).toHaveBeenCalledWith({ customer_id: "cust-1" });
    const sel = getByLabelText("Delivery point contact") as HTMLSelectElement;
    expect(optionTexts(sel)).toEqual(["Not set", "Asha Rao", "Vikram Shah"]);
    expect(sel.value).toBe(CONTACTS[1].id);
    expect(selectedText(sel)).toBe("Vikram Shah");
  });

  it("an untouched save writes the listed contact back as it was", async () => {
    const { getByText, findByText } = render(
      <OrderHeaderEditor order={baseOrder({ delivery_point_contact_id: CONTACTS[0].id })} onSaved={() => {}} />,
    );
    await findByText("Asha Rao");
    fireEvent.click(getByText("Save header"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toBe("ord-0001-0000");
    expect(update.mock.calls[0][1]).toMatchObject({ delivery_point_contact_id: CONTACTS[0].id });
  });

  it("keeps a saved contact that is not on the list visible, and clearing it saves null", async () => {
    const strayId = "c9000000-0000-0000-0000-000000000009";
    const onSaved = vi.fn();
    const { getByLabelText, getByText, findByText, queryByText } = render(
      <OrderHeaderEditor order={baseOrder({ delivery_point_contact_id: strayId })} onSaved={onSaved} />,
    );
    await findByText("Asha Rao");
    const sel = getByLabelText("Delivery point contact") as HTMLSelectElement;
    expect(sel.value).toBe(strayId);
    expect(selectedText(sel)).toBe("Saved contact c9000000 (not on this customer)");

    fireEvent.change(sel, { target: { value: "" } });
    expect(sel.value).toBe("");
    expect(queryByText("Saved contact c9000000 (not on this customer)")).toBeNull();

    fireEvent.click(getByText("Save header"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ delivery_point_contact_id: null });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("names a saved contact that was since marked inactive, without offering inactive ones", async () => {
    const { getByLabelText, findByText } = render(
      <OrderHeaderEditor order={baseOrder({ delivery_point_contact_id: CONTACTS[2].id })} onSaved={() => {}} />,
    );
    await findByText("Asha Rao");
    const sel = getByLabelText("Delivery point contact") as HTMLSelectElement;
    expect(optionTexts(sel)).toEqual(["Not set", "Old Buyer (inactive)", "Asha Rao", "Vikram Shah"]);
    expect(sel.value).toBe(CONTACTS[2].id);
    expect(selectedText(sel)).toBe("Old Buyer (inactive)");
  });

  it("treats a contact row without is_active as active", async () => {
    listContacts.mockResolvedValueOnce({ contacts: [{ id: "c4000000-0000-0000-0000-000000000004", name: "Pre128 Contact" }] });
    const { getByLabelText, findByText } = render(<OrderHeaderEditor order={baseOrder()} onSaved={() => {}} />);
    await findByText("Pre128 Contact");
    const sel = getByLabelText("Delivery point contact") as HTMLSelectElement;
    expect(optionTexts(sel)).toEqual(["Not set", "Pre128 Contact"]);
  });

  it("says when the contacts cannot load and still shows the saved contact", async () => {
    listContacts.mockRejectedValueOnce(new Error("HTTP 500"));
    const savedId = CONTACTS[1].id;
    const { getByLabelText, findByText } = render(
      <OrderHeaderEditor order={baseOrder({ delivery_point_contact_id: savedId })} onSaved={() => {}} />,
    );
    await findByText("Could not load this customer's contacts.");
    const sel = getByLabelText("Delivery point contact") as HTMLSelectElement;
    expect(sel.value).toBe(savedId);
    expect(selectedText(sel)).toBe("Saved contact c2000000");
  });
});
