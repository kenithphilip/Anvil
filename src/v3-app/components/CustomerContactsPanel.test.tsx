// Tests for the customer contacts manager: lists contacts, adds one via
// the facade, and surfaces make-primary.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { RBAC } from "../lib/rbac";
import { CustomerContactsPanel } from "./CustomerContactsPanel";

const CONTACTS = [
  { id: "c1", name: "Asha Rao", email: "asha@hyundai.example", phone: "+91 90000 11111", role: "procurement", is_primary: true },
  { id: "c2", name: "Vikram Shah", email: "vikram@hyundai.example", phone: "", role: "accounts", is_primary: false },
];

describe("CustomerContactsPanel", () => {
  let upsert: any;
  let update: any;
  beforeEach(() => {
    upsert = vi.fn(async (p: any) => ({ contact: { id: "c3", ...p } }));
    update = vi.fn(async (p: any) => ({ contact: p }));
    installBackend({
      customers: {
        listContacts: vi.fn(async () => ({ contacts: CONTACTS })),
        upsertContact: upsert,
        updateContact: update,
        deleteContact: vi.fn(async () => ({ ok: true })),
      },
    });
    // Editing is admin-only; default these tests to admin.
    vi.spyOn(RBAC, "isAdmin").mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists existing contacts with a primary badge", async () => {
    const { findByText, getByText } = render(<CustomerContactsPanel customerId="cust-1" />);
    expect(await findByText("Asha Rao")).toBeTruthy();
    expect(getByText("Vikram Shah")).toBeTruthy();
    expect(getByText("primary")).toBeTruthy();
  });

  it("adds a contact through the facade", async () => {
    const { findByText, getByText, getByLabelText } = render(<CustomerContactsPanel customerId="cust-1" />);
    await findByText("Asha Rao");
    fireEvent.click(getByText("+ Add contact"));
    fireEvent.change(getByLabelText("Contact name"), { target: { value: "New Person" } });
    fireEvent.change(getByLabelText("Contact email"), { target: { value: "new@x.example" } });
    fireEvent.click(getByText("Add contact"));
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(upsert.mock.calls[0][0]).toMatchObject({ customer_id: "cust-1", name: "New Person", email: "new@x.example" });
  });

  it("promotes a non-primary contact to primary", async () => {
    const { findByText, getByText } = render(<CustomerContactsPanel customerId="cust-1" />);
    await findByText("Vikram Shah");
    fireEvent.click(getByText("Make primary"));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: "c2", is_primary: true })));
  });

  it("is read-only for non-admins (no edit controls)", async () => {
    (RBAC.isAdmin as any).mockReturnValue(false);
    const { findByText, queryByText } = render(<CustomerContactsPanel customerId="cust-1" />);
    await findByText("Asha Rao");
    expect(queryByText("+ Add contact")).toBeNull();
    expect(queryByText("Make primary")).toBeNull();
    expect(queryByText("Edit")).toBeNull();
  });
});
