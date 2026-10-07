// SO intake: matching the buyer by name when the PO prints no GSTIN.
//
// A PO read by the table parser (llamaparse) carries the buyer only as its
// letterhead: no GSTIN (the one GSTIN printed is the supplier's, ours), no
// bill-to block. The name tier refused every such PO, because it requires a
// corroborating signal and the letterhead was not one. And when the buyer had
// been entered twice (one record with a GSTIN, one without), the matcher took
// whichever was first in the list.
//
// Every name and number here is invented.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const notifyLive = vi.fn();

beforeEach(() => {
  installRbac("admin");
  notifyLive.mockReset();
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  (window as any).notifyLive = notifyLive;
  if (!("arrayBuffer" in Blob.prototype)) {
    Object.defineProperty(Blob.prototype, "arrayBuffer", {
      value: function () { return Promise.resolve(new ArrayBuffer(0)); },
      writable: true, configurable: true,
    });
  }
});

// The customer block po-header-text.js returns for a letterhead-only PO.
const LETTERHEAD = {
  name: "FIXTURE BUYER INDUSTRIES PVT LTD",
  po_number: "PO-FX-0001",
  po_date: "2026-10-01",
  vendor_code: "ZQ9X",
  currency: "INR",
  _name_source: "letterhead",
  _source: "header_text",
};

const run = async (customers: any[], extracted: any, { profiles = {}, confidence = 0.97 } = {}) => {
  installBackend({
    health: async () => ({ integrations: [] }),
    customers: { list: async () => ({ customers, profiles }) },
    documents: {
      upload: async () => ({ documentId: "doc-1", scan: { status: "clean" } }),
      extract: async () => ({ confidence_overall: confidence, normalized: { customer: extracted } }),
    },
  });
  const mod = await import("./so-intake");
  const { container } = renderScreen(mod.default);
  await new Promise((r) => setTimeout(r, 0));
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [new File(["%PDF-1.4"], "po.pdf", { type: "application/pdf" })] });
  fireEvent.change(fileInput);
  return container;
};
const selected = (c: HTMLElement) => (c.querySelector("#so-intake-customer") as HTMLSelectElement | null)?.value;
const dialogOpen = (c: HTMLElement) => !!c.querySelector("#nc-name");

describe("name tier: a letterhead read by label", () => {
  it("selects the one customer the letterhead names, with no GSTIN and no bill-to", async () => {
    const c = await run([
      { id: "cust-buyer", customer_name: "Fixture Buyer Industries Pvt Ltd", gstin: "" },
      { id: "cust-other", customer_name: "Other Works Ltd", gstin: "" },
    ], LETTERHEAD);
    await waitFor(() => expect(selected(c)).toBe("cust-buyer"), { timeout: 2000 });
  });

  it("does not take the same name on trust when a model read it (no letterhead provenance)", async () => {
    const { _name_source: _drop, ...modelRead } = LETTERHEAD;
    const c = await run([{ id: "cust-buyer", customer_name: "Fixture Buyer Industries Pvt Ltd", gstin: "" }], modelRead);
    await waitFor(() => expect(dialogOpen(c)).toBe(true), { timeout: 2000 });
    expect(selected(c)).not.toBe("cust-buyer");
  });

  it("does not use the letterhead when the PO's own bill-to block says something else", async () => {
    const c = await run([{ id: "cust-buyer", customer_name: "Fixture Buyer Industries Pvt Ltd", gstin: "" }],
      { ...LETTERHEAD, bill_to_address: "Northwind Trading, Dock Road, Sample Port" });
    await waitFor(() => expect(dialogOpen(c)).toBe(true), { timeout: 2000 });
    expect(selected(c)).not.toBe("cust-buyer");
  });

  it("still refuses below the run-confidence gate", async () => {
    const c = await run([{ id: "cust-buyer", customer_name: "Fixture Buyer Industries Pvt Ltd", gstin: "" }], LETTERHEAD, { confidence: 0.82 });
    await waitFor(() => expect(dialogOpen(c)).toBe(true), { timeout: 2000 });
    expect(selected(c)).not.toBe("cust-buyer");
  });
});

describe("name tier: the same buyer entered twice", () => {
  it("prefers the record with a GSTIN, wherever it sits in the list", async () => {
    const c = await run([
      { id: "cust-dup-bare", customer_name: "Fixture Buyer Industries Pvt Ltd", gstin: "" },
      { id: "cust-dup-gstin", customer_name: "FIXTURE BUYER INDUSTRIES LTD.", gstin: "29AABCF1234K1Z9" },
    ], LETTERHEAD);
    await waitFor(() => expect(selected(c)).toBe("cust-dup-gstin"), { timeout: 2000 });
  });

  it("then prefers the record with order history (a format profile)", async () => {
    const c = await run([
      { id: "cust-dup-a", customer_name: "Fixture Buyer Industries", gstin: "" },
      { id: "cust-dup-b", customer_name: "Fixture Buyer Industries Pvt Ltd", gstin: "" },
    ], LETTERHEAD, { profiles: { "cust-dup-b": { customer_id: "cust-dup-b", is_current: true } } });
    await waitFor(() => expect(selected(c)).toBe("cust-dup-b"), { timeout: 2000 });
  });

  it("surfaces the choice when nothing tells them apart, without opening the new-customer dialog", async () => {
    const c = await run([
      { id: "cust-dup-a", customer_name: "Fixture Buyer Industries", gstin: "" },
      { id: "cust-dup-b", customer_name: "Fixture Buyer Industries Pvt Ltd", gstin: "" },
    ], LETTERHEAD);
    await waitFor(() => expect(notifyLive).toHaveBeenCalled(), { timeout: 2000 });
    const [title, body] = notifyLive.mock.calls[notifyLive.mock.calls.length - 1];
    expect(title).toMatch(/^2 customers are named/);
    expect(body).toMatch(/Fixture Buyer Industries \(no GSTIN\), Fixture Buyer Industries Pvt Ltd \(no GSTIN\)/);
    expect(selected(c)).not.toBe("cust-dup-a");
    expect(selected(c)).not.toBe("cust-dup-b");
    expect(dialogOpen(c)).toBe(false);
  });
});
