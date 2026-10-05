// The account-owner panel on the customer detail: a manager picks an approved
// member and saves; for an unowned account the server's suggestion is
// preselected but saved only on click.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, fireEvent, act } from "@testing-library/react";
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

  it("is read-only for a sales_engineer: the owner is shown, no picker", () => {
    installRbac("sales_engineer");
    const { queryByLabelText, getByText, getByTestId } = render(<AccountOwnerPanel customer={OWNED} members={MEMBERS} />);
    expect(getByTestId("account-owner-name").textContent).toBe("Sana Sales");
    expect(queryByLabelText("Account owner")).toBeNull();
    expect(getByText(/sales manager or admin assigns/i)).toBeTruthy();
  });

  it("asks a sales_engineer's view of an UNOWNED account for no suggestion (it could not act on one)", async () => {
    // The unowned account is the case where a manager's panel DOES ask (the
    // first test proves it), so this is the role gate, not the owned-account
    // early return.
    installRbac("sales_engineer");
    const { getByText } = render(<AccountOwnerPanel customer={UNOWNED} members={MEMBERS} />);
    expect(getByText("unassigned")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(ownerSuggestions).not.toHaveBeenCalled();
  });

  it("a suggestion that arrives AFTER the manager picked someone does not replace the pick", async () => {
    let resolveSuggestion: (v: any) => void = () => {};
    ownerSuggestions.mockImplementation(() => new Promise((r) => { resolveSuggestion = r; }));
    const { getByLabelText, getByText } = render(<AccountOwnerPanel customer={UNOWNED} members={MEMBERS} />);
    await waitFor(() => expect(ownerSuggestions).toHaveBeenCalled());
    fireEvent.change(getByLabelText("Account owner"), { target: { value: "u-3" } });
    await act(async () => {
      resolveSuggestion({ suggestions: [{ customer_id: "cust-1", owner_user_id: "u-2", owner_name: "Ravi Rep", reason: "majority", votes: 3, total: 4 }] });
    });
    // The suggestion is still shown as information...
    await waitFor(() => expect(getByText(/owns 3 of 4 opportunities and quotes/)).toBeTruthy());
    // ...but the picker keeps the manager's choice, and Save sends it.
    expect((getByLabelText("Account owner") as HTMLSelectElement).value).toBe("u-3");
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(assignOwner).toHaveBeenCalledTimes(1));
    expect(assignOwner.mock.calls[0][0].owner_user_id).toBe("u-3");
  });

  it("ticking move and then switching to Unassigned sends move_open_opportunities false", async () => {
    // The checkbox hides when nobody is picked, but its state survives; the
    // server refuses move:true with a null owner.
    const { getByLabelText, getByText } = render(<AccountOwnerPanel customer={OWNED} members={MEMBERS} />);
    fireEvent.change(getByLabelText("Account owner"), { target: { value: "u-2" } });
    fireEvent.click(getByLabelText("Move open opportunities"));
    fireEvent.change(getByLabelText("Account owner"), { target: { value: "" } });
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(assignOwner).toHaveBeenCalledTimes(1));
    expect(assignOwner.mock.calls[0][0]).toEqual({ customer_ids: ["cust-2"], owner_user_id: null, move_open_opportunities: false });
  });

  it("an owner who is not in the member list is still the picker's value, and can be cleared", async () => {
    const exMember = { id: "cust-3", customer_name: "Core", owner_user_id: "u-7", owner_name: "Old Rep" };
    const { getByLabelText, getByText } = render(<AccountOwnerPanel customer={exMember} members={MEMBERS} />);
    const select = getByLabelText("Account owner") as HTMLSelectElement;
    expect(select.value).toBe("u-7");
    expect(select.options[select.selectedIndex].textContent).toBe("Old Rep (not an approved member)");
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(assignOwner).toHaveBeenCalledTimes(1));
    expect(assignOwner.mock.calls[0][0]).toEqual({ customer_ids: ["cust-3"], owner_user_id: null, move_open_opportunities: false });
  });

  it("says so when the member list could not be loaded", () => {
    const { getByRole, getByLabelText } = render(<AccountOwnerPanel customer={OWNED} members={[]} membersError="403 forbidden" />);
    expect(getByRole("alert").textContent).toMatch(/Could not load the team list.*403 forbidden/);
    // The owner is still shown in the picker rather than a false "Unassigned".
    expect((getByLabelText("Account owner") as HTMLSelectElement).value).toBe("u-3");
  });
});
