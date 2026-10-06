// The SO workspace reads the per-line purchase requisition (PR) number.
//
// Both PO adapters now extract lines[].requisition_no. A field the extractor
// fills and no screen reads is this repo's most repeated failure, so the
// reconciliation grid shows a "PR no." column whenever any line carries one,
// with the OCR marker intake stamps; a PO whose lines carry more than one PR
// gets a non-blocking notice naming which lines carry which; and the PO header
// panel shows the header-level value. Fixtures are tenant-neutral.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-pr-1";

const line = (part: string, pr: string | null, stamped: boolean, extra: Record<string, unknown> = {}) => ({
  partNumber: part,
  description: "Fixture item " + part,
  qty: 1,
  rate: 100,
  uom: "NOS",
  ...extra,
  ...(pr != null ? { requisition_no: pr } : {}),
  _field_sources: stamped
    ? { itemCode: "ocr", qty: "ocr", rate: "ocr", ...(pr != null ? { requisition_no: "ocr" } : {}) }
    : { itemCode: "ocr", qty: "ocr", rate: "ocr" },
});

const orderWith = (lineItems: any[], headerPr: string | null = null) => ({
  id: ORDER_ID,
  status: "PENDING_REVIEW",
  po_number: "PO-7001",
  customer_id: "cust-1",
  customer_name: "Fixture Buyer",
  result: {
    salesOrder: {
      customer: { name: "Fixture Buyer", ...(headerPr ? { requisition_no: headerPr } : {}) },
      lineItems,
    },
  },
  preflight_payload: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const mount = async (order: any) => {
  installBackend({
    orders: { get: vi.fn(async () => ({ order })), update: vi.fn(async () => ({})) },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  const r = renderScreen(mod.default);
  await waitFor(() => expect(r.container.innerHTML).toContain("Line reconciliation"));
  return r.container;
};

const reconTable = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("table")).find((t) =>
    Array.from(t.querySelectorAll("thead th")).some((th) => /^Item/.test((th.textContent || "").trim())),
  ) as HTMLTableElement;
const headers = (c: HTMLElement) =>
  Array.from(reconTable(c).querySelectorAll("thead th")).map((th) => (th.textContent || "").trim());
const prCells = (c: HTMLElement) =>
  Array.from(reconTable(c).querySelectorAll<HTMLElement>("tbody td[title^='Purchase requisition']"));
const notice = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[role='status']"))
    .find((el) => /requisition numbers/.test(el.textContent || "")) || null;
// The span of EVERY footer row, top to bottom: subtotal, auxiliary (only when a
// line carries aux amounts), grand total, amount in words.
const footerSpans = (c: HTMLElement) =>
  Array.from(reconTable(c).querySelectorAll("tfoot tr")).map((tr) =>
    Array.from(tr.children).reduce((n, td) => n + Number((td as HTMLTableCellElement).colSpan || 1), 0));
const footerLabels = (c: HTMLElement) =>
  Array.from(reconTable(c).querySelectorAll("tfoot tr")).map((tr) => (tr.textContent || "").trim().split(/\s+/)[0]);
// Tooling amount on the line, so the auxiliary footer row renders too.
const WITH_AUX = { tooling_amount: 5 };
const resetBtn = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("button")).find((b) => /reset column widths/.test(b.textContent || "")) || null;

beforeEach(() => {
  try { window.localStorage.removeItem("anvil.colw.so-recon"); } catch (_) { /* preference only */ }
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
  window.location.hash = "#/so?id=" + ORDER_ID;
});

describe("recon grid: PR no. column", () => {
  it("shows each line's PR with the OCR marker the line was stamped with", async () => {
    const c = await mount(orderWith([
      line("PN-1", "1000343964", true),
      line("PN-2", "1000343964", true),
      // Carries a value but no provenance for it: must render the value
      // without claiming it was read off the PO.
      line("PN-3", "1000344102", false),
    ]));
    expect(headers(c)).toContain("PR no.");
    // Directly after Item, where the identifiers are.
    expect(headers(c).indexOf("PR no.")).toBe(headers(c).findIndex((h) => /^Item/.test(h)) + 1);
    const cells = prCells(c);
    expect(cells).toHaveLength(3);
    expect(cells.map((td) => td.querySelector("span")?.textContent)).toEqual(["1000343964", "1000343964", "1000344102"]);
    const pill = (td: HTMLElement) => Array.from(td.querySelectorAll(".chip")).map((x) => x.textContent);
    expect(pill(cells[0])).toEqual(["OCR"]);
    expect(pill(cells[1])).toEqual(["OCR"]);
    expect(pill(cells[2])).toEqual([]);
  });

  it("leaves a line without a PR blank while the column is shown for the others", async () => {
    const c = await mount(orderWith([line("PN-1", "1000343964", true), line("PN-2", null, true)]));
    const cells = prCells(c);
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toContain("1000343964");
    expect(cells[1].textContent).toBe("");
  });

  it("keeps every footer row spanning the full width with the column added", async () => {
    const c = await mount(orderWith([line("PN-1", "1000343964", true, WITH_AUX)]));
    expect(headers(c)).toHaveLength(12);
    // All four rows rendered, the auxiliary one included ...
    expect(footerLabels(c)).toEqual(["subtotal", "auxiliary", "grand", "amount"]);
    // ... and each spans the twelve header columns.
    expect(footerSpans(c)).toEqual([12, 12, 12, 12]);
  });

  it("keeps the opened tax-breakdown row spanning the full width too", async () => {
    const c = await mount(orderWith([line("PN-1", "1000343964", true)]));
    const toggle = c.querySelector("button[aria-label='Show tax breakdown for line 1']") as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle);
    const brk = await waitFor(() => {
      const row = Array.from(reconTable(c).querySelectorAll("tbody tr"))
        .find((tr) => /Per-unit tax and auxiliary amounts/.test(tr.textContent || ""));
      expect(row).toBeTruthy();
      return row as HTMLTableRowElement;
    });
    const span = Array.from(brk.children).reduce((n, td) => n + Number((td as HTMLTableCellElement).colSpan || 1), 0);
    expect(span).toBe(12);
  });

  it("remembers a dragged PR no. column width like every other column", async () => {
    // Widths are stored per column id and filtered against the table's known
    // ids on load, so an id missing from that list silently forgets the drag.
    window.localStorage.setItem("anvil.colw.so-recon", JSON.stringify({ pr: 160 }));
    const c = await mount(orderWith([line("PN-1", "1000343964", true)]));
    const th = Array.from(reconTable(c).querySelectorAll<HTMLElement>("thead th"))
      .find((h) => (h.textContent || "").trim() === "PR no.")!;
    expect(th.style.width).toBe("160px");
    // A dragged column on screen makes the layout fixed and offers the reset.
    expect(reconTable(c).style.tableLayout).toBe("fixed");
    expect(resetBtn(c)).not.toBeNull();
  });

  it("ignores a stored PR no. width on a PO that has no PR column", async () => {
    // Dragged on a consolidated PO, then a normal PO is opened: the stored
    // width is for a column that is not on screen, so the grid keeps its
    // automatic layout and offers no reset.
    window.localStorage.setItem("anvil.colw.so-recon", JSON.stringify({ pr: 160 }));
    const c = await mount(orderWith([line("PN-1", null, true)]));
    expect(headers(c)).toHaveLength(11);
    expect(reconTable(c).style.tableLayout).toBe("auto");
    expect(resetBtn(c)).toBeNull();
  });

  it("has no PR column, and the original width on every footer row, when no line carries one", async () => {
    const c = await mount(orderWith([line("PN-1", null, true, WITH_AUX), line("PN-2", null, true)]));
    expect(headers(c)).not.toContain("PR no.");
    expect(headers(c)).toHaveLength(11);
    expect(footerLabels(c)).toEqual(["subtotal", "auxiliary", "grand", "amount"]);
    expect(footerSpans(c)).toEqual([11, 11, 11, 11]);
    expect(prCells(c)).toHaveLength(0);
  });

  it("shows the column for a value with no letter or digit in it, as the extractor returned it", async () => {
    const c = await mount(orderWith([line("PN-1", "*", true), line("PN-2", null, true)]));
    expect(headers(c)).toContain("PR no.");
    expect(prCells(c).map((td) => td.querySelector("span")?.textContent)).toEqual(["*", undefined]);
  });
});

describe("recon grid: more than one PR on a PO", () => {
  it("shows a notice naming each PR and the lines that carry it", async () => {
    const c = await mount(orderWith([
      line("PN-1", "1000343964", true),
      line("PN-2", "1000343964", true),
      line("PN-3", "1000344102", true),
    ]));
    const n = notice(c);
    expect(n).not.toBeNull();
    expect(n!.textContent).toBe(
      "This PO's lines carry 2 requisition numbers: 1000343964 (lines 1-2), 1000344102 (line 3).",
    );
  });

  it("is worked out from the operator's draft lines: removing a line renumbers it", async () => {
    const c = await mount(orderWith([
      line("PN-1", "1000343964", true),
      line("PN-2", "1000343964", true),
      line("PN-3", "1000344102", true),
    ]));
    expect(notice(c)!.textContent).toBe(
      "This PO's lines carry 2 requisition numbers: 1000343964 (lines 1-2), 1000344102 (line 3).",
    );
    const remove = c.querySelector("button[aria-label='Remove line 1']") as HTMLButtonElement;
    expect(remove).toBeTruthy();
    fireEvent.click(remove);
    await waitFor(() => expect(notice(c)!.textContent).toBe(
      "This PO's lines carry 2 requisition numbers: 1000343964 (line 1), 1000344102 (line 2).",
    ));
    // Remove the second PR's only line: one PR left, so no notice.
    fireEvent.click(c.querySelector("button[aria-label='Remove line 2']") as HTMLButtonElement);
    await waitFor(() => expect(prCells(c)).toHaveLength(1));
    expect(notice(c)).toBeNull();
  });

  it("shows no notice when every line carries the same PR, however it is spaced", async () => {
    const c = await mount(orderWith([
      line("PN-1", "1000343964", true),
      line("PN-2", "1000 343 964", true),
    ]));
    // The column is there (so the render reached the grid) but the lines agree.
    expect(headers(c)).toContain("PR no.");
    expect(notice(c)).toBeNull();
  });
});

describe("PO header panel", () => {
  it("shows the header-level PR number read-only", async () => {
    const c = await mount(orderWith([line("PN-1", null, true)], "1000343964"));
    const dts = Array.from(c.querySelectorAll("dl.kv dt"));
    const dt = dts.find((d) => d.textContent === "PR no.");
    expect(dt).toBeTruthy();
    expect(dt!.nextElementSibling?.textContent).toBe("1000343964");
    // Read-only: a value, not an input.
    expect(dt!.nextElementSibling?.querySelector("input")).toBeNull();
  });

  it("lists no PR row when the PO header prints none", async () => {
    const c = await mount(orderWith([line("PN-1", "1000343964", true)]));
    // The panel itself rendered (its Name row is there) ...
    expect(Array.from(c.querySelectorAll("dl.kv dt")).some((d) => d.textContent === "Name")).toBe(true);
    // ... without a header PR row.
    expect(Array.from(c.querySelectorAll("dl.kv dt")).some((d) => d.textContent === "PR no.")).toBe(false);
  });
});
