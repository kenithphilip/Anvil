// One order value on every screen (plan R-M1, C-10). A scanned PO often
// prints no grand total. The workspace header summed the lines (without
// their tax), and the SO list read the grand total only, so the list showed
// no value for an order the workspace priced. Both read orderValue() now.
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-value-1";
// No grandTotal. 2 x 100 at 18% GST: 236 with tax.
const order = {
  id: ORDER_ID, status: "DRAFT", po_number: "PO-VAL-1", customer_id: "cust-1", customer: { customer_name: "Value Buyer" },
  preflight_payload: { source_document_id: "doc-1" }, documents: [{ id: "doc-1" }],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  result: { salesOrder: { lineItems: [{ partNumber: "VL-1", description: "Part one", qty: 2, rate: 100, gst_pct: 18, uom: "NOS" }] } },
};

const amount = (text: string | null | undefined) => Number(String(text || "").replace(/[^\d.]/g, ""));

beforeEach(() => {
  installRbac("sales_engineer");
  installBackend({
    orders: {
      list: vi.fn(async () => ({ orders: [order] })),
      get: vi.fn(async () => ({ order })),
      update: vi.fn(async () => ({})),
      terms: vi.fn(async () => ({ mode: "off", visible: false, flags: [] })),
    },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
    docai: { soProcessingMode: vi.fn(async () => ({ mode: "A" })), getRun: vi.fn(async () => null) },
  });
});

describe("a scanned PO with no grand total", () => {
  it("shows the same value on the SO list and in the workspace", async () => {
    const list = renderScreen((await import("./orders")).default);
    const row = (await screen.findByText("PO-VAL-1")).closest("tr") as HTMLElement;
    const listValue = row.querySelectorAll("td")[6].textContent;
    list.unmount();

    window.location.hash = "#/so?id=" + ORDER_ID;
    const ws = renderScreen((await import("./so-workspace")).default);
    const item = await waitFor(() => {
      const el = [...ws.container.querySelectorAll(".so-summary-item")].find((x) => x.querySelector(".lbl")?.textContent === "Value");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const wsValue = item.querySelector(".v")!.textContent;

    expect(amount(listValue)).toBe(236);
    expect(amount(wsValue)).toBe(236);
  });
});
