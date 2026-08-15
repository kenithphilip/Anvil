// One click from a reported gap to a variance line.
//
// P3 reports every quoted part the customer's PO does not contain, with the
// agreed qty and price. Before this, an operator read that report and re-typed
// a part number and a rate into the grid by hand — the transcription this
// product exists to remove.
//
// The line that lands is deliberately NOT an ordinary one: the values come from
// the QUOTE, the customer has not ordered it, and the Tally push refuses it
// until they amend the PO.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

const ORDERED = [{ partNumber: "P-1", description: "ORDERED PART", quantity: 1, unitPrice: 100 }];

const GAPS = [
  { part_no: "TNA-16-04-40-2", description: "ACME STD ADAPTOR", qty: 5, unit_price: 1654.2,
    uom: "each", hsn: "8207", customer_part_number: "A44145ACME010004",
    source_quote_id: "q-1", source_quote_number: "Q-4471" },
  { part_no: "X-HD0420-3", description: "ACME FIXED HOLDER", qty: 2, unit_price: 63180,
    source_quote_number: "Q-4471" },
];

const order = (opts: { gaps?: any[]; lines?: any[]; status?: string } = {}) => ({
  id: "ord-var-1",
  status: opts.status || "DRAFT",
  po_number: "0066026562",
  customer_id: "cust-1",
  customer_name: "Fixture Customer",
  result: {
    salesOrder: { lineItems: opts.lines ?? ORDERED },
    quoteReconciliation: {
      as_of: new Date().toISOString(),
      summary: { total: 1, matched: 1, price_mismatch: 0, unmatched: 0, quoted_not_ordered: (opts.gaps ?? GAPS).length },
      quotes_used: [{ quote_id: "q-1", quote_number: "Q-4471", lines_matched: 1 }],
      quoted_not_ordered: opts.gaps ?? GAPS,
      flags: [],
    },
  },
  preflight_payload: { source_document_id: "doc-1", extraction_run_id: "run-1" },
  documents: [{ id: "doc-1" }],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const open = async (o: any = order()) => {
  const update = vi.fn(async (..._a: any[]) => ({}));
  window.location.hash = "#/so?id=" + o.id;
  installBackend({
    orders: { get: vi.fn(async () => ({ order: o })), update },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  const { container } = renderScreen(mod.default);
  await waitFor(() => { expect(container.innerHTML).toContain("Line reconciliation"); });
  return { container, update };
};

const addBtns = (c: HTMLElement) =>
  [...c.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "Add as variance");
const btn = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === label);

describe("the gap list", () => {
  it("says how many quoted lines the PO does not contain", async () => {
    const { container } = await open();
    expect(container.innerHTML).toContain("quoted line");
    expect(container.innerHTML).toContain("not on this PO");
  });

  it("states plainly that the customer has not ordered them", async () => {
    const { container } = await open();
    expect(container.innerHTML).toMatch(/has not ordered/);
  });

  it("offers one control per outstanding gap", async () => {
    const { container } = await open();
    expect(addBtns(container)).toHaveLength(2);
  });

  it("shows the agreed terms so the operator can sanity-check before clicking", async () => {
    const { container } = await open();
    expect(container.innerHTML).toContain("TNA-16-04-40-2");
    expect(container.innerHTML).toContain("Q-4471");
  });

  it("renders nothing when the PO ordered everything quoted", async () => {
    const { container } = await open(order({ gaps: [] }));
    expect(addBtns(container)).toHaveLength(0);
    expect(container.innerHTML).not.toContain("not on this PO");
  });

  it("stops offering a gap the order already carries", async () => {
    const { container } = await open(order({
      lines: [...ORDERED, { partNumber: "TNA-16-04-40-2", _origin: "quote_variance" }],
    }));
    expect(addBtns(container)).toHaveLength(1);
  });

  it("offers no control on a non-editable order", async () => {
    const { container } = await open(order({ status: "EXPORTED_TO_TALLY" }));
    expect(addBtns(container)).toHaveLength(0);
  });
});

describe("clicking through", () => {
  it("adds a line the grid marks as not-on-PO", async () => {
    const { container } = await open();
    addBtns(container)[0].click();
    await waitFor(() => { expect(container.innerHTML).toContain("not on PO"); });
  });

  it("persists it as quote_variance with the quote's terms", async () => {
    const { container, update } = await open();
    addBtns(container)[0].click();
    await waitFor(() => { expect(btn(container, "Save line edits")).toBeTruthy(); });
    btn(container, "Save line edits")!.click();
    await waitFor(() => { expect(update).toHaveBeenCalled(); });

    const patch: any = update.mock.calls.map((c: any[]) => c[1]).find((p: any) => p?.result?.salesOrder?.lineItems);
    const added = patch.result.salesOrder.lineItems.at(-1);
    expect(added._origin).toBe("quote_variance");
    expect(added.partNumber).toBe("TNA-16-04-40-2");
    expect(added.quantity).toBe(5);
    expect(added.unitPrice).toBe(1654.2);
    expect(added._variance_source.quote_number).toBe("Q-4471");
  });

  it("removes that gap from the list once added, so a second click cannot double-order", async () => {
    const { container } = await open();
    expect(addBtns(container)).toHaveLength(2);
    addBtns(container)[0].click();
    await waitFor(() => { expect(addBtns(container)).toHaveLength(1); });
  });

  it("leaves the ordered lines untouched", async () => {
    const { container, update } = await open();
    addBtns(container)[0].click();
    await waitFor(() => { expect(btn(container, "Save line edits")).toBeTruthy(); });
    btn(container, "Save line edits")!.click();
    await waitFor(() => { expect(update).toHaveBeenCalled(); });
    const patch: any = update.mock.calls.map((c: any[]) => c[1]).find((p: any) => p?.result?.salesOrder?.lineItems);
    expect(patch.result.salesOrder.lineItems[0]).toEqual(ORDERED[0]);
  });

  it("does not persist until Save", async () => {
    const { container, update } = await open();
    addBtns(container)[0].click();
    await waitFor(() => { expect(btn(container, "Save line edits")).toBeTruthy(); });
    expect(update).not.toHaveBeenCalled();
  });
});
