// Regression test for the "select existing customer" escape hatch in
// the Customer-not-detected dialog (so-intake.tsx).
//
// The docai matcher sometimes fails to auto-link a PO to a customer
// that already exists (street-only bill-to, vendor-code-only header,
// a name spelled differently from the master). The dialog used to
// offer only "Create customer", which silently produced a duplicate.
// This test locks the new behaviour: the operator can pick the
// existing record, which selects it and closes the dialog WITHOUT
// calling the create/upsert path.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const CUSTOMERS = [
  { id: "cust-mg", customer_name: "Vega Motor India", gstin: "24AABCM1234A1Z5", state_code: "24" },
  { id: "cust-hmil", customer_name: "Meridian Motor India Ltd", gstin: "27AAACH5678B1Z9", state_code: "27" },
];

let upsertSpy;

beforeEach(() => {
  upsertSpy = vi.fn(async () => ({ customer: { id: "new-dupe" } }));
  installBackend({
    isReady: () => true,
    getConfig: () => ({ url: "https://api.test", tenantId: "t-1" }),
    customers: {
      list: async () => ({ customers: CUSTOMERS }),
      listLocations: async () => ({ locations: [] }),
      upsert: upsertSpy,
    },
    health: async () => ({ integrations: [] }),
  });
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
});

const openNewCustomerDialog = async (container: HTMLElement) => {
  // Wait until the customer list has loaded into the screen.
  await waitFor(() => {
    const btns = Array.from(container.querySelectorAll("button"));
    expect(btns.some((b) => /new customer/i.test(b.textContent || ""))).toBe(true);
  });
  const newCustomerBtn = Array.from(container.querySelectorAll("button"))
    .find((b) => /new customer/i.test(b.textContent || "")) as HTMLButtonElement;
  fireEvent.click(newCustomerBtn);
  // The dialog mounts with the existing-customer picker.
  await waitFor(() => {
    expect(document.getElementById("nc-existing")).toBeTruthy();
  });
};

describe("SoIntake — pick existing customer from the not-detected dialog", () => {
  it("renders the existing-customer picker populated with the customer list", async () => {
    const { container } = renderScreen((await import("./so-intake")).default);
    await openNewCustomerDialog(container);
    const select = document.getElementById("nc-existing") as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent || "");
    expect(optionLabels.some((l) => /Vega Motor India/.test(l))).toBe(true);
    expect(optionLabels.some((l) => /Meridian Motor India Ltd/.test(l))).toBe(true);
  });

  it("selecting an existing customer closes the dialog without creating a duplicate", async () => {
    const { container } = renderScreen((await import("./so-intake")).default);
    await openNewCustomerDialog(container);
    const select = document.getElementById("nc-existing") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "cust-hmil" } });

    // Dialog closes: the create-only "Customer name *" field disappears.
    await waitFor(() => {
      expect(document.getElementById("nc-existing")).toBeNull();
    });
    // Critically, the create/upsert path was NOT taken.
    expect(upsertSpy).not.toHaveBeenCalled();
    // The operator got positive feedback that the link happened.
    expect((window as any).notifySuccess).toHaveBeenCalled();
  });
});
