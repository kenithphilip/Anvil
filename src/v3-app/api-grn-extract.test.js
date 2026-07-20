// GRN/SRN extraction lib: pure normalization + extractGrn (callAnthropic mocked).

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ resp: null, captured: null }));
vi.mock("../api/_lib/anthropic.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callAnthropic: vi.fn(async (a) => { H.captured = a; return H.resp; }) };
});

const { normalizeGrnOutput, toIsoDate, extractGrn, GRN_TOOL } = await import("../api/_lib/grn-extract.js");

const toolResp = (input) => ({
  ok: true, status: 200,
  data: { content: [{ type: "tool_use", name: GRN_TOOL.name, input }] },
});

beforeEach(() => { H.resp = null; H.captured = null; });

describe("toIsoDate", () => {
  it("keeps ISO, converts day-first, rejects garbage", () => {
    expect(toIsoDate("2026-07-20")).toBe("2026-07-20");
    expect(toIsoDate("20/07/2026")).toBe("2026-07-20");
    expect(toIsoDate("20-07-2026")).toBe("2026-07-20");
    expect(toIsoDate("received last tuesday")).toBeNull();
    expect(toIsoDate(null)).toBeNull();
  });
});

describe("normalizeGrnOutput", () => {
  it("maps tool output to the receipt shape + sums line quantities", () => {
    const r = normalizeGrnOutput({
      receipt_type: "GRN", receipt_number: "GRN-9001", receipt_date: "20/07/2026",
      po_number: "PO-7777", invoice_number: "INV-42", confidence: 0.9,
      items: [
        { part_no: "WG-100", received_qty: 8, short_qty: 2, rejected_qty: 0 },
        { part_no: "TIP-9", received_qty: 50, short_qty: 0, rejected_qty: 1 },
      ],
    });
    expect(r.receipt_type).toBe("GRN");
    expect(r.receipt_number).toBe("GRN-9001");
    expect(r.receipt_date).toBe("2026-07-20");
    expect(r.po_number).toBe("PO-7777");
    expect(r.invoice_number).toBe("INV-42");
    expect(r.posted_qty).toBe(58);
    expect(r.short_qty).toBe(2);
    expect(r.rejected_qty).toBe(1);
    expect(r.confidence).toBe(0.9);
  });
  it("defaults type to GRN, honors SRN, nulls missing", () => {
    expect(normalizeGrnOutput({ receipt_type: "SRN" }).receipt_type).toBe("SRN");
    const r = normalizeGrnOutput({});
    expect(r.receipt_type).toBe("GRN");
    expect(r.receipt_number).toBeNull();
    expect(r.posted_qty).toBeNull();
  });
});

describe("extractGrn", () => {
  const settings = { tenant_id: "t-1" };
  it("requires a tenant + a source", async () => {
    expect((await extractGrn({ text: "x" })).reason).toBe("no_tenant");
    expect((await extractGrn({ settings })).reason).toBe("no_source");
  });
  it("extracts a GRN from text via the forced tool", async () => {
    H.resp = toolResp({ receipt_type: "GRN", receipt_number: "GRN-1", receipt_date: "2026-07-20", invoice_number: "INV-9", confidence: 0.8, items: [{ received_qty: 5 }] });
    const r = await extractGrn({ text: "Goods Receipt Note GRN-1 ...", settings });
    expect(r.ok).toBe(true);
    expect(r.receipt.receipt_number).toBe("GRN-1");
    expect(r.receipt.invoice_number).toBe("INV-9");
    expect(r.receipt.posted_qty).toBe(5);
    // forced the GRN tool + carried the doc text.
    expect(H.captured.tools[0].name).toBe("extract_goods_receipt");
    expect(H.captured.tool_choice).toEqual({ type: "tool", name: "extract_goods_receipt" });
  });
  it("surfaces an upstream failure", async () => {
    H.resp = { ok: false, status: 503, error: "anthropic down" };
    const r = await extractGrn({ text: "x", settings });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("upstream_error");
  });
});
