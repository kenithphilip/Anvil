// Behaviour test for the SO Intake auto-extract-on-upload flow.
//
// Contract:
//   1. After file upload, runExtraction calls documents.extract(file).
//   2. If the extracted GSTIN matches an existing customer, the
//      customer dropdown is auto-set (no dialog opens).
//   3. If neither GSTIN nor name matches, the new-customer dialog
//      opens with extracted fields pre-filled.
//
// We test runExtraction's matcher logic via the visible UI side-
// effects: customer select value + new-customer dialog visibility.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  // Stub File / Blob.arrayBuffer because jsdom's File implementation
  // doesn't include arrayBuffer in older versions.
  if (!("arrayBuffer" in Blob.prototype)) {
    Object.defineProperty(Blob.prototype, "arrayBuffer", {
      value: function () { return Promise.resolve(new ArrayBuffer(0)); },
      writable: true, configurable: true,
    });
  }
});

const fakeFile = (name = "po.pdf") =>
  new File(["%PDF-1.4 fake"], name, { type: "application/pdf" });

describe("SO Intake auto-extract", () => {
  it("auto-selects an existing customer when the extractor's GSTIN matches", async () => {
    const TARGET = { id: "cust-tata", customer_name: "Tata Steel", gstin: "27AABCT1234E1Z5" };
    let extractCalled = false;
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [TARGET, { id: "cust-other", customer_name: "Other Inc", gstin: "29AAACO1234F1Z9" }] }) },
      documents: {
        upload: async () => ({ documentId: "doc-1", scan: { status: "clean" } }),
        extract: async () => {
          extractCalled = true;
          return { normalized: { customer: { name: "Tata Steel Ltd", gstin: "27AABCT1234E1Z5" } } };
        },
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();
    Object.defineProperty(fileInput!, "files", { value: [fakeFile()] });
    fireEvent.change(fileInput!);
    await waitFor(() => { expect(extractCalled).toBe(true); }, { timeout: 2000 });
    await waitFor(() => {
      const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
      expect(sel?.value).toBe("cust-tata");
    }, { timeout: 2000 });
  });

  it("opens the new-customer dialog with pre-filled fields when there is no match", async () => {
    let extractCalled = false;
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [{ id: "cust-other", customer_name: "Other Inc", gstin: "29AAACO1234F1Z9" }] }) },
      documents: {
        upload: async () => ({ documentId: "doc-1", scan: { status: "clean" } }),
        extract: async () => {
          extractCalled = true;
          return { normalized: { customer: {
            name: "Brand-new Customer Pvt. Ltd.",
            gstin: "29ABCDE1234F1Z5",
            state_code: "29",
            currency: "INR",
            payment_terms: "Net 45",
            bill_to_address: "Plot 12, MIDC, Pune 411018",
            ship_to_address: "Plot 12, MIDC, Pune 411018",
          } } };
        },
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile()] });
    fireEvent.change(fileInput!);
    await waitFor(() => { expect(extractCalled).toBe(true); }, { timeout: 2000 });
    // Wait for the dialog with pre-filled name. The dialog input
    // for customer_name has id "nc-name" per the source.
    await waitFor(() => {
      const input = container.querySelector('#nc-name') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input!.value).toBe("Brand-new Customer Pvt. Ltd.");
    }, { timeout: 2000 });
    const gstin = container.querySelector('#nc-gstin') as HTMLInputElement | null;
    expect(gstin?.value).toBe("29ABCDE1234F1Z5");
    const terms = container.querySelector('#nc-terms') as HTMLInputElement | null;
    expect(terms?.value).toBe("Net 45");
  });
});
