// The "Review and decide" layout of the SO workspace (plan PR 12): the
// summary strip, the exceptions list beside the PO, a line grid that closes
// when no line needs a look, the More menu, the next-step bar that names its
// blockers, every old tab still reachable by deep link, and the Mode B
// labels. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-review-1";
const base = (over: any = {}) => ({
  id: ORDER_ID, status: "DRAFT", po_number: "PO-REV-1", po_date: "2026-10-01", customer_id: "cust-1",
  customer: { customer_name: "Review Buyer", contact_email: "buyer@example.test" },
  preflight_payload: { source_document_id: "doc-1", last_validated_at: "2026-10-10T00:00:00Z" },
  documents: [{ id: "doc-1" }], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  result: {
    salesOrder: {
      grandTotal: 1500,
      customer: { name: "Review Buyer", delivery_date: "2026-11-30" },
      lineItems: [
        { partNumber: "RV-1", description: "Part one", qty: 10, rate: 100, uom: "NOS", _match: { verdict: "matched", part_no: "RV-1" } },
        { partNumber: "RV-2", description: "Part two", qty: 5, rate: 100, uom: "NOS", _match: { verdict: "matched", part_no: "RV-2" } },
      ],
    },
    quoteReconciliation: { summary: { total: 2, matched: 2 }, flags: [], quoted_not_ordered: [] },
  },
  ...over,
});

const termsBlocked = {
  order_id: ORDER_ID, mode: "on", shadow: false, visible: true,
  check: { id: "chk-1", po_terms_status: "read", po_source: "terms_pass", clause_count: 1 },
  flags: [{
    id: "fl-1", clause: "ld_penalty", clause_label: "Liquidated damages", outcome: "po_only", severity: "critical", state: "undecided",
    po: { text: "LD at 2% per week, no cap." }, quote: null, allowed: ["request_amendment", "reject_term"], decisions: [],
  }],
  counts: { total: 1, undecided: 1, amendment_requested: 0, decided: 0 },
};

