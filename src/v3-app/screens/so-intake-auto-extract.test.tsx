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

  it("does NOT auto-select when extracted name is the project / end-customer (Northwind -> Meridian regression)", async () => {
    // Bug fix May 2026 (post-Phase-F): an Northwind Korea PO referencing
    // a Meridian Steel project auto-selected the existing "Meridian
    // Steel" customer record because:
    //   1. the LLM picked "Meridian Steel" as customer.name (it was
    //      in the project name + line item descriptions),
    //   2. the matcher trusted the name without bill-to corroboration.
    // The matcher now requires the canonical name to appear inside
    // bill_to_address. With bill_to = Northwind, name = Meridian, the
    // matcher refuses to auto-select.
    const HYUNDAI = { id: "cust-hyundai", customer_name: "Meridian Steel", gstin: "" };
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [HYUNDAI] }) },
      documents: {
        upload: async () => ({ documentId: "doc-obara", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.92,
          normalized: { customer: {
            name: "Meridian Steel",                                    // wrong, picked from project ref
            country: "KR",
            tax_id: "123-45-67890",
            tax_id_type: "brn",
            currency: "USD",
            payment_terms: "T/T 90 days from BL",
            bill_to_address: "Northwind Korea Co Ltd, 1-2 Industrial Park, Seoul, South Korea",
            ship_to_address: "Meridian Steel Dangjin Works, Dangjin, South Korea",
          } },
        }),
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile("25PO0008243-Northwind.pdf")] });
    fireEvent.change(fileInput!);
    // Dialog should open. The matcher refused to auto-select Meridian.
    await waitFor(() => {
      const input = container.querySelector('#nc-name') as HTMLInputElement | null;
      expect(input).not.toBeNull();
    }, { timeout: 2000 });
    const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
    expect(sel?.value).not.toBe("cust-hyundai");
  });

  it("auto-selects when name corroborates with bill-to (Northwind positive case)", async () => {
    // Inverse of the Northwind -> Meridian test: when the extractor name
    // appears inside bill_to_address AND there's an existing
    // customer with that name, auto-select still fires.
    const Northwind = { id: "cust-obara", customer_name: "Northwind Korea Co Ltd", gstin: "" };
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [Northwind] }) },
      documents: {
        upload: async () => ({ documentId: "doc-obara-ok", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.92,
          normalized: { customer: {
            name: "Northwind Korea Co Ltd",
            country: "KR",
            tax_id: "123-45-67890",
            tax_id_type: "brn",
            currency: "USD",
            bill_to_address: "Northwind Korea Co Ltd, Seoul, South Korea",
          } },
        }),
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile("25PO0008243-Northwind.pdf")] });
    fireEvent.change(fileInput!);
    await waitFor(() => {
      const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
      expect(sel?.value).toBe("cust-obara");
    }, { timeout: 2000 });
  });

  it("auto-selects Summit Automation when filename has unrelated Northwind (regression)", async () => {
    // The actual user case from the Northwind file. The buyer is Summit
    // Automation. The filename has "Northwind" (equipment brand). The
    // earlier draft of this matcher refused auto-select because
    // filename token "obara" did not intersect "faithautomation".
    // Filename-hint refusal dropped; bill-to corroboration alone
    // is the auto-select gate for name matches.
    const FAITH = { id: "cust-faith", customer_name: "Summit Automation Pvt Ltd", gstin: "" };
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [FAITH] }) },
      documents: {
        upload: async () => ({ documentId: "doc-faith", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.92,
          normalized: { customer: {
            name: "Summit Automation Pvt Ltd",
            country: "IN",
            currency: "INR",
            payment_terms: "Net 30",
            bill_to_address: "Summit Automation Pvt Ltd, Plot 12, MIDC, Pune 411018",
            ship_to_address: "Summit Automation Pvt Ltd, Plot 12, MIDC, Pune 411018",
          } },
        }),
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile("25PO0008243-Northwind.pdf")] });
    fireEvent.change(fileInput!);
    await waitFor(() => {
      const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
      expect(sel?.value).toBe("cust-faith");
    }, { timeout: 2000 });
  });

  it("auto-selects with legal-suffix variation (extracted 'Summit Automation' matches stored 'Summit Automation Pvt Ltd')", async () => {
    // The customer record carries the full legal name; the LLM
    // sometimes drops the suffix when extracting from the bill-to
    // header. norm() now strips Pvt/Ltd/Inc/etc. so the match
    // succeeds either way.
    const FAITH = { id: "cust-faith2", customer_name: "Summit Automation Pvt Ltd", gstin: "" };
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [FAITH] }) },
      documents: {
        upload: async () => ({ documentId: "doc-faith-suffix", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.9,
          normalized: { customer: {
            name: "Summit Automation",                       // suffix dropped by LLM
            country: "IN",
            currency: "INR",
            bill_to_address: "Summit Automation Pvt Ltd, Pune 411018",
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
      const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
      expect(sel?.value).toBe("cust-faith2");
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
            name: "Northwind Korea Co Ltd",
            country: "KR",
            tax_id: "123-45-67890",
            tax_id_type: "brn",
            currency: "USD",
            payment_terms: "T/T 30 days from BL",
            email: "ops@northwind.kr",
            phone: "+82 2 1234 5678",
            bill_to_address: "Northwind Korea Co Ltd, Seoul",
            ship_to_address: "Meridian Dangjin Works, Dangjin",
          } },
        }),
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile("25PO0008243-Northwind.pdf")] });
    fireEvent.change(fileInput!);
    await waitFor(() => {
      const input = container.querySelector('#nc-name') as HTMLInputElement | null;
      expect(input?.value).toBe("Northwind Korea Co Ltd");
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

  it("flags mismatched fields and offers Update customer when PO disagrees with stored record", async () => {
    // Existing customer has stale GSTIN + missing email + different
    // bill-to. Auto-match still fires (bill-to corroborates the
    // first token of the canonical name) but a warn banner lists
    // the diffs and an Update customer button opens the dialog in
    // edit mode with PO values pre-filled.
    const FAITH = {
      id: "cust-faith3",
      customer_key: "faith-automation",
      customer_name: "Summit Automation Pvt Ltd",
      gstin: "27OLDGS1234E1Z5",                            // stale
      country: "IN",
      currency: "INR",
      payment_terms: "Net 45",                             // older value
      bill_to: "Summit Automation Pvt Ltd, Plot 12, MIDC, Pune 411018",
      contact_email: null,                                 // never recorded
    };
    let upsertPayload: any = null;
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: {
        list: async () => ({ customers: [FAITH] }),
        upsert: async (payload: any) => { upsertPayload = payload; return { customer: { ...FAITH, ...payload } }; },
      },
      documents: {
        upload: async () => ({ documentId: "doc-faith-mismatch", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.92,
          normalized: { customer: {
            name: "Summit Automation Pvt Ltd",
            country: "IN",
            gstin: "27NEWGS9999F1Z5",                      // changed
            state_code: "27",
            currency: "INR",
            payment_terms: "Net 30",                        // changed
            email: "ops@faith.in",                         // new (was empty)
            phone: "+91 98765 43210",                      // new
            bill_to_address: "Summit Automation Pvt Ltd, Plot 14, MIDC, Pune 411019",   // changed
          } },
        }),
      },
    });
    const mod = await import("./so-intake");
    const { container, findByText } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile("po.pdf")] });
    fireEvent.change(fileInput!);

    // Auto-select fires (bill-to corroborates).
    await waitFor(() => {
      const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
      expect(sel?.value).toBe("cust-faith3");
    }, { timeout: 2000 });

    // Mismatch banner renders with the diff list.
    await findByText(/Some customer details have changed/i);

    // Click Update customer -> dialog opens in edit mode.
    const updateBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Update customer");
    expect(updateBtn).toBeTruthy();
    fireEvent.click(updateBtn!);

    // Dialog title now says Edit customer.
    await findByText("Edit customer");

    // PO values are pre-filled into the form.
    const gstinIn = container.querySelector('#nc-gstin') as HTMLInputElement | null;
    expect(gstinIn?.value).toBe("27NEWGS9999F1Z5");
    const termsIn = container.querySelector('#nc-terms') as HTMLInputElement | null;
    expect(termsIn?.value).toBe("Net 30");
    const emailIn = container.querySelector('#nc-email') as HTMLInputElement | null;
    expect(emailIn?.value).toBe("ops@faith.in");

    // Submit (footer button now reads Update customer).
    const submit = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Update customer" && b.getAttribute("type") !== "button");
    // Some Btn primitives don't set type; fall back to the last "Update customer" button.
    const submitBtn = submit
      || Array.from(container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Update customer").slice(-1)[0];
    fireEvent.click(submitBtn!);

    // Upsert is called with the existing customer_key so the row
    // updates instead of duplicating.
    await waitFor(() => {
      expect(upsertPayload).not.toBeNull();
      expect(upsertPayload.customer_key).toBe("faith-automation");
      expect(upsertPayload.gstin).toBe("27NEWGS9999F1Z5");
      expect(upsertPayload.payment_terms).toBe("Net 30");
      expect(upsertPayload.contact_email).toBe("ops@faith.in");
    }, { timeout: 2000 });
  });

  it("does NOT show the mismatch banner when PO matches stored record", async () => {
    // Same customer, same details. Banner should not render.
    const FAITH = {
      id: "cust-faith4",
      customer_key: "faith-automation-2",
      customer_name: "Summit Automation Pvt Ltd",
      gstin: "27ABCDE1234F1Z5",
      state_code: "27",
      country: "IN",
      currency: "INR",
      payment_terms: "Net 30",
      bill_to: "Summit Automation Pvt Ltd, Plot 12, MIDC, Pune 411018",
    };
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [FAITH] }) },
      documents: {
        upload: async () => ({ documentId: "doc-clean", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.95,
          normalized: { customer: {
            name: "Summit Automation Pvt Ltd",
            country: "IN",
            gstin: "27ABCDE1234F1Z5",
            state_code: "27",
            currency: "INR",
            payment_terms: "Net 30",
            bill_to_address: "Summit Automation Pvt Ltd, Plot 12, MIDC, Pune 411018",
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
      const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
      expect(sel?.value).toBe("cust-faith4");
    }, { timeout: 2000 });
    // No mismatch banner.
    expect(container.textContent).not.toMatch(/Some customer details have changed/i);
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

  it("auto-selects HMI Pune when bill-to is street-only but state_code corroborates (P250432265 regression)", async () => {
    // The actual user-reported case from PO P250432265. Meridian
    // Motor India Ltd's PO header carries the buyer name and a
    // street/district/state postal address, but the address text
    // itself does not contain the word "Meridian". The matcher used
    // to require the buyer's name token to appear inside
    // bill_to_address, so the auto-match refused and the operator
    // had to find MMIL manually in the dropdown every time.
    // Now state_code corroboration ("27" = Maharashtra) plus the
    // exact normalised name match is sufficient.
    const MMIL = {
      id: "cust-hmil",
      customer_name: "Meridian Motor India Ltd",
      gstin: "",                 // MMIL header on this PO does not print buyer GSTIN
      state_code: "27",
      country: "IN",
    };
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: { list: async () => ({ customers: [MMIL] }) },
      documents: {
        upload: async () => ({ documentId: "doc-hmil", scan: { status: "clean" } }),
        extract: async () => ({
          confidence_overall: 0.92,
          normalized: { customer: {
            name: "Meridian Motor India Ltd",
            country: "IN",
            state_code: "27",
            currency: "INR",
            payment_terms: "",
            vendor_code: "TH1M",
            // Street-only bill-to: no occurrence of "hyundai" anywhere.
            bill_to_address: "Plot No A 16, MIDC Phase II Expansion, Talegaon, District-Pune 410507, Maharashtra",
            ship_to_address: "Plot No A 16, MIDC Phase II Expansion, Talegaon, District-Pune 410507, Maharashtra",
          } },
        }),
      },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    Object.defineProperty(fileInput!, "files", { value: [fakeFile("P250432265.pdf")] });
    fireEvent.change(fileInput!);
    await waitFor(() => {
      const sel = container.querySelector('#so-intake-customer') as HTMLSelectElement | null;
      expect(sel?.value).toBe("cust-hmil");
    }, { timeout: 2000 });
  });
});
