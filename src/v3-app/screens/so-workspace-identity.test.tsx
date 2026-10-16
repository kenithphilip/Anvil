// The SO workspace shows how the customer was chosen, and lets a person fix
// the customer, the PO number and the PO date before approval (plan PR 7).
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor, fireEvent, within, screen } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-identity-1";
const base = (over: any = {}) => ({
  id: ORDER_ID, status: "DRAFT", po_number: "PO-ID-1", po_date: "2026-10-01", customer_id: "cust-1",
  customer: { customer_name: "Letterhead Buyer" },
  preflight_payload: {
    source_document_id: "doc-1", last_validated_at: "2026-10-10T00:00:00Z",
    customer_match: { customer_id: "cust-1", basis: "letterhead", at: "2026-10-09T00:00:00Z" },
  },
  documents: [{ id: "doc-1" }], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  result: {
    salesOrder: {
      grandTotal: 1000,
      customer: { name: "Letterhead Buyer" },
      lineItems: [{ partNumber: "ID-1", description: "Part one", qty: 10, rate: 100, uom: "NOS", _match: { verdict: "matched", part_no: "ID-1" } }],
    },
    quoteReconciliation: { summary: { total: 1, matched: 1 }, flags: [], quoted_not_ordered: [] },
  },
  ...over,
});

let update: any;
let get: any;
const mount = async (o: any) => {
  window.location.hash = "#/so?id=" + o.id;
  update = vi.fn(async () => ({}));
  get = vi.fn(async () => ({ order: o }));
  installBackend({
    orders: { get, update, terms: vi.fn(async () => ({ mode: "off", visible: false, flags: [] })) },
    customers: {
      list: vi.fn(async () => ({ customers: [
        { id: "cust-1", customer_name: "Letterhead Buyer", gstin: "" },
        { id: "cust-2", customer_name: "Right Buyer Pvt Ltd", gstin: "27AABCR0000R1Z5" },
      ] })),
    },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
    docai: { soProcessingMode: vi.fn(async () => ({ mode: "B" })), getRun: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  const view = renderScreen(mod.default);
  await waitFor(() => expect(view.container.querySelector("[data-testid='so-summary-strip']")).toBeTruthy());
  return view;
};
const strip = (c: HTMLElement) => c.querySelector("[data-testid='so-summary-strip']") as HTMLElement;
const changeLinks = (c: HTMLElement) => within(strip(c)).queryAllByText("change");

beforeEach(() => {
  installRbac("sales_manager");
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
});

describe("the summary strip names the match basis", () => {
  it("shows the basis the intake saved", async () => {
    const { container } = await mount(base());
    expect(within(strip(container)).getByText("matched by letterhead")).toBeTruthy();
  });

  it("shows a customer chosen by hand", async () => {
    const { container } = await mount(base({ preflight_payload: { customer_match: { customer_id: "cust-1", basis: "operator" } } }));
    expect(within(strip(container)).getByText("chosen by hand")).toBeTruthy();
  });
});

describe("the change link", () => {
  it("opens the customer picker and sends only the new customer", async () => {
    const { container } = await mount(base());
    const loads = get.mock.calls.length;
    await act(async () => { fireEvent.click(changeLinks(container)[0]); });
    const dialog = await screen.findByRole("dialog", { name: "Customer and PO details" });
    const select = within(dialog).getByLabelText("Customer") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "cust-2" } });
    await act(async () => { fireEvent.click(within(dialog).getByText("Save")); });
    await waitFor(() => expect(update).toHaveBeenCalledWith(ORDER_ID, { customer_id: "cust-2" }));
    // The order reloads, so the strip shows what the server did.
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(loads));
  });

  it("narrows the picker by name or GSTIN", async () => {
    const { container } = await mount(base());
    await act(async () => { fireEvent.click(changeLinks(container)[0]); });
    const dialog = await screen.findByRole("dialog", { name: "Customer and PO details" });
    await waitFor(() => expect((within(dialog).getByLabelText("Customer") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(within(dialog).getByPlaceholderText("Search by name or GSTIN"), { target: { value: "27AABCR" } });
    const options = Array.from((within(dialog).getByLabelText("Customer") as HTMLSelectElement).options).map((op) => op.value);
    // The current customer stays listed so the select keeps its value.
    expect(options).toEqual(["", "cust-1", "cust-2"]);
  });

  it("fixes the PO number and date, with the reason for the audit", async () => {
    const { container } = await mount(base());
    await act(async () => { fireEvent.click(changeLinks(container)[1]); });
    const dialog = await screen.findByRole("dialog", { name: "Customer and PO details" });
    fireEvent.change(within(dialog).getByLabelText("PO number"), { target: { value: "PO-ID-1A" } });
    fireEvent.change(within(dialog).getByLabelText("PO date"), { target: { value: "2026-09-28" } });
    fireEvent.change(within(dialog).getByLabelText(/Why/), { target: { value: "Typo on the PO" } });
    await act(async () => { fireEvent.click(within(dialog).getByText("Save")); });
    await waitFor(() => expect(update).toHaveBeenCalledWith(ORDER_ID, { po_number: "PO-ID-1A", po_date: "2026-09-28", reason: "Typo on the PO" }));
  });

  it("shows the server's refusal in the dialog", async () => {
    const { container } = await mount(base());
    await act(async () => { fireEvent.click(changeLinks(container)[0]); });
    const dialog = await screen.findByRole("dialog", { name: "Customer and PO details" });
    update.mockImplementationOnce(async () => { throw new Error("No such customer."); });
    const select = within(dialog).getByLabelText("Customer") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "cust-2" } });
    await act(async () => { fireEvent.click(within(dialog).getByText("Save")); });
    expect((await within(dialog).findByRole("alert")).textContent).toBe("No such customer.");
  });

  it("is offered on PENDING_REVIEW, and not once the order is approved", async () => {
    const review = await mount(base({ status: "PENDING_REVIEW" }));
    expect(changeLinks(review.container)).toHaveLength(2);
    review.unmount();
    const approved = await mount(base({ status: "APPROVED" }));
    expect(changeLinks(approved.container)).toHaveLength(0);
  });

  it("is what the 'No customer on the order' row opens", async () => {
    const { container } = await mount(base({ customer_id: null, customer: null, preflight_payload: { source_document_id: "doc-1" } }));
    const pick = await within(container).findByText("Pick the customer");
    await act(async () => { fireEvent.click(pick); });
    expect(await screen.findByRole("dialog", { name: "Customer and PO details" })).toBeTruthy();
  });
});
