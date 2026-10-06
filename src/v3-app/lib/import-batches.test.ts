// Splitting a workbook upload across requests.
//
// Measured on the real pair of workbooks:
//
//   Daily Shipment Reports    ->  1,164 shipment rows, 0.54 MB   (fits)
//   In Transit Items Details  -> 35,468 line rows,     6.24 MB   (does not)
//
// against MAX_BODY_BYTES = 1 MB. Pre-normalizing the rows saves 5% — the rows
// ARE the payload — so the upload has to be split.
//
// The client used to hide this by filtering lines to the invoices in the same
// upload's summary sheet. That kept the body under the cap by accident and made
// a lines-only upload send ZERO rows, which is the workflow the server was
// fixed to support. Both defects are covered here.

import { describe, it, expect } from "vitest";
import { batchByBytes, planImportRequests, mergeSummaries, LINE_BATCH_BYTES } from "./import-batches";

const line = (i: number) => ({
  shipper_invoice_no: `INV-${String(i).padStart(5, "0")}`,
  part_no: `TNA-16-04-40-${i}`,
  description: "hex socket head cap screw",
  qty: 12,
  receipt_date: "2026-08-07",
  source_country: "JP",
});
const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

describe("batchByBytes", () => {
  it("keeps every batch under the cap", () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => line(i));
    for (const b of batchByBytes(rows, 100 * 1024)) {
      expect(bytesOf(b)).toBeLessThanOrEqual(100 * 1024);
    }
  });

  it("loses no rows and preserves order", () => {
    const rows = Array.from({ length: 1_000 }, (_, i) => line(i));
    const flat = batchByBytes(rows, 20 * 1024).flat();
    expect(flat).toHaveLength(rows.length);
    expect(flat.map((r: any) => r.part_no)).toEqual(rows.map((r) => r.part_no));
  });

  it("measures bytes, not characters", () => {
    // A Japanese supplier name is 3 bytes per character. Counting characters
    // would under-measure by 3x and blow a cap expressed in bytes.
    const wide = [{ description: "日本製ネジ".repeat(40) }];
    const [only] = batchByBytes(wide, 10_000);
    expect(only).toHaveLength(1);
    expect(bytesOf(wide)).toBeGreaterThan(JSON.stringify(wide).length);
  });

  it("gives an oversized single row its own batch rather than dropping it", () => {
    // Silently discarding it would be the exact failure mode this file exists
    // to end. Let the server reject it loudly instead.
    const rows = [line(1), { description: "x".repeat(50_000) }, line(2)];
    const out = batchByBytes(rows, 1_000);
    expect(out.flat()).toHaveLength(3);
    expect(out.some((b) => b.length === 1 && bytesOf(b) > 1_000)).toBe(true);
  });

  it.each([[[]], [null], [undefined]])("returns no batches for %p", (v) => {
    expect(batchByBytes(v as any)).toEqual([]);
  });
});

