// The intake saves how it chose the customer (plan PR 7).
//
// The match basis used to live in a toast and nowhere else. The order now
// carries it in preflight_payload.customer_match, so the workspace and the
// approver can see it: the matcher's basis when the order's customer is the
// one it chose, "operator" when a person picked another.
//
// Every name and number here is invented.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const BUYER = { id: "cust-buyer", customer_name: "Fixture Buyer Industries Pvt Ltd", gstin: "27AABCF1234E1Z5" };
const OTHER = { id: "cust-other", customer_name: "Other Works Ltd", gstin: "" };
const LINES = [{ partNumber: "PN-1", description: "Head assy", quantity: 2, unitPrice: 100 }];

let create: any;

beforeEach(() => {
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  for (const k of ["notifySuccess", "notifyError", "notifyWarn", "notifyLive"]) (window as any)[k] = vi.fn();
  if (!("arrayBuffer" in Blob.prototype)) {
    Object.defineProperty(Blob.prototype, "arrayBuffer", {
      value: function () { return Promise.resolve(new ArrayBuffer(0)); },
      writable: true, configurable: true,
    });
  }
});

// Upload a PO whose buyer block is `extracted`, wait for the matcher, run
// `between`, then continue. Returns the body the intake sent to orders.create.
const createWith = async (customers: any[], extracted: any, expectSelected: string, between?: (c: HTMLElement) => void) => {
  create = vi.fn(async (_body: any) => ({ order: { id: "ord-new-1" } }));
  installBackend({
    health: async () => ({ integrations: [] }),
    customers: { list: async () => ({ customers }), listLocations: async () => ({ locations: [] }) },
    documents: {
      upload: async () => ({ documentId: "doc-1", scan: { status: "clean" } }),
      extract: async () => ({ run_id: "run-1", adapter_used: "gemini", confidence_overall: 0.95, normalized: { customer: extracted, lines: LINES } }),
    },
    orders: { create, reconcileQuotes: vi.fn(async () => ({ summary: null })) },
  });
  const { container } = renderScreen((await import("./so-intake")).default);
  await new Promise((r) => setTimeout(r, 0));
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [new File(["%PDF-1.4"], "po.pdf", { type: "application/pdf" })] });
  fireEvent.change(fileInput);
  const select = () => container.querySelector("#so-intake-customer") as HTMLSelectElement | null;
  await waitFor(() => expect(select()?.value).toBe(expectSelected), { timeout: 2000 });
  between?.(container);
  const cont = Array.from(container.querySelectorAll("button"))
    .find((b) => /^\s*continue/i.test(b.textContent || "")) as HTMLButtonElement;
  fireEvent.click(cont);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1), { timeout: 2000 });
  return create.mock.calls[0][0];
};

describe("the intake saves the customer match basis", () => {
  it("a GSTIN match is saved as gstin", async () => {
    const body = await createWith([BUYER, OTHER], { name: "Fixture Buyer", gstin: BUYER.gstin }, BUYER.id);
    expect(body.customer_id).toBe(BUYER.id);
    expect(body.preflight_payload.customer_match).toMatchObject({ customer_id: BUYER.id, basis: "gstin" });
  });

  it("a letterhead-only match is saved as letterhead", async () => {
    const buyer = { ...BUYER, gstin: "" };
    const body = await createWith([buyer, OTHER], {
      name: "FIXTURE BUYER INDUSTRIES PVT LTD", po_number: "PO-FX-0001", _name_source: "letterhead", _source: "header_text",
    }, buyer.id);
    expect(body.preflight_payload.customer_match).toMatchObject({ customer_id: buyer.id, basis: "letterhead" });
  });

  it("a customer the operator picks over the match is saved as operator", async () => {
    const body = await createWith([BUYER, OTHER], { name: "Fixture Buyer", gstin: BUYER.gstin }, BUYER.id, (c) => {
      fireEvent.change(c.querySelector("#so-intake-customer") as HTMLSelectElement, { target: { value: OTHER.id } });
    });
    expect(body.customer_id).toBe(OTHER.id);
    expect(body.preflight_payload.customer_match).toMatchObject({ customer_id: OTHER.id, basis: "operator" });
  });
});
