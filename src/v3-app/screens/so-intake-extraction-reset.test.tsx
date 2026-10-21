// An order takes the lines of the PO it was created from, and no other.
//
// The intake kept extracted lines only when a run returned some, and "remove"
// cleared only the document. So a second PO that extracted 0 lines, or a
// removed PO, still handed the first PO's lines to the new order. Each
// extraction, and remove, now starts from empty.
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const CUSTOMER = { id: "cust-reset", customer_name: "Reset Buyer", gstin: "29AABCR1234E1Z5" };
const FIRST_PO = {
  run_id: "run-1", adapter_used: "gemini", confidence_overall: 0.95,
  normalized: {
    customer: { name: "Reset Buyer", gstin: CUSTOMER.gstin, po_number: "PO-FIRST" },
    lines: [{ partNumber: "RS-1", description: "Valve", quantity: 3, unitPrice: 40 }],
  },
};
const SECOND_PO = {
  run_id: "run-2", adapter_used: "gemini", confidence_overall: 0.9, status_reason: "empty_lines",
  normalized: { customer: { name: "Reset Buyer", gstin: CUSTOMER.gstin, po_number: "PO-SECOND" }, lines: [] },
};

let create: any;
let extract: any;

beforeEach(() => {
  create = vi.fn(async () => ({ order: { id: "ord-reset-1" } }));
  extract = vi.fn().mockResolvedValueOnce(FIRST_PO).mockResolvedValueOnce(SECOND_PO);
  installBackend({
    health: async () => ({ integrations: [] }),
    customers: { list: async () => ({ customers: [CUSTOMER] }), listLocations: async () => ({ locations: [] }) },
    documents: { upload: async () => ({ documentId: "doc-reset-1", scan: { status: "clean" } }), extract },
    orders: { create, reconcileQuotes: vi.fn(async () => ({ summary: null })) },
    ocr: { run: vi.fn(async () => ({})) },
  });
  installRbac("sales_engineer");
  for (const k of ["notifySuccess", "notifyError", "notifyWarn", "notifyLive"]) (window as any)[k] = vi.fn();
  window.location.hash = "#/so?new=1";
});

const pdf = (name: string) => new File(["%PDF-1.4 fake"], name, { type: "application/pdf" });
const button = (c: HTMLElement, re: RegExp) =>
  Array.from(c.querySelectorAll("button")).find((b) => re.test(b.textContent || "")) as HTMLButtonElement;

const uploadFirstPo = async () => {
  const { container } = renderScreen((await import("./so-intake")).default);
  await new Promise((r) => setTimeout(r, 0));
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [pdf("first.pdf")] });
  fireEvent.change(input);
  await waitFor(() => expect((container.querySelector("#so-intake-customer") as HTMLSelectElement)?.value).toBe(CUSTOMER.id), { timeout: 2000 });
  return container;
};

const continueAndRead = async (c: HTMLElement) => {
  await waitFor(() => expect(button(c, /^\s*continue/i).disabled).toBe(false));
  fireEvent.click(button(c, /^\s*continue/i));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1), { timeout: 2000 });
  return create.mock.calls[0][0];
};

describe("SoIntake extraction state", () => {
  it("drops the first PO's lines when a second PO extracts none", async () => {
    const c = await uploadFirstPo();
    const zone = button(c, /remove/).parentElement as HTMLElement;
    fireEvent.drop(zone, { dataTransfer: { files: [pdf("second.pdf")] } });
    await waitFor(() => expect(extract).toHaveBeenCalledTimes(2), { timeout: 2000 });

    const body = await continueAndRead(c);
    expect(body.result.salesOrder.lineItems).toBeUndefined();
    expect(body.result.salesOrder.customer.po_number).toBe("PO-SECOND");
    expect(body.preflight_payload.extraction_run_id).toBeUndefined();
  });

  it("drops the removed PO's lines and customer block", async () => {
    const c = await uploadFirstPo();
    fireEvent.click(button(c, /remove/));
    await waitFor(() => expect(c.querySelector('input[type="file"]')).toBeTruthy());

    const body = await continueAndRead(c);
    expect(body.result).toEqual({});
    expect(body.po_number).toBeUndefined();
  });
});
