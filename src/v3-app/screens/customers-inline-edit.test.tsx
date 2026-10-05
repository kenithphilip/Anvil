// The customers screen's inline "Edit details" form sends only the fields
// that changed. It addresses the customer by id, so the endpoint updates
// that row in place and leaves every column the form does not carry
// (parent, notes, addresses, contacts) alone. The type field picks from
// the migration 006 customer_type enum instead of taking free text the
// database would reject.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ACME = {
  id: "c-acme",
  customer_key: "acme",
  customer_name: "Acme Motors",
  gstin: "27AAPFU0939F1ZV",
  currency: "INR",
  customer_type: "AUTO_OEM",
  notes: "Plant visit every quarter",
  parent_customer_id: "c-group",
};

let upsert: any;
let submitChangeRequest: any;

beforeEach(() => {
  upsert = vi.fn(async (p: any) => ({ customer: { ...ACME, ...p } }));
  submitChangeRequest = vi.fn(async () => ({ request: { id: "cr-1" } }));
  installBackend({
    customers: {
      list: async () => ({ customers: [ACME] }),
      listChangeRequests: async () => ({ requests: [] }),
      upsert,
      submitChangeRequest,
    },
  });
  window.location.hash = "#/customers?id=c-acme";
  vi.stubGlobal("confirm", () => true);
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
});
afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ""; });

const openEditor = async () => {
  const { default: Customers } = await import("./customers");
  const view = renderScreen(Customers);
  const edit = await view.findByText(/Edit details/);
  fireEvent.click(edit);
  // The hierarchy panel has its own Save; press the edit form's.
  const formButton = (label: string) => within(view.getByText("Cancel").parentElement as HTMLElement).getByText(label);
  return { ...view, formButton };
};

describe("Customers inline edit", () => {
  it("an admin's save sends id + key + only the changed type, picked from the enum", async () => {
    installRbac("admin");
    const view = await openEditor();
    const type = view.getByLabelText("Customer type") as HTMLSelectElement;
    expect(Array.from(type.options).map((o) => o.value)).toEqual(["", "AUTO_OEM", "TIER_ONE", "LINE_BUILDER", "OTHER"]);
    expect(type.value).toBe("AUTO_OEM");
    fireEvent.change(type, { target: { value: "TIER_ONE" } });
    fireEvent.click(view.formButton("Save"));
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(upsert.mock.calls[0][0]).toEqual({ id: "c-acme", customer_key: "acme", customer_type: "TIER_ONE" });
    expect(submitChangeRequest).not.toHaveBeenCalled();
  });

  it("a non-admin submits the same changed-only payload as a change request", async () => {
    installRbac("sales_engineer");
    const view = await openEditor();
    fireEvent.change(view.getByLabelText("Customer type"), { target: { value: "OTHER" } });
    fireEvent.click(view.formButton("Submit for approval"));
    await waitFor(() => expect(submitChangeRequest).toHaveBeenCalledTimes(1));
    expect(submitChangeRequest.mock.calls[0][0]).toEqual({ change_type: "update", target_customer_id: "c-acme", payload: { customer_type: "OTHER" } });
    expect(upsert).not.toHaveBeenCalled();
  });
});
