// The "Needs decision" card at the top of the Reconcile tab (plan PR 9). It
// replaces the quote-check banner's per-item list, so every item the banner
// listed must be in the card; the banner keeps its title and controls.
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const base = (over: any = {}) => ({
  id: "ord-exc-1", status: "DRAFT", po_number: "PO-EXC-1", customer_id: "cust-1", customer_name: "Exc Buyer",
  preflight_payload: { source_document_id: "doc-1", last_validated_at: "2026-10-10T00:00:00Z" },
  documents: [{ id: "doc-1" }], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  result: { salesOrder: { lineItems: [{ partNumber: "EX-1", description: "Clean part", qty: 1, rate: 10, uom: "NOS" }] } },
  ...over,
});

const messy = () => base({
  result: {
    salesOrder: {
      lineItems: [
        { partNumber: "EX-1", description: "Priced part", qty: 100, rate: 1840, uom: "NOS", _match: { verdict: "price_mismatch", part_no: "EX-1" } },
        { partNumber: "EX-2", description: "Odd part", qty: 1, rate: 10, uom: "NOS", _match: { verdict: "unmatched", part_no: "EX-2" } },
      ],
    },
    quoteReconciliation: {
      summary: { total: 2, matched: 0, price_mismatch: 1, unmatched: 1 },
      flags: [
        { part_no: "EX-1", verdict: "price_mismatch", po_rate: 1840, quote_rate: 1750, price_delta_pct: 5.14, po_qty: 100, source_quote_number: "Q-EXC-1" },
        { part_no: "EX-2", verdict: "unmatched" },
        { verdict: "payment_terms_mismatch" },
      ],
      payment_terms: { verdict: "mismatch", po_terms: "90 days from GRN", quote_terms: "30 days from invoice", source_quote_number: "Q-EXC-1" },
      incoterms: { verdict: "mismatch", po_incoterm: "CIF Chennai", quote_incoterm: "FOB Busan", source_quote_number: "Q-EXC-1" },
      quoted_not_ordered: [],
    },
  },
});

const mount = async (o: any, extra: any = {}) => {
  window.location.hash = "#/so?id=" + o.id;
  const backend = {
    orders: { get: vi.fn(async () => ({ order: o })), update: vi.fn(async () => ({})), ...(extra.orders || {}) },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
    ...(extra.rest || {}),
  };
  installBackend(backend);
  const mod = await import("./so-workspace");
  const view = renderScreen(mod.default);
  await waitFor(() => expect(view.container.querySelector("[data-testid='order-exceptions']")).toBeTruthy());
  return { ...view, backend };
};

const card = (c: HTMLElement) => c.querySelector("[data-testid='order-exceptions']") as HTMLElement;

beforeEach(() => {
  installRbac("sales_engineer");
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyWarn = vi.fn();
  (window as any).notifyError = vi.fn();
});

describe("the Needs decision card", () => {
  it("a clean order shows Nothing needs a decision", async () => {
    const { container } = await mount(base());
    expect(card(container).textContent).toContain("Nothing needs a decision");
  });

  it("holds every item the quote-check banner listed, and the banner no longer lists them", async () => {
    const { container } = await mount(messy());
    const text = card(container).textContent || "";
    expect(text).toContain("Payment terms differ from the quote");
    expect(text).toContain("PO “90 days from GRN” vs quote “30 days from invoice” (Q-EXC-1)");
    expect(text).toContain("Incoterm differs from the quote");
    expect(text).toContain("PO 1,840 vs quote 1,750 (+5.14%) = +9,000 on 100 · Q-EXC-1");
    expect(text).toContain("L2 EX-2: no quote covers this line");
    // The banner keeps its summary and controls, and points at the card.
    expect(container.textContent).toContain("Quote check: 0/2 matched");
    expect(container.textContent).toContain("4 items listed under Needs decision on the Reconcile tab.");
    expect(card(container).getAttribute("data-origin")).toBe("local");
  });

  it("renders the server's list when GET /api/orders/exceptions answers", async () => {
    const o = base();
    const exceptions = vi.fn(async () => ({
      version: 1, order_id: o.id, status: "DRAFT", clean: false,
      rows: [{
        key: "customer_gstin_conflict|customer:cust-1", type: "customer_gstin_conflict", source: "customer", sources: ["customer"],
        severity: "high", blocks: null, shadow: false, status: "open", title: "GSTIN on the PO differs from the customer master",
        detail: "PO 27X vs master 29X", payload: {}, action: { tab: "recon", control: "customer_card", label: "Customer card" },
        resolution_options: [], agent_policy: "human_only",
      }],
      info: [], decided: [], counts: { open: 1, info: 0, decided: 0, blocking: 0, by_severity: {} },
    }));
    const { container } = await mount(o, { orders: { exceptions } });
    await waitFor(() => expect(card(container).getAttribute("data-origin")).toBe("server"));
    expect(exceptions).toHaveBeenCalledWith(o.id, { includeShadow: false });
    expect(card(container).textContent).toContain("GSTIN on the PO differs from the customer master");
  });

  it("Anomaly check not run: its link runs the existing run-validation endpoint", async () => {
    const o = base({ preflight_payload: { source_document_id: "doc-1" } });
    const compute = vi.fn(async (..._args: any[]) => ({ flags: [] }));
    const { container, getByText } = await mount(o, { rest: { anomaly: { compute } } });
    expect(card(container).textContent).toContain("Anomaly check not run");
    await act(async () => { fireEvent.click(getByText("Run anomaly check")); });
    await waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    expect(compute.mock.calls[0][0]).toBe("cust-1");
  });

  it("a line row's link selects that line in the grid", async () => {
    const { container, getByText } = await mount(messy());
    await act(async () => { fireEvent.click(getByText("Map to canonical on line 2 in the line grid")); });
    await waitFor(() => expect(container.querySelectorAll("tr.recon-row")[1].classList.contains("is-active")).toBe(true));
  });
});
