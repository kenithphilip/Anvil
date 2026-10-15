// The delivery date in the SO workspace (plan PR 10): a "Due" column from
// lines[].delivery_date, the summary's one date with its source, and the
// Header fields tab offering the PO's date as a suggestion, never filling
// the committed date by itself. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const base = (lines: any[], customer: any = {}, over: any = {}) => ({
  id: "ord-due-1", status: "DRAFT", po_number: "PO-DUE-1", customer_id: "cust-1", customer_name: "Due Buyer",
  committed_delivery_date: null,
  preflight_payload: { last_validated_at: "2026-10-10T00:00:00Z" },
  documents: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  result: { salesOrder: { customer: { name: "Due Buyer", ...customer }, lineItems: lines } },
  ...over,
});

const mount = async (o: any) => {
  window.location.hash = "#/so?id=" + o.id;
  const update = vi.fn(async () => ({}));
  installBackend({
    orders: { get: vi.fn(async () => ({ order: o })), update },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  const view = renderScreen(mod.default);
  await waitFor(() => expect(view.container.innerHTML).toContain("Line reconciliation"));
  return { ...view, update };
};

beforeEach(() => {
  installRbac("sales_engineer");
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
});

describe("the Due column", () => {
  it("renders each line's PO date, and marks one that differs from the header", async () => {
    const { container } = await mount(base([
      { partNumber: "DU-1", qty: 1, rate: 10, delivery_date: "2026-11-30" },
      { partNumber: "DU-2", qty: 1, rate: 10, delivery_date: "2026-12-10" },
      { partNumber: "DU-3", qty: 1, rate: 10 },
    ], { delivery_date: "2026-11-30" }));
    const heads = [...container.querySelectorAll("thead th")].map((th) => (th.textContent || "").trim());
    expect(heads).toContain("Due");
    expect(heads.indexOf("Due")).toBe(heads.indexOf("Qty") + 1);
    expect(container.querySelector("[data-testid='due-0']")?.textContent).toBe("30-Nov-26");
    expect(container.querySelector("[data-testid='due-1']")?.textContent).toBe("10-Dec-26differs from header");
    expect(container.querySelector("[data-testid='due-2']")?.textContent).toBe("");
  });

  it("is not shown when no line prints a date", async () => {
    const { container } = await mount(base([{ partNumber: "DU-1", qty: 1, rate: 10 }]));
    const heads = [...container.querySelectorAll("thead th")].map((th) => (th.textContent || "").trim());
    expect(heads).not.toContain("Due");
  });
});

describe("the delivery date with its source", () => {
  it("the PO header's date, the PO's date and ours apart, and a suggestion", async () => {
    const { container } = await mount(base([{ partNumber: "DU-1", qty: 1, rate: 10 }], { delivery_date: "2026-11-30" }));
    const s = container.querySelector("[data-testid='delivery-date-summary']")!;
    expect(s.textContent).toContain("Delivery date30-Nov-26 (from the PO header)");
    expect(s.textContent).toContain("Committed by usnot set");
    expect(s.textContent).toContain("Suggested commitment30-Nov-26 (from the PO header, high confidence)");
  });

  it("committed by us, when the PO states no date", async () => {
    const { container } = await mount(base([{ partNumber: "DU-1", qty: 1, rate: 10 }], {}, { committed_delivery_date: "2026-12-05" }));
    expect(container.querySelector("[data-testid='delivery-date-summary']")!.textContent).toContain("Delivery date05-Dec-26 (committed by us)");
  });

  it("none, when nobody states one", async () => {
    const { container } = await mount(base([{ partNumber: "DU-1", qty: 1, rate: 10 }]));
    expect(container.querySelector("[data-testid='delivery-date-summary']")!.textContent).toContain("Delivery datenone");
  });
});

describe("the Header fields tab", () => {
  it("leaves the committed date blank, offers the PO's date, and fills it only on 'use'", async () => {
    const { container, getByRole, update } = await mount(base([{ partNumber: "DU-1", qty: 1, rate: 10 }], { delivery_date: "2026-11-30" }));
    await act(async () => { fireEvent.click(getByRole("tab", { name: /Header fields/ })); });
    const input = await waitFor(() => {
      const el = container.querySelector("input[aria-label='Committed delivery date']") as HTMLInputElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(input.value).toBe("");
    const hint = container.querySelector("[data-testid='committed-date-suggestion']")!;
    expect(hint.textContent).toContain("Suggested: 30-Nov-26 (from the PO header, high confidence)");
    await act(async () => { fireEvent.click([...hint.querySelectorAll("button")].find((b) => b.textContent === "use")!); });
    expect(input.value).toBe("2026-11-30");
    // Nothing is saved until the person saves.
    expect(update).not.toHaveBeenCalled();
  });
});
