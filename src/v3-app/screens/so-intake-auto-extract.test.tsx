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
          // Bug fix May 2026: previously the dialog dropped email
          // and phone on the floor even though the docai schema
          // returns both. Both are now pre-filled.
          return { normalized: { customer: {
            name: "Brand-new Customer Pvt. Ltd.",
            email: "ops@brand-new.com",
            phone: "+91 98765 43210",
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
    // Bug fix May 2026: contact email + phone pre-fill from the PO
    // header so the operator doesn't retype them.
    const email = container.querySelector('#nc-email') as HTMLInputElement | null;
    expect(email?.value).toBe("ops@brand-new.com");
    const phone = container.querySelector('#nc-phone') as HTMLInputElement | null;
    expect(phone?.value).toBe("+91 98765 43210");
  });

  it("does NOT auto-select when extracted name is the project / end-customer (OBARA -> Hyundai regression)", async () => {
    // Bug fix May 2026 (post-Phase-F): an OBARA Korea PO referencing
    // a Hyundai Steel project auto-selected the existing "Hyundai
    // Steel" customer record because:
    //   1. the LLM picked "Hyundai Steel" as customer.name (it was
    //      in the project name + line item descriptions),
    //   2. the matcher trusted the name without bill-to corroboration.
    // The matcher now requires the canonical name to appear inside
    // bill_to_address. With bill_to = OBARA, name = Hyundai, the
    // matcher refuses to auto-select.
    const HYUNDAI = { id: "cust-hyundai", customer_name: "Hyundai Steel", gstin: "" };
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [HYUNDAI] }) },
      documents: {
        upload: async () => ({ documentId: "doc-obara", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.92,
          normalized: { customer: {
            name: "Hyundai Steel",                                    // wrong, picked from project ref
            country: "KR",
            tax_id: "123-45-67890",
            tax_id_type: "brn",
            currency: "USD",
            payment_terms: "T/T 90 days from BL",
            bill_to_address: "OBARA Korea Co Ltd, 1-2 Industrial Park, Seoul, South Korea",
            ship_to_address: "Hyundai Steel Dangjin Works, Dangjin, South Korea",
          } },
        }),
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile("25PO0008243-OBARA.pdf")] });
    fireEvent.change(fileInput!);
    // Dialog should open. The matcher refused to auto-select Hyundai.
    await waitFor(() => {
      const input = container.querySelector('#nc-name') as HTMLInputElement | null;
      expect(input).not.toBeNull();
    }, { timeout: 2000 });
    const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
    expect(sel?.value).not.toBe("cust-hyundai");
  });

  it("auto-selects when name corroborates with bill-to (OBARA positive case)", async () => {
    // Inverse of the OBARA -> Hyundai test: when the extractor name
    // appears inside bill_to_address AND there's an existing
    // customer with that name, auto-select still fires.
    const OBARA = { id: "cust-obara", customer_name: "OBARA Korea Co Ltd", gstin: "" };
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [OBARA] }) },
      documents: {
        upload: async () => ({ documentId: "doc-obara-ok", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.92,
          normalized: { customer: {
            name: "OBARA Korea Co Ltd",
            country: "KR",
            tax_id: "123-45-67890",
            tax_id_type: "brn",
            currency: "USD",
            bill_to_address: "OBARA Korea Co Ltd, Seoul, South Korea",
          } },
        }),
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile("25PO0008243-OBARA.pdf")] });
    fireEvent.change(fileInput!);
    await waitFor(() => {
      const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
      expect(sel?.value).toBe("cust-obara");
    }, { timeout: 2000 });
  });

  it("does NOT auto-select on low extractor confidence", async () => {
    // Confidence gate: the matcher refuses auto-select when
    // confidence_overall < 0.85, even on an exact bill-to-corroborated
    // name match. Operator confirms via dialog.
    const TARGET = { id: "cust-tata", customer_name: "Tata Steel Ltd", gstin: "27AABCT1234E1Z5" };
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [TARGET] }) },
      documents: {
        upload: async () => ({ documentId: "doc-low", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.6,
          normalized: { customer: {
            name: "Tata Steel Ltd",
            country: "IN",
            gstin: "29DIFFRENT1234F1",   // doesn't match TARGET's GSTIN
            state_code: "29",
            bill_to_address: "Tata Steel Ltd, Mumbai 400001",
          } },
        }),
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile("po.pdf")] });
    fireEvent.change(fileInput!);
    await waitFor(() => {
      const input = container.querySelector('#nc-name') as HTMLInputElement | null;
      expect(input).not.toBeNull();
    }, { timeout: 2000 });
    const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
    expect(sel?.value).not.toBe("cust-tata");
  });

  it("non-Indian extraction prefills tax_id + tax_id_type and shows country dropdown", async () => {
    // International PO with country=KR and a Korean BRN tax_id. The
    // dialog should pre-fill country, tax_id, tax_id_type, and the
    // GSTIN/state_code fields should not render.
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [] }) },
      documents: {
        upload: async () => ({ documentId: "doc-kr", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.9,
          normalized: { customer: {
            name: "OBARA Korea Co Ltd",
            country: "KR",
            tax_id: "123-45-67890",
            tax_id_type: "brn",
            currency: "USD",
            payment_terms: "T/T 30 days from BL",
            email: "ops@obara.kr",
            phone: "+82 2 1234 5678",
            bill_to_address: "OBARA Korea Co Ltd, Seoul",
            ship_to_address: "Hyundai Dangjin Works, Dangjin",
          } },
        }),
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile("25PO0008243-OBARA.pdf")] });
    fireEvent.change(fileInput!);
    await waitFor(() => {
      const input = container.querySelector('#nc-name') as HTMLInputElement | null;
      expect(input?.value).toBe("OBARA Korea Co Ltd");
    }, { timeout: 2000 });
    // Country dropdown should be set to KR.
    const country = container.querySelector('#nc-country') as HTMLSelectElement | null;
    expect(country?.value).toBe("KR");
    // GSTIN field should not render for non-IN.
    expect(container.querySelector('#nc-gstin')).toBeNull();
    // tax_id + tax_id_type fields render and pre-fill.
    const taxId = container.querySelector('#nc-taxid') as HTMLInputElement | null;
    expect(taxId?.value).toBe("123-45-67890");
    const taxIdType = container.querySelector('#nc-taxidtype') as HTMLSelectElement | null;
    expect(taxIdType?.value).toBe("brn");
    // Currency from PO (USD), payment_terms from PO (T/T 30 days from BL).
    const ccy = container.querySelector('#nc-ccy') as HTMLSelectElement | null;
    expect(ccy?.value).toBe("USD");
    const terms = container.querySelector('#nc-terms') as HTMLInputElement | null;
    expect(terms?.value).toBe("T/T 30 days from BL");
  });

  it("loose name match suggests but does NOT auto-select; dialog opens with prefill", async () => {
    // Bug fix May 2026 (customer-prefill report): the previous
    // matcher loose-prefix-matched "Tata Steel" (extracted) against
    // "Tata Steel Ltd" (existing) and silently auto-selected. The
    // operator then saw "—" for every field on the existing
    // customer's record (because that record happened to be missing
    // GSTIN/terms/etc.) and concluded "fields not auto-populating".
    // The matcher now suggests via toast but always opens the new-
    // customer dialog so the operator can confirm or replace.
    const EXISTING = { id: "cust-tata", customer_name: "Tata Steel Ltd", gstin: "27AABCT1234E1Z5" };
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [EXISTING] }) },
      documents: {
        upload: async () => ({ documentId: "doc-2", scan: { status: "clean" } }),
        extract: async () => ({ normalized: { customer: {
          name: "Tata Steel",   // prefix of "Tata Steel Ltd"
          gstin: "29DIFFRENT1234F1",   // different GSTIN, so no high-confidence match
          state_code: "27",
          currency: "INR",
          payment_terms: "Net 30",
          bill_to_address: "From PO",
        } } }),
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile()] });
    fireEvent.change(fileInput!);
    // Dialog should open even though "Tata Steel" is a name-prefix
    // of the existing "Tata Steel Ltd" record.
    await waitFor(() => {
      const input = container.querySelector('#nc-name') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input!.value).toBe("Tata Steel");
    }, { timeout: 2000 });
    // The existing customer should NOT have been auto-selected.
    const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
    expect(sel?.value).not.toBe("cust-tata");
  });
});
