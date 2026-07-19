// Unified reconcile view (SO Workspace "Reconcile" tab): the PO PDF is
// side-by-side with the line grid under one selection context.
// Asserts the PDF|Split|Lines layout toggle renders and a line row is
// selectable (which drives the shared field selection -> PDF highlight).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-recon-1";
const SOURCE_ID = "doc-recon-1";
const order = {
  id: ORDER_ID,
  status: "PENDING_REVIEW",
  po_number: "PO-7777",
  customer_id: "cust-1",
  customer_name: "Recon Fixture",
  result: { salesOrder: { customer: { name: "Recon Fixture" }, lineItems: [
    { partNumber: "WG-100", description: "Weld gun", qty: 2, rate: 1000, uom: "NOS" },
    { partNumber: "TIP-9", description: "Contact tip", qty: 50, rate: 20, uom: "NOS" },
  ] } },
  evidence_by_field: { "customer.name": { value: "Recon Fixture", page: 1, confidence: 0.98 } },
  preflight_payload: { source_document_id: SOURCE_ID, extraction_run_id: "run-1" },
  documents: [{ id: SOURCE_ID }],
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
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  window.location.hash = "#/so?id=" + ORDER_ID;
});

describe("SoWorkspace unified reconcile", () => {
  it("renders the PDF | Split | Lines layout toggle beside the line grid", async () => {
    const mod = await import("./so-workspace");
    const { container } = renderScreen(mod.default);
    await waitFor(() => {
      expect(container.innerHTML).toContain("Line reconciliation");
    });
    const toggle = container.querySelector(".recon-view-toggle");
    expect(toggle).toBeTruthy();
    const labels = Array.from(toggle!.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["PDF", "Split", "Lines"]);
  });

  it("selects a line row on click (drives the shared PDF selection)", async () => {
    const mod = await import("./so-workspace");
    const { container } = renderScreen(mod.default);
    await waitFor(() => {
      expect(container.querySelector("tr.recon-row")).toBeTruthy();
    });
    const row = container.querySelector("tr.recon-row") as HTMLElement;
    expect(row.classList.contains("is-active")).toBe(false);
    fireEvent.click(row);
    await waitFor(() => {
      expect(container.querySelector("tr.recon-row.is-active")).toBeTruthy();
    });
  });
});
