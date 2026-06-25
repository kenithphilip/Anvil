// Tests for the customer hierarchy panel: shows the current parent +
// child entities. Editing is admin-only and a parent change is staged as a
// draft that must be confirmed + saved (it no longer auto-saves on change).
// Saving sends the full customer object through customers.upsert.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { RBAC } from "../lib/rbac";
import { CustomerHierarchyPanel } from "./CustomerHierarchyPanel";

const GROUP = { id: "grp", customer_name: "Hyundai Group", customer_key: "hyundai-group", parent_customer_id: null };
const PLANT_A = { id: "pa", customer_name: "Hyundai Chennai", customer_key: "hmi-chennai", gstin: "33AAA", parent_customer_id: "grp" };
const PLANT_B = { id: "pb", customer_name: "Hyundai Pune", customer_key: "hmi-pune", parent_customer_id: null };
const ALL = [GROUP, PLANT_A, PLANT_B];

describe("CustomerHierarchyPanel", () => {
  let upsert: any;
  beforeEach(() => {
    upsert = vi.fn(async (p: any) => ({ customer: p }));
    installBackend({ customers: { upsert } });
    vi.spyOn(RBAC, "isAdmin").mockReturnValue(true);
    vi.stubGlobal("confirm", vi.fn(() => true));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("lists child entities rolling up under the customer", () => {
    const { getByRole } = render(<CustomerHierarchyPanel customer={GROUP} allCustomers={ALL} />);
    expect(getByRole("button", { name: "Hyundai Chennai" })).toBeTruthy();
  });

  it("reflects the current parent selection", () => {
    const { getByLabelText } = render(<CustomerHierarchyPanel customer={PLANT_A} allCustomers={ALL} />);
    expect((getByLabelText("Parent customer") as HTMLSelectElement).value).toBe("grp");
  });

  it("excludes self from the parent options", () => {
    const { getByLabelText } = render(<CustomerHierarchyPanel customer={GROUP} allCustomers={ALL} />);
    const opts = Array.from((getByLabelText("Parent customer") as HTMLSelectElement).options).map((o) => o.value);
    expect(opts).not.toContain("grp");
    expect(opts).toContain("pa");
  });

  it("does NOT auto-save on change - only after confirm + Save", async () => {
    const onChanged = vi.fn();
    const { getByLabelText, getByText } = render(<CustomerHierarchyPanel customer={PLANT_B} allCustomers={ALL} onChanged={onChanged} />);
    fireEvent.change(getByLabelText("Parent customer"), { target: { value: "grp" } });
    // Staged only: nothing persisted yet (the guard rail).
    expect(upsert).not.toHaveBeenCalled();
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    const payload = upsert.mock.calls[0][0];
    expect(payload.parent_customer_id).toBe("grp");
    expect(payload.customer_key).toBe("hmi-pune"); // full object preserved
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("does not save when the confirm dialog is dismissed", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const { getByLabelText, getByText } = render(<CustomerHierarchyPanel customer={PLANT_B} allCustomers={ALL} />);
    fireEvent.change(getByLabelText("Parent customer"), { target: { value: "grp" } });
    fireEvent.click(getByText("Save"));
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is read-only for non-admin roles (no parent picker)", () => {
    (RBAC.isAdmin as any).mockReturnValue(false);
    const { queryByLabelText, getByText } = render(<CustomerHierarchyPanel customer={PLANT_A} allCustomers={ALL} />);
    expect(queryByLabelText("Parent customer")).toBeNull();
    expect(getByText(/Admin access is required/i)).toBeTruthy();
  });
});
