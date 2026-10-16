// so.write and so.admin, registered (they were registered nowhere, so canDo
// allowed every role). A viewer now sees the SO workspace's write controls
// disabled or hidden; a sales engineer can still write. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-rbac-1";
const makeOrder = () => ({
  id: ORDER_ID, status: "DRAFT", po_number: "PO-RBAC-1", customer_id: "cust-1",
  customer: { customer_name: "Rbac Buyer" },
  preflight_payload: { source_document_id: "doc-1", last_validated_at: "2026-10-10T00:00:00Z" },
  documents: [{ id: "doc-1" }],
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  result: {
    salesOrder: {
      grandTotal: 200,
      customer: { name: "Rbac Buyer" },
      lineItems: [{ partNumber: "RB-1", description: "Part", qty: 2, rate: 100, uom: "NOS", _match: { verdict: "matched", part_no: "RB-1" } }],
    },
    quoteReconciliation: { summary: { total: 1, matched: 1 }, flags: [], quoted_not_ordered: [] },
  },
});

let update: any;
const mount = async (role: string, tab = "recon", orders: Record<string, unknown> = {}) => {
  installRbac(role);
  window.location.hash = "#/so?id=" + ORDER_ID + "&tab=" + tab;
  update = vi.fn(async () => ({}));
  installBackend({
    orders: {
      get: vi.fn(async () => ({ order: makeOrder() })), update,
      terms: vi.fn(async () => ({ mode: "off", visible: false, flags: [] })),
      attachedQuotes: vi.fn(async () => ({ attached: [], other_quotes: [] })),
      ...orders,
    },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
    customers: { contacts: vi.fn(async () => ({ contacts: [] })) },
    docai: { soProcessingMode: vi.fn(async () => ({ mode: "A" })), getRun: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  const view = renderScreen(mod.default);
  await waitFor(() => expect(view.container.querySelector(".ws-title h1")).toBeTruthy());
  return view;
};

const button = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll("button")).find((b) => (b.textContent || "").trim().endsWith(text)) as HTMLButtonElement | undefined;
// The anomaly-rules button: "run validation", or "Re-run checks" once plan
// PR 8 (the server runs the rules) has renamed it.
const validationButton = (c: HTMLElement) => button(c, "run validation") || button(c, "Re-run checks");

beforeEach(() => {
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
});

describe("a viewer (no so.write)", () => {
  it("sees the order's write controls disabled or hidden", async () => {
    const { container } = await mount("viewer");
    await waitFor(() => expect(button(container, "run extraction")).toBeTruthy());
    expect(button(container, "run extraction")!.disabled).toBe(true);
    expect(validationButton(container)!.disabled).toBe(true);
    expect((container.querySelector("select[aria-label='extraction engine']") as HTMLSelectElement).disabled).toBe(true);
    // Send for approval names the missing permission.
    const next = button(container, "Send for approval")!;
    expect(next.disabled).toBe(true);
    expect(container.querySelector("[data-testid='next-step-blockers']")!.textContent).toContain("Needs the write permission");
    // Adding a line and attaching a quote are not offered.
    expect(button(container, "+ Add line")).toBeUndefined();
    await waitFor(() => expect(container.querySelector(".qs")!.textContent).toContain("Read only: attaching a quote needs write permission on sales orders."));
    expect(container.querySelector(".qs input[type='file']")).toBe(null);
  });

  it("cannot save the header fields", async () => {
    const { container } = await mount("viewer", "header");
    await waitFor(() => expect(button(container, "Save header")).toBeTruthy());
    expect(button(container, "Save header")!.disabled).toBe(true);
    expect(button(container, "Save header")!.getAttribute("title")).toBe("needs write permission on sales orders");
  });

  it("cannot add or delete schedule lines", async () => {
    const { container } = await mount("viewer", "schedule");
    await waitFor(() => expect(button(container, "bulk add")).toBeTruthy());
    expect(button(container, "bulk add")!.disabled).toBe(true);
    expect(button(container, "clear all")!.disabled).toBe(true);
  });
});

describe("finance (writer on the coarse verb, read-only on sales orders)", () => {
  it("sees the write controls disabled too", async () => {
    const { container } = await mount("finance");
    await waitFor(() => expect(button(container, "run extraction")).toBeTruthy());
    expect(button(container, "run extraction")!.disabled).toBe(true);
    expect(button(container, "Send for approval")!.disabled).toBe(true);
  });
});

describe("a sales engineer (so.write)", () => {
  it("can write: the controls are enabled and a line can be added", async () => {
    const { container } = await mount("sales_engineer");
    await waitFor(() => expect(button(container, "run extraction")).toBeTruthy());
    expect(button(container, "run extraction")!.disabled).toBe(false);
    expect(validationButton(container)!.disabled).toBe(false);
    expect(button(container, "Send for approval")!.disabled).toBe(false);
    expect(button(container, "+ Add line")).toBeTruthy();
    await waitFor(() => expect(container.querySelector(".qs input[type='file']")).toBeTruthy());
  });

  it("can save the header fields", async () => {
    const { container } = await mount("sales_engineer", "header");
    await waitFor(() => expect(button(container, "Save header")?.disabled).toBe(false));
    await act(async () => { fireEvent.click(button(container, "Save header")!); });
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0]).toBe(ORDER_ID);
  });

  it("can remove a duplicate quote; a viewer cannot", async () => {
    const quotes = {
      attached: [{ document_id: "qdoc-1", filename: "quote.pdf", ingested: true, quote: { id: "q-1", quote_number: "Q-RB-1", line_count: 1 } }],
      other_quotes: [],
    };
    const detail = { quote: { quote_number: "Q-RB-1", line_count: 1 }, lines: [], superseded_by: { document_id: "qdoc-2", basis: "same_number", certain: true } };
    for (const [role, offered] of [["sales_engineer", true], ["viewer", false]] as const) {
      const view = await mount(role, "quotes", {
        attachedQuotes: vi.fn(async () => quotes),
        attachedQuote: vi.fn(async () => detail),
      });
      await waitFor(() => expect(view.container.querySelector(".qp-head")?.textContent).toContain("Q-RB-1"));
      expect(!!button(view.container, "Remove duplicate…")).toBe(offered);
      view.unmount();
    }
  });

  it("still cannot delete schedule lines (so.admin is admin only)", async () => {
    const { container } = await mount("sales_engineer", "schedule");
    await waitFor(() => expect(button(container, "clear all")).toBeTruthy());
    expect(button(container, "clear all")!.getAttribute("title")).toBe("needs admin");
    expect(button(container, "bulk add")!.getAttribute("title")).toBe("");
  });
});
