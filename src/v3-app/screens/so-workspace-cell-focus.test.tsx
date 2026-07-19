// Regression: editing a reconciliation line cell must NOT remount the
// input. EditableCell/ProvenanceChip/ExtractionQualityCard were declared
// inside WiredSOWorkspace, so every keystroke -> setLinesDraft -> parent
// re-render minted a new component identity and React unmounted +
// remounted the <input>, dropping focus and every character after the
// first. Hoisting them to module scope keeps the input node stable.
//
// The robust, jsdom-safe signal is node identity: after a value edit
// triggers a re-render, the SAME <input> element must still be in the
// document (a remount would detach it) and reflect the new value.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-focus-1";
const order = {
  id: ORDER_ID,
  status: "PENDING_REVIEW", // editable (not CANCELLED/EXPORTED/RECONCILED)
  po_number: "PO-4242",
  customer_id: "cust-1",
  customer_name: "Focus Fixture",
  result: { salesOrder: { lineItems: [
    { partNumber: "WG-100", description: "Weld gun", qty: 2, rate: 1000, uom: "NOS" },
  ] } },
  preflight_payload: { extraction_run_id: "run-1" },
  documents: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

beforeEach(() => {
  installBackend({
    orders: { get: vi.fn(async () => ({ order })), update: vi.fn(async () => ({})) },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  // sales_engineer has so:"rw" (admin is read-only on so), so line
  // cells are editable and canEditLines is true.
  installRbac("sales_engineer");
  vi.stubGlobal("confirm", () => true);
  window.location.hash = "#/so?id=" + ORDER_ID;
});

describe("SoWorkspace recon cell editing", () => {
  it("keeps the same input node across a value edit (no remount / focus loss)", async () => {
    const mod = await import("./so-workspace");
    const { container } = renderScreen(mod.default);

    // The qty cell renders an editable <input> with value "2".
    let input!: HTMLInputElement;
    await waitFor(() => {
      const row = container.querySelector("tr.recon-row");
      expect(row).toBeTruthy();
      const found = Array.from(row!.querySelectorAll("input")).find((el) => (el as HTMLInputElement).value === "2");
      expect(found).toBeTruthy();
      input = found as HTMLInputElement;
    });

    // Setup sanity: the cell must be editable, else onChange never fires.
    expect(input.disabled).toBe(false);

    input.focus();
    expect(document.activeElement).toBe(input);

    // Edit the value -> onEditLine -> setLinesDraft -> parent re-render.
    fireEvent.change(input, { target: { value: "25" } });

    await waitFor(() => {
      // The exact same DOM node must still be mounted (a remount would
      // detach it) and now reflect the edited value.
      expect(container.contains(input)).toBe(true);
      expect(input.value).toBe("25");
    });
    // And focus survived, because the node was never destroyed.
    expect(document.activeElement).toBe(input);
  });
});
