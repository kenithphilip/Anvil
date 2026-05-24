// Tests for the customer hierarchy panel: shows the current parent +
// child entities, and saving a parent change sends the full customer
// object through customers.upsert (so other columns are not clobbered).

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend } from "../test-utils";
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
  });

  it("lists child entities rolling up under the customer", () => {
    const { getByRole } = render(<CustomerHierarchyPanel customer={GROUP} allCustomers={ALL} />);
    // The child chip is a clickable (role=button); the select option of
    // the same name is not, so this disambiguates from the picker.
    expect(getByRole("button", { name: "Hyundai Chennai" })).toBeTruthy();
  });

  it("reflects the current parent selection", () => {
    const { getByLabelText } = render(<CustomerHierarchyPanel customer={PLANT_A} allCustomers={ALL} />);
    expect((getByLabelText("Parent customer") as HTMLSelectElement).value).toBe("grp");
  });

  it("excludes self from the parent options", () => {
    const { getByLabelText } = render(<CustomerHierarchyPanel customer={GROUP} allCustomers={ALL} />);
    const opts = Array.from((getByLabelText("Parent customer") as HTMLSelectElement).options).map((o) => o.value);
    expect(opts).not.toContain("grp"); // cannot parent itself
    expect(opts).toContain("pa");
  });

  it("saves a parent change via upsert with the full customer object", async () => {
    const onChanged = vi.fn();
    const { getByLabelText } = render(<CustomerHierarchyPanel customer={PLANT_B} allCustomers={ALL} onChanged={onChanged} />);
    fireEvent.change(getByLabelText("Parent customer"), { target: { value: "grp" } });
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    const payload = upsert.mock.calls[0][0];
    expect(payload.parent_customer_id).toBe("grp");
    expect(payload.customer_key).toBe("hmi-pune"); // full object preserved
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