describe("planImportRequests", () => {
  const pending = Array.from({ length: 1_164 }, (_, i) => ({
    shipper_invoice_no: `INV-${String(i).padStart(5, "0")}`,
    supplier: "supplier name",
    status: "IN_TRANSIT",
  }));
  const lines = Array.from({ length: 35_468 }, (_, i) => line(i % 1_600));

  it("splits the real workbook into requests that each fit the cap", () => {
    const reqs = planImportRequests("apply", pending, lines);
    expect(reqs.length).toBeGreaterThan(1);
    for (const r of reqs) expect(bytesOf(r)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("sends every parsed line row — none are filtered away", () => {
    const reqs = planImportRequests("apply", pending, lines);
    expect(reqs.reduce((n, r) => n + r.lines.length, 0)).toBe(lines.length);
  });

  it("puts the shipment rows in the first request and nowhere else", () => {
    // Load-bearing on apply: lines attach to shipments the first request created.
    const reqs = planImportRequests("apply", pending, lines);
    expect(reqs[0].pending).toHaveLength(pending.length);
    for (const r of reqs.slice(1)) expect(r.pending).toHaveLength(0);
  });

  // The bug: uploading the In Transit workbook by itself sent nothing at all.
  it("sends the lines when there is no summary sheet in the upload", () => {
    const reqs = planImportRequests("apply", [], lines);
    expect(reqs.reduce((n, r) => n + r.lines.length, 0)).toBe(lines.length);
    expect(reqs[0].pending).toEqual([]);
  });

  it("declares this upload's invoices on every request", () => {
    // Without it, a later batch's lines look like orphans on a preview, because
    // their shipments exist only in the first request and nothing is written yet.
    const reqs = planImportRequests("preview", pending, lines);
    for (const r of reqs) {
      expect(r.known_invoices).toHaveLength(1_164);
      expect(r.known_invoices).toContain("INV-00000");
    }
  });

  it("carries the mode onto every request", () => {
    for (const r of planImportRequests("preview", pending, lines)) expect(r.mode).toBe("preview");
  });

  it("is a single request when the whole upload fits", () => {
    const reqs = planImportRequests("apply", pending.slice(0, 5), lines.slice(0, 5));
    expect(reqs).toHaveLength(1);
    expect(reqs[0].lines).toHaveLength(5);
  });

  it("still emits one request when there is nothing to send", () => {
    // The server answers with its own 400; the client should not have to
    // special-case an empty plan.
    expect(planImportRequests("preview", [], [])).toHaveLength(1);
  });

  it("does not overfill the first request when the shipment rows are large", () => {
    // Pending alone can consume most of the budget; the first request must
    // account for its own weight before packing lines beside it.
    const fat = Array.from({ length: 400 }, (_, i) => ({
      shipper_invoice_no: `INV-${i}`,
      note: "y".repeat(2_000),
    }));
    const reqs = planImportRequests("apply", fat, lines);
    expect(bytesOf(reqs[0])).toBeLessThanOrEqual(1024 * 1024);
    expect(reqs.reduce((n, r) => n + r.lines.length, 0)).toBe(lines.length);
  });

  it("keeps batches under the cap even with the default budget", () => {
    for (const r of planImportRequests("apply", pending, lines, LINE_BATCH_BYTES)) {
      expect(bytesOf(r.lines)).toBeLessThanOrEqual(LINE_BATCH_BYTES);
    }
  });
});

describe("mergeSummaries", () => {
  const a = {
    pending_rows: 1_164, line_rows: 4_000, to_insert: 900, to_update: 264,
    linked_to_project: 700, unlinked: 464, line_receipts_matched: 100,
    shipment_lines_matched: 3_900, lines_without_part_no: 10, orphan_invoices: 2,
    orphan_invoice_sample: ["A", "B"], lines_matched_to_existing: 5,
    by_source_country: { JP: 3_000, CN: 1_000 }, sheets: [{ name: "Pending" }],
  };
  const b = {
    pending_rows: 0, line_rows: 3_000, to_insert: 0, to_update: 0,
    linked_to_project: 0, unlinked: 0, line_receipts_matched: 40,
    shipment_lines_matched: 2_950, lines_without_part_no: 5, orphan_invoices: 1,
    orphan_invoice_sample: ["C"], lines_matched_to_existing: 3,
    by_source_country: { CN: 500, KR: 2_500 },
  };

  it("adds the line-side counts across requests", () => {
    const m = mergeSummaries([a, b]);
    expect(m.line_rows).toBe(7_000);
    expect(m.shipment_lines_matched).toBe(6_850);
    expect(m.line_receipts_matched).toBe(140);
    expect(m.lines_without_part_no).toBe(15);
  });

  it("takes the shipment-side counts from the request that carried them", () => {
    // Summing would be right only by accident; the later requests report zero
    // because they have no pending rows, not because nothing was inserted.
    const m = mergeSummaries([a, b]);
    expect(m.pending_rows).toBe(1_164);
    expect(m.to_insert).toBe(900);
    expect(m.to_update).toBe(264);
    expect(m.unlinked).toBe(464);
  });

  it("merges the per-country breakdown", () => {
    expect(mergeSummaries([a, b]).by_source_country).toEqual({ JP: 3_000, CN: 1_500, KR: 2_500 });
  });

  it("unions the orphan sample so it is not one batch's view", () => {
    const m = mergeSummaries([a, b]);
    expect(m.orphan_invoices).toBe(3);
    expect(m.orphan_invoice_sample).toEqual(["A", "B", "C"]);
  });

  it("caps the orphan sample at ten", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      orphan_invoices: 3, orphan_invoice_sample: [`X${i}`, `Y${i}`, `Z${i}`],
    }));
    const m = mergeSummaries(many);
    expect(m.orphan_invoice_sample).toHaveLength(10);
    expect(m.orphan_invoices).toBe(24);   // the COUNT is not capped
  });

  it("keeps the sheet diagnostics from the first request", () => {
    expect(mergeSummaries([a, b]).sheets).toEqual([{ name: "Pending" }]);
  });

  it("adds the apply-mode counters", () => {
    const m = mergeSummaries([
      { inserted: 900, updated: 264, line_receipts_applied: 100, shipment_lines_applied: 3_900 },
      { inserted: 0, updated: 0, line_receipts_applied: 40, shipment_lines_applied: 2_950 },
    ]);
    expect(m.inserted).toBe(900);
    expect(m.shipment_lines_applied).toBe(6_850);
    expect(m.line_receipts_applied).toBe(140);
  });

  it("survives a single summary, and empty input", () => {
    expect(mergeSummaries([a]).line_rows).toBe(4_000);
    expect(mergeSummaries([])).toEqual({});
    expect(mergeSummaries([null, undefined] as any)).toEqual({});
  });
});
