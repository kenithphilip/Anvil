// Home's 4th and 5th KPIs by processing mode. In Mode B Anvil never pushes
// to Tally, so "Pushed today" and "Pushed MTD" always read 0. Mode B shows
// "Approved today" and "Approved MTD", from orders.approved_at. Mode A is
// unchanged. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";
import { completionKpis } from "./home";

const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0).toISOString();
// The 1st of this month, unless today is the 1st: then the 1st of last month.
const earlierThisMonth = now.getDate() > 1
  ? new Date(now.getFullYear(), now.getMonth(), 1, 9, 0, 0).toISOString()
  : null;
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 9, 0, 0).toISOString();

const so = (id: string, status: string, total: number, over: Record<string, unknown> = {}) => ({
  id, status, po_number: "PO-" + id, created_at: lastMonth, updated_at: lastMonth,
  result: { salesOrder: { grandTotal: total } }, ...over,
});

const ORDERS = [
  // Approved today, still approved (Mode B rests here): counts.
  so("a1", "APPROVED", 1000, { approved_at: today }),
  // Approved today, then exported: counts as approved.
  so("a2", "EXPORTED_TO_TALLY", 2000, { approved_at: today, updated_at: today }),
  // Approved earlier this month: MTD only.
  ...(earlierThisMonth ? [so("a3", "APPROVED", 4000, { approved_at: earlierThisMonth })] : []),
  // Approved last month: neither.
  so("a4", "APPROVED", 8000, { approved_at: lastMonth }),
  // Approved today, then returned for a fix: not approved now.
  so("a5", "DRAFT", 16000, { approved_at: today, updated_at: today }),
  // Approved today, then cancelled: not approved now.
  so("a6", "CANCELLED", 32000, { approved_at: today, updated_at: today }),
  // Pending review: not approved.
  so("a7", "PENDING_REVIEW", 64000, { updated_at: today }),
];

const kpi = (container: HTMLElement, label: string) => {
  const box = Array.from(container.querySelectorAll(".kpi")).find((k) => k.querySelector(".lbl")?.textContent === label);
  return box ? { v: box.querySelector(".v")?.textContent, d: box.querySelector(".d")?.textContent } : null;
};

const mount = async (mode: "A" | "B") => {
  installBackend({
    orders: { list: vi.fn(async () => ({ orders: ORDERS })) },
    audit: { list: vi.fn(async () => ({ events: [] })) },
    docai: { soProcessingMode: vi.fn(async () => ({ mode })) },
  });
  const mod = await import("./home");
  return renderScreen(mod.default);
};

beforeEach(() => { installRbac("sales_engineer"); });

describe("Home KPIs in Mode B", () => {
  it("shows Approved today and Approved MTD from approval data", async () => {
    const { container } = await mount("B");
    await waitFor(() => expect(kpi(container, "Approved today")).toBeTruthy());
    expect(kpi(container, "Pushed today")).toBe(null);
    expect(kpi(container, "Approved today")!.d).toBe("2 SOs");
    expect(kpi(container, "Approved MTD")!.d).toBe((earlierThisMonth ? 3 : 2) + " SOs this month");
  });
});

describe("Home KPIs in Mode A", () => {
  it("still shows Pushed today and Pushed MTD", async () => {
    const { container } = await mount("A");
    await waitFor(() => expect(kpi(container, "Pushed today")).toBeTruthy());
    expect(kpi(container, "Approved today")).toBe(null);
    // Only a2 is pushed (exported), and it moved today.
    expect(kpi(container, "Pushed today")!.d).toBe("1 SOs");
  });
});

describe("completionKpis", () => {
  it("counts and sums approved orders by approved_at in Mode B", () => {
    const k = completionKpis(ORDERS, "B", now);
    expect(k.verb).toBe("Approved");
    expect(k.today).toEqual({ count: 2, value: 3000 });
    expect(k.mtd).toEqual(earlierThisMonth ? { count: 3, value: 7000 } : { count: 2, value: 3000 });
  });

  it("counts pushed orders by updated_at in Mode A, and before the mode is read", () => {
    for (const mode of ["A", null] as const) {
      const k = completionKpis(ORDERS, mode, now);
      expect(k.verb).toBe("Pushed");
      expect(k.today).toEqual({ count: 1, value: 2000 });
    }
  });
});
