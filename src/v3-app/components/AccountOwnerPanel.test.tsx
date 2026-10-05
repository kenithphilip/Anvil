// The account-owner panel on the customer detail: a manager picks an approved
// member and saves; for an unowned account the server's suggestion is
// preselected but saved only on click.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac } from "../test-utils";
import { AccountOwnerPanel } from "./AccountOwnerPanel";

const MEMBERS = [
  { user_id: "u-1", display_name: "Meera Manager", status: "approved" },
  { user_id: "u-2", display_name: "Ravi Rep", status: "approved" },
  { user_id: "u-3", email: "sana@seller.test", status: "approved" },
  { user_id: "u-9", display_name: "Pending Person", status: "pending" },
];
const UNOWNED = { id: "cust-1", customer_name: "Acme", owner_user_id: null };
const OWNED = { id: "cust-2", customer_name: "Bolt", owner_user_id: "u-3", owner_name: "Sana Sales" };

describe("AccountOwnerPanel", () => {
  let assignOwner: any;
  let ownerSuggestions: any;
  beforeEach(() => {
    installRbac("sales_manager");
    assignOwner = vi.fn(async () => ({ updated: ["cust-1"], warnings: [] }));
    ownerSuggestions = vi.fn(async () => ({ suggestions: [{ customer_id: "cust-1", owner_user_id: null, reason: "no_majority", votes: 0, total: 4 }] }));
    installBackend({ customers: { assignOwner, ownerSuggestions } });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("saves the picked member with the exact payload the endpoint expects", async () => {
    const onChanged = vi.fn();
    const { getByLabelText, getByText } = render(<AccountOwnerPanel customer={UNOWNED} members={MEMBERS} onChanged={onChanged} />);
    await waitFor(() => expect(ownerSuggestions).toHaveBeenCalledWith({ customer_id: "cust-1" }));
    fireEvent.change(getByLabelText("Account owner"), { target: { value: "u-2" } });
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(assignOwner).toHaveBeenCalledTimes(1));
    expect(assignOwner.mock.calls[0][0]).toEqual({ customer_ids: ["cust-1"], owner_user_id: "u-2", move_open_opportunities: false });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("preselects the suggestion, saves nothing until clicked, then sends the suggested id", async () => {
    ownerSuggestions.mockResolvedValue({ suggestions: [{ customer_id: "cust-1", owner_user_id: "u-3", owner_name: "Sana Sales", reason: "majority", votes: 3, total: 4 }] });
    const { getByLabelText, getByText } = render(<AccountOwnerPanel customer={UNOWNED} members={MEMBERS} />);
    await waitFor(() => expect((getByLabelText("Account owner") as HTMLSelectElement).value).toBe("u-3"));
    expect(getByText(/owns 3 of 4 opportunities and quotes/)).toBeTruthy();
    // Computed is not chosen: the suggestion is on screen and nothing was saved.
    expect(assignOwner).not.toHaveBeenCalled();
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(assignOwner).toHaveBeenCalledTimes(1));
    expect(assignOwner.mock.calls[0][0]).toEqual({ customer_ids: ["cust-1"], owner_user_id: "u-3", move_open_opportunities: false });
  });

  it("sends move_open_opportunities when the box is ticked", async () => {
    const { getByLabelText, getByText } = render(<AccountOwnerPanel customer={UNOWNED} members={MEMBERS} />);
    fireEvent.change(getByLabelText("Account owner"), { target: { value: "u-2" } });
    fireEvent.click(getByLabelText("Move open opportunities"));
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(assignOwner).toHaveBeenCalledTimes(1));
    expect(assignOwner.mock.calls[0][0].move_open_opportunities).toBe(true);
  });

  it("offers only approved members (a pending access request is not the team)", () => {
    const { getByLabelText } = render(<AccountOwnerPanel customer={UNOWNED} members={MEMBERS} />);
    const values = Array.from((getByLabelText("Account owner") as HTMLSelectElement).options).map((o) => o.value);
    expect(values).toEqual(["", "u-1", "u-2", "u-3"]);
  });

  it("shows the current owner, asks for no suggestion, and can unassign", async () => {
    const { getByText, getByLabelText, getByTestId } = render(<AccountOwnerPanel customer={OWNED} members={MEMBERS} />);
    expect(getByTestId("account-owner-name").textContent).toBe("Sana Sales");
    expect((getByLabelText("Account owner") as HTMLSelectElement).value).toBe("u-3");
    fireEvent.change(getByLabelText("Account owner"), { target: { value: "" } });
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(assignOwner).toHaveBeenCalledTimes(1));
    expect(assignOwner.mock.calls[0][0]).toEqual({ customer_ids: ["cust-2"], owner_user_id: null, move_open_opportunities: false });
    expect(ownerSuggestions).not.toHaveBeenCalled();
  });

  it("is read-only for a sales_engineer: the owner is shown, no picker, no suggestion request", () => {
    installRbac("sales_engineer");
    const { queryByLabelText, getByText, getByTestId } = render(<AccountOwnerPanel customer={OWNED} members={MEMBERS} />);
    expect(getByTestId("account-owner-name").textContent).toBe("Sana Sales");
    expect(queryByLabelText("Account owner")).toBeNull();
    expect(getByText(/sales manager or admin assigns/i)).toBeTruthy();
    expect(ownerSuggestions).not.toHaveBeenCalled();
  });
});
