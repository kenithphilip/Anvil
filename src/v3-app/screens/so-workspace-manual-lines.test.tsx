// Manual line entry (P2).
//
// Extraction misses lines. On a live PO, LlamaParse handed back a shredded
// table and produced 6 of 45; before this there was no way to type the missing
// ones in — the only route was re-running and hoping.
//
// Two properties matter beyond "a row appears":
//
//   1. An added line is MARKED. A hand-typed line that looks identical to an
//      extracted one lets an order claim the document said something it did
//      not. `_origin` drives both the chip and, later, whether the line may be
//      invoiced at all.
//   2. Nothing persists until Save. Add and remove mutate the draft only, so
//      the existing approval-invalidation and payload-hash rails on the PATCH
//      still apply exactly once, when the operator commits.

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

const LINES = [
  { customerItemCode: "A12060OBAR010003", description: "SHANK 90-2", quantity: 1, unitPrice: 1000.8 },
  { customerItemCode: "A44146OBAR010001", description: "SHANK 95-2", quantity: 1, unitPrice: 963.9 },
];

const order = (lineItems: any[] = LINES) => ({
  id: "ord-manual-1",
  status: "DRAFT",
  po_number: "0066026562",
  customer_id: "cust-1",
  customer_name: "Fixture Customer",
  result: { salesOrder: { lineItems } },
  preflight_payload: { source_document_id: "doc-1", extraction_run_id: "run-1" },
  documents: [{ id: "doc-1" }],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const openWorkspace = async (o = order()) => {
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

const btn = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === label);

const rowCount = (c: HTMLElement) => c.querySelectorAll("tr.recon-row").length;

describe("adding a line", () => {
  it("puts a new empty row in the grid", async () => {
    const { container } = await openWorkspace();
    const before = rowCount(container);
    btn(container, "+ Add line")!.click();
    await waitFor(() => { expect(rowCount(container)).toBe(before + 1); });
  });

  it("marks it so it cannot be mistaken for extracted data", async () => {
    const { container } = await openWorkspace();
    btn(container, "+ Add line")!.click();
    await waitFor(() => { expect(container.innerHTML).toContain("added"); });
  });

  it("does NOT persist until Save", async () => {
    // The PATCH carries approval invalidation and the payload-hash restamp;
    // firing it per keystroke would churn both.
    const { container, update } = await openWorkspace();
    btn(container, "+ Add line")!.click();
    await waitFor(() => { expect(container.innerHTML).toContain("Save line edits"); });
    expect(update).not.toHaveBeenCalled();
  });

  it("persists the line with its origin when Save is pressed", async () => {
    const { container, update } = await openWorkspace();
    btn(container, "+ Add line")!.click();
    await waitFor(() => { expect(btn(container, "Save line edits")).toBeTruthy(); });
    btn(container, "Save line edits")!.click();
    await waitFor(() => { expect(update).toHaveBeenCalled(); });

    const patch: any = update.mock.calls.map((c: any[]) => c[1]).find((p: any) => p?.result?.salesOrder?.lineItems);
    const written = patch.result.salesOrder.lineItems;
    expect(written).toHaveLength(LINES.length + 1);
    expect(written[written.length - 1]._origin).toBe("operator_recovered");
    expect(written[written.length - 1]._added_at).toBeTruthy();
  });

  it("leaves the extracted lines untouched", async () => {
    const { container, update } = await openWorkspace();
    btn(container, "+ Add line")!.click();
    await waitFor(() => { expect(btn(container, "Save line edits")).toBeTruthy(); });
    btn(container, "Save line edits")!.click();
    await waitFor(() => { expect(update).toHaveBeenCalled(); });
    const patch: any = update.mock.calls.map((c: any[]) => c[1]).find((p: any) => p?.result?.salesOrder?.lineItems);
    expect(patch.result.salesOrder.lineItems.slice(0, 2)).toEqual(LINES);
  });
});

describe("removing a line", () => {
  it("drops the row from the grid", async () => {
    const { container } = await openWorkspace();
    const before = rowCount(container);
    const remove = container.querySelector('button[aria-label="Remove line 1"]') as HTMLButtonElement;
    expect(remove).toBeTruthy();
    remove.click();
    await waitFor(() => { expect(rowCount(container)).toBe(before - 1); });
  });

  it("removes the RIGHT line", async () => {
    const { container, update } = await openWorkspace();
    (container.querySelector('button[aria-label="Remove line 1"]') as HTMLButtonElement).click();
    await waitFor(() => { expect(btn(container, "Save line edits")).toBeTruthy(); });
    btn(container, "Save line edits")!.click();
    await waitFor(() => { expect(update).toHaveBeenCalled(); });
    const patch: any = update.mock.calls.map((c: any[]) => c[1]).find((p: any) => p?.result?.salesOrder?.lineItems);
    expect(patch.result.salesOrder.lineItems).toEqual([LINES[1]]);
  });

  it("does not persist until Save", async () => {
    const { container, update } = await openWorkspace();
    (container.querySelector('button[aria-label="Remove line 1"]') as HTMLButtonElement).click();
    await waitFor(() => { expect(btn(container, "Save line edits")).toBeTruthy(); });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("read-only orders", () => {
  it("offers neither control once the order is no longer editable", async () => {
    // canEditLines is false outside DRAFT/PENDING_REVIEW; an approved order
    // must be reopened rather than edited in place.
    const { container } = await openWorkspace(order() as any);
    // Sanity: the control exists on a DRAFT.
    expect(btn(container, "+ Add line")).toBeTruthy();

    const approved = { ...order(), status: "EXPORTED_TO_TALLY" };
    const { container: c2 } = await openWorkspace(approved as any);
    expect(btn(c2, "+ Add line")).toBeFalsy();
    expect(c2.querySelector('button[aria-label="Remove line 1"]')).toBeFalsy();
  });
});

describe("the legend", () => {
  it("explains what an added line means", async () => {
    const { container } = await openWorkspace();
    expect(container.innerHTML).toContain("typed in, not extracted");
  });
});
