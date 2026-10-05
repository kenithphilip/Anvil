// Customers screen: a smoke render, plus the account-owner behaviour
// (owner column, owner filter, bulk assign, detail panel). Started as the
// generated smoke test for screens/customers.tsx and extended by hand.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  // jsdom's confirm/alert/prompt are no-ops by default; stub them so
  // accidental click handlers can't pop dialogs during a smoke render.
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("Customers", () => {
  it("renders without throwing", async () => {
    const mod = await import("./customers");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});

// ── Account owner (migration 227) ──────────────────────────────────────────
// The list shows each account's owner, filters by owner through the API, and
// lets a manager tick rows and assign them in one call. The detail card hosts
// the AccountOwnerPanel.

const ROWS = [
  { id: "cust-1", customer_key: "acme", customer_name: "Acme", owner_user_id: null, owner_name: null },
  { id: "cust-2", customer_key: "bolt", customer_name: "Bolt", owner_user_id: "u-3", owner_name: "Sana Sales" },
  { id: "cust-3", customer_key: "core", customer_name: "Core", owner_user_id: null, owner_name: null },
];
const MEMBERS = [
  { user_id: "u-2", display_name: "Ravi Rep", status: "approved" },
  { user_id: "u-3", display_name: "Sana Sales", status: "approved" },
];

const mount = async (role = "sales_manager") => {
  installRbac(role);
  const list = vi.fn(async (params?: any) => {
    if (params?.owner === "me") return { customers: [ROWS[1]] };
    if (params?.owner === "none") return { customers: [ROWS[0], ROWS[2]] };
    return { customers: ROWS, profiles: {} };
  });
  const assignOwner = vi.fn(async (p: any) => ({ updated: p.customer_ids, warnings: [] }));
  const ownerSuggestions = vi.fn(async () => ({ suggestions: [{ customer_id: "cust-1", owner_user_id: "u-2", owner_name: "Ravi Rep", reason: "majority", votes: 2, total: 3 }] }));
  const listMembers = vi.fn(async () => ({ members: MEMBERS }));
  installBackend({ customers: { list, assignOwner, ownerSuggestions }, admin: { listMembers } });
  const mod = await import("./customers");
  const utils = renderScreen(mod.default);
  await waitFor(() => expect(utils.getByText("Bolt")).toBeTruthy());
  return { ...utils, list, assignOwner, ownerSuggestions, listMembers };
};

describe("Customers: account owner", () => {
  beforeEach(() => { window.location.hash = "#/customers"; });

  it("shows each account's owner, and Unassigned where there is none", async () => {
    const { getByText } = await mount();
    const bolt = getByText("Bolt").closest("tr") as HTMLElement;
    expect(within(bolt).getByText("Sana Sales")).toBeTruthy();
    const acme = getByText("Acme").closest("tr") as HTMLElement;
    expect(within(acme).getByText("Unassigned")).toBeTruthy();
  });

  it("Mine and Unassigned ask the API for that owner's accounts", async () => {
    const { getByLabelText, list, queryByText, getByText } = await mount();
    fireEvent.change(getByLabelText("Owner filter"), { target: { value: "mine" } });
    await waitFor(() => expect(list).toHaveBeenCalledWith({ owner: "me" }));
    await waitFor(() => expect(queryByText("Acme")).toBeNull());
    expect(getByText("Bolt")).toBeTruthy();
    fireEvent.change(getByLabelText("Owner filter"), { target: { value: "none" } });
    await waitFor(() => expect(list).toHaveBeenCalledWith({ owner: "none" }));
    await waitFor(() => expect(getByText("Acme")).toBeTruthy());
    expect(getByText("Core")).toBeTruthy();
  });

  it("bulk assign sends exactly the checked ids", async () => {
    const { getByLabelText, getByText, assignOwner, listMembers } = await mount();
    await waitFor(() => expect(listMembers).toHaveBeenCalled());
    fireEvent.click(getByLabelText("Select Acme"));
    fireEvent.click(getByLabelText("Select Core"));
    expect(getByText("2 selected")).toBeTruthy();
    await waitFor(() => expect(Array.from((getByLabelText("Bulk owner") as HTMLSelectElement).options).map((o) => o.value)).toContain("u-2"));
    fireEvent.change(getByLabelText("Bulk owner"), { target: { value: "u-2" } });
    fireEvent.click(getByText("Assign owner"));
    await waitFor(() => expect(assignOwner).toHaveBeenCalledTimes(1));
    const payload = assignOwner.mock.calls[0][0];
    expect([...payload.customer_ids].sort()).toEqual(["cust-1", "cust-3"]);
    expect(payload.owner_user_id).toBe("u-2");
    expect(payload.move_open_opportunities).toBe(false);
  });

  it("ticking a row does not open the customer", async () => {
    const { getByLabelText } = await mount();
    fireEvent.click(getByLabelText("Select Bolt"));
    expect(window.location.hash).toBe("#/customers");
  });

  it("a sales_engineer sees owners but no checkboxes and no bulk action", async () => {
    const { queryByLabelText, getByText, listMembers } = await mount("sales_engineer");
    const bolt = getByText("Bolt").closest("tr") as HTMLElement;
    expect(within(bolt).getByText("Sana Sales")).toBeTruthy();
    expect(queryByLabelText("Select Bolt")).toBeNull();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it("the detail card assigns the owner through the panel with the exact payload", async () => {
    window.location.hash = "#/customers?id=cust-1";
    const { getByLabelText, getAllByText, assignOwner, ownerSuggestions } = await mount();
    await waitFor(() => expect(ownerSuggestions).toHaveBeenCalledWith({ customer_id: "cust-1" }));
    // The suggestion (u-2) is preselected; the manager picks someone else.
    await waitFor(() => expect((getByLabelText("Account owner") as HTMLSelectElement).value).toBe("u-2"));
    expect(assignOwner).not.toHaveBeenCalled();
    fireEvent.change(getByLabelText("Account owner"), { target: { value: "u-3" } });
    const save = getAllByText("Save").find((b) => b.getAttribute("title") === "Save the account owner") as HTMLElement;
    fireEvent.click(save);
    await waitFor(() => expect(assignOwner).toHaveBeenCalledTimes(1));
    expect(assignOwner.mock.calls[0][0]).toEqual({ customer_ids: ["cust-1"], owner_user_id: "u-3", move_open_opportunities: false });
  });
});