let update: any;
const mount = async (o: any, extra: any = {}) => {
  window.location.hash = extra.hash || "#/so?id=" + o.id;
  update = vi.fn(async () => ({}));
  installBackend({
    orders: {
      get: vi.fn(async () => ({ order: o })), update,
      terms: vi.fn(async () => extra.terms || { mode: "off", visible: false, flags: [] }),
      soPdfBlob: extra.soPdfBlob || vi.fn(async () => new Blob(["%PDF"])),
    },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
    docai: { soProcessingMode: vi.fn(async () => extra.mode || { mode: "A" }), getRun: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  const view = renderScreen(mod.default);
  await waitFor(() => expect(view.container.querySelector("[data-testid='so-summary-strip']") || view.container.querySelector("[role='tab'][aria-selected='true']")).toBeTruthy());
  return view;
};

const nextBtn = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-testid='so-next-step-bar'] button")].find((b) => (b.textContent || "").includes("Send for approval")) as HTMLButtonElement | undefined;

beforeEach(() => {
  installRbac("sales_engineer");
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
  (window as any).URL.createObjectURL = vi.fn(() => "blob:x");
  (window as any).URL.revokeObjectURL = vi.fn();
});

describe("a clean order", () => {
  it("closes the line grid, says Nothing needs a decision, and enables Send for approval", async () => {
    const { container } = await mount(base());
    await waitFor(() => expect(nextBtn(container)).toBeTruthy());
    expect((container.querySelector("[data-testid='lines-details']") as HTMLDetailsElement).open).toBe(false);
    expect(container.querySelector("[data-testid='lines-details'] summary")!.textContent).toBe("Lines (2) · nothing to decide on the lines");
    expect(container.querySelector("[data-testid='order-exceptions']")!.textContent).toContain("Nothing needs a decision");
    expect(nextBtn(container)!.disabled).toBe(false);
    // The tab is the review view.
    expect(container.querySelector("[role='tab'][aria-selected='true']")!.textContent).toBe("Review and decide");
  });

  it("sends with one click, the existing transition, and an optional note", async () => {
    const { container } = await mount(base());
    await waitFor(() => expect(nextBtn(container)?.disabled).toBe(false));
    const note = container.querySelector("input[aria-label='Note to the approver (optional)']") as HTMLInputElement;
    await act(async () => { fireEvent.change(note, { target: { value: "Customer confirmed rates by phone." } }); });
    await act(async () => { fireEvent.click(nextBtn(container)!); });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const [id, patch] = update.mock.calls[0];
    expect(id).toBe(ORDER_ID);
    expect(patch.status).toBe("PENDING_REVIEW");
    expect(patch.preflight_payload).toMatchObject({ submit_note: "Customer confirmed rates by phone.", source_document_id: "doc-1", last_validated_at: "2026-10-10T00:00:00Z" });
  });

  it("without a note sends only the status, as before", async () => {
    const { container } = await mount(base());
    await waitFor(() => expect(nextBtn(container)?.disabled).toBe(false));
    await act(async () => { fireEvent.click(nextBtn(container)!); });
    await waitFor(() => expect(update).toHaveBeenCalledWith(ORDER_ID, { status: "PENDING_REVIEW" }));
  });

  it("shows the summary strip: customer and basis, PO, value, lines, delivery and its source, mode", async () => {
    const { container } = await mount(base());
    const strip = container.querySelector("[data-testid='so-summary-strip']")!;
    await waitFor(() => expect(strip.textContent).toContain("Mode A (Anvil pushes)"));
    const text = strip.textContent || "";
    expect(text).toContain("CustomerReview Buyer");
    expect(text).toContain("POPO-REV-1dated 01-Oct-26");
    expect(text).toContain("Value₹1,500.00");
    expect(text).toContain("Lines2");
    expect(text).toContain("Delivery30-Nov-26 · from the PO header");
  });
});

describe("a blocked order", () => {
  it("names the blocker and keeps Send disabled", async () => {
    const { container } = await mount(base(), { terms: termsBlocked });
    await waitFor(() => expect(container.querySelector("[data-testid='next-step-blockers']")).toBeTruthy());
    expect(container.querySelector("[data-testid='next-step-blockers']")!.textContent).toBe("Blocked by: Liquidated damages: only the PO states it");
    expect(nextBtn(container)!.disabled).toBe(true);
  });

  it("opens the line grid when a line needs a look", async () => {
    const o = base();
    o.result.salesOrder.lineItems[1]._match = { verdict: "unmatched", part_no: "RV-2" };
    o.result.quoteReconciliation.flags = [{ part_no: "RV-2", verdict: "unmatched" }];
    const { container } = await mount(o);
    await waitFor(() => expect((container.querySelector("[data-testid='lines-details']") as HTMLDetailsElement).open).toBe(true));
    expect(container.querySelector("[data-testid='lines-details'] summary")!.textContent).toBe("Lines (2) · 1 line needs a look");
  });
});

describe("every old tab is still reachable by deep link", () => {
  const TABS: Array<[string, string]> = [
    ["recon", "Review and decide"], ["review", "Review and decide"], ["header", "Header fields"], ["margin", "Margin cockpit"],
    ["why", "Why"], ["evidence", "Evidence"], ["quotes", "Quotes"], ["terms", "Terms"], ["approval", "Approval"],
    ["tally", "Tally"], ["threeway", "PO vs ERP"], ["invoice_check", "Invoice vs PO"], ["schedule", "Schedule"],
    ["shipments", "Shipments"], ["activity", "Activity"], ["diagnostics", "Pipeline diag"],
  ];
  for (const [id, label] of TABS) {
    it("?tab=" + id + " opens " + label, async () => {
      const { container } = await mount(base(), { hash: "#/so?id=" + ORDER_ID + "&tab=" + id, terms: { ...termsBlocked, flags: [] } });
      await waitFor(() => {
        const active = container.querySelector("[role='tab'][aria-selected='true']");
        expect(active?.textContent?.replace(/\d+$/, "")).toBe(label);
      });
    });
  }
});

describe("the More menu", () => {
  it("holds the secondary actions, out of the header", async () => {
    const { container, getByRole } = await mount(base());
    // Not in the header any more.
    const header = container.querySelector(".ws-title")!;
    const headerButtons = [...header.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
    for (const gone of ["quote PDF", "Download SO", "Excel", "new invoice", "share link", "audit pack", "email customer", "send for review"]) {
      expect(headerButtons.some((t) => t.endsWith(gone))).toBe(false);
    }
    await act(async () => { fireEvent.click(getByRole("button", { name: "More actions" })); });
    const items = [...container.querySelectorAll("[role='menuitem']")].map((b) => (b.textContent || "").trim());
    expect(items).toEqual(["Email customer", "Quote PDF", "Download SO", "Excel", "New invoice", "Share link", "Audit pack"]);
  });

  it("each item runs its old action", async () => {
    const soPdfBlob = vi.fn(async () => new Blob(["%PDF"]));
    const { container, getByRole } = await mount(base(), { soPdfBlob });
    await act(async () => { fireEvent.click(getByRole("button", { name: "More actions" })); });
    const item = [...container.querySelectorAll("[role='menuitem']")].find((b) => (b.textContent || "").trim() === "Download SO") as HTMLButtonElement;
    await act(async () => { fireEvent.click(item); });
    await waitFor(() => expect(soPdfBlob).toHaveBeenCalledWith(ORDER_ID));
    // The menu closes after a pick.
    expect(container.querySelector("[role='menu']")).toBeNull();
  });

  it("offers the ERP voucher once the order is approved", async () => {
    installRbac("sales_manager");
    const { container, getByRole } = await mount(base({ status: "APPROVED" }));
    await act(async () => { fireEvent.click(getByRole("button", { name: "More actions" })); });
    const items = [...container.querySelectorAll("[role='menuitem']")].map((b) => (b.textContent || "").trim());
    expect(items).toContain("ERP voucher");
  });
});

describe("Mode B labels", () => {
  it("Mode B: the header shows the mode's state, not a push button, and the stepper ends in Tally by hand", async () => {
    const { container } = await mount(base({ status: "APPROVED" }), { mode: { mode: "B" } });
    await waitFor(() => expect(container.querySelector("[data-testid='mode-b-state']")).toBeTruthy());
    expect(container.querySelector("[data-testid='mode-b-state']")!.textContent).toBe("Mode B: entered in Tally by hand");
    const header = container.querySelector(".ws-title")!;
    expect([...header.querySelectorAll("button")].some((b) => (b.textContent || "").includes("push to Tally"))).toBe(false);
    const steps = [...container.querySelectorAll(".step")].map((s) => (s.textContent || "").replace(/^[✓\d]+/, ""));
    expect(steps[5]).toBe("Enter in Tally (Mode B)");
  });

  it("Mode A keeps the push button and the step", async () => {
    const { container } = await mount(base({ status: "APPROVED" }), { mode: { mode: "A" } });
    await waitFor(() => {
      const header = container.querySelector(".ws-title")!;
      expect([...header.querySelectorAll("button")].some((b) => (b.textContent || "").includes("push to Tally"))).toBe(true);
    });
    expect(container.querySelector("[data-testid='mode-b-state']")).toBeNull();
    const steps = [...container.querySelectorAll(".step")].map((s) => (s.textContent || "").replace(/^[✓\d]+/, ""));
    expect(steps[5]).toBe("Push to Tally");
  });
});

describe("the Approval tab", () => {
  it("shows the engineer's note", async () => {
    const { container } = await mount(base({ status: "PENDING_REVIEW", preflight_payload: { submit_note: "Rates agreed on the 3rd." } }), { hash: "#/so?id=" + ORDER_ID + "&tab=approval" });
    await waitFor(() => expect(container.querySelector("[data-testid='submit-note']")).toBeTruthy());
    expect(container.querySelector("[data-testid='submit-note']")!.textContent).toBe("Note from the engineer: Rates agreed on the 3rd.");
  });
});
