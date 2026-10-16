// Intake used to AWAIT the OCR call before it opened the workspace, though
// its own comment said "don't block navigation". A slow OCR kept the operator
// on "creating…". OCR now runs fire-and-forget. And the static "Profile match"
// and hardcoded "Estimated cost ₹ 2.40" cards are gone (audit S7).
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const CUSTOMER = { id: "cust-ocr", customer_name: "Ocr Buyer", gstin: "29AABCO1234E1Z5" };

let create: any;
let ocrRun: any;

beforeEach(() => {
  create = vi.fn(async () => ({ order: { id: "ord-ocr-1" } }));
  // OCR that never answers: if intake waited for it, it would never navigate.
  ocrRun = vi.fn(() => new Promise(() => {}));
  installBackend({
    health: async () => ({ integrations: [] }),
    customers: { list: async () => ({ customers: [CUSTOMER] }), listLocations: async () => ({ locations: [] }) },
    documents: {
      upload: async () => ({ documentId: "doc-ocr-1", scan: { status: "clean" } }),
      extract: async () => ({
        run_id: "run-ocr-1", adapter_used: "gemini", confidence_overall: 0.95,
        normalized: {
          customer: { name: "Ocr Buyer", gstin: CUSTOMER.gstin },
          lines: [{ partNumber: "OC-1", description: "Valve", quantity: 3, unitPrice: 40 }],
        },
      }),
    },
    orders: { create, reconcileQuotes: vi.fn(async () => ({ summary: null })) },
    ocr: { run: ocrRun },
  });
  installRbac("sales_engineer");
  window.location.hash = "#/so?new=1";
});

describe("SoIntake continue", () => {
  it("opens the workspace without waiting for OCR, and still starts OCR", async () => {
    const { container } = renderScreen((await import("./so-intake")).default);
    (window as any).notifySuccess = vi.fn();
    (window as any).notifyError = vi.fn();
    (window as any).notifyWarn = vi.fn();
    (window as any).notifyLive = vi.fn();
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [new File(["%PDF-1.4 fake"], "po.pdf", { type: "application/pdf" })] });
    fireEvent.change(fileInput);
    await waitFor(() => expect((container.querySelector("#so-intake-customer") as HTMLSelectElement)?.value).toBe(CUSTOMER.id), { timeout: 2000 });

    const cont = Array.from(container.querySelectorAll("button")).find((b) => /^\s*continue/i.test(b.textContent || "")) as HTMLButtonElement;
    fireEvent.click(cont);

    await waitFor(() => expect(window.location.hash).toBe("#/so?id=ord-ocr-1"), { timeout: 2000 });
    expect(ocrRun).toHaveBeenCalledWith("doc-ocr-1", "ord-ocr-1");
    expect((window as any).notifySuccess).toHaveBeenCalledWith("Draft created", expect.stringContaining("1 line from PO"));
  });

  it("no longer shows the static Profile match and Estimated cost cards", async () => {
    const { container } = renderScreen((await import("./so-intake")).default);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toContain("Order Mode");
    expect(container.textContent).not.toContain("Profile match");
    expect(container.textContent).not.toContain("Estimated cost");
    expect(container.textContent).not.toContain("₹ 2.40");
  });
});
