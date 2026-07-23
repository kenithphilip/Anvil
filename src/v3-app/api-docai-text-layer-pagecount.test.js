// L1 text-layer page_count recovery.
//
// Some PDF generators (SAP / Ariba / GEP purchase orders) defeat unpdf
// entirely. Before this fix the failure path reported page_count: 0, which
// blinded the model selector — page_count is the only pre-extraction size
// signal it has (the po_multipage rule), so a 13-page 45-line PO looked like
// a 0-page doc, went to the cheap tier, and came back with a header and zero
// lines. A PDF whose TEXT is unreadable still has a parseable PAGE TREE, so
// the failure path now probes it structurally.
//
// The probe is mocked to mirror pdf-lib's real behaviour: a page count for
// PDF bytes, a throw for anything else (so a non-PDF can't report pages).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/docai/pdf-chunker.js", () => ({
  probePdfPageCount: vi.fn(async (b) => {
    if (!b || !b.length || b[0] !== 0x25) throw new Error("not a pdf");
    return 13;
  }),
}));

import { extractTextLayer } from "../api/_lib/docai/text_layer.js";
import { probePdfPageCount } from "../api/_lib/docai/pdf-chunker.js";

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

beforeEach(() => { probePdfPageCount.mockClear(); });

describe("text_layer / page_count survives a failed text extraction", () => {
  it("recovers the page count structurally when unpdf cannot read the text", async () => {
    // A PDF header with no usable body: unpdf fails, the page tree probe wins.
    const fakePdf = Buffer.concat([PDF_MAGIC, Buffer.from("\n%EOF")]);
    const out = await extractTextLayer({ bytes: fakePdf, mime: "application/pdf" });

    expect(out.status).toBe("extract_failed");
    expect(out.char_count).toBe(0);
    // The whole point: a failed TEXT extraction no longer means 0 pages.
    expect(out.page_count).toBe(13);
    expect(probePdfPageCount).toHaveBeenCalled();
  });

  it("does not invent a page count for non-PDF bytes", async () => {
    const out = await extractTextLayer({ bytes: Buffer.from("not a pdf"), mime: "text/plain" });
    expect(out.status).toBe("extract_failed");
    expect(out.error).toMatch(/not a pdf/i);
    expect(out.page_count).toBe(0);
  });

  it("returns 0 pages and never probes when there are no bytes", async () => {
    const out = await extractTextLayer({ bytes: null });
    expect(out.status).toBe("extract_failed");
    expect(out.page_count).toBe(0);
    expect(probePdfPageCount).not.toHaveBeenCalled();
  });

  it("stays fail-soft when the structural probe itself throws", async () => {
    probePdfPageCount.mockRejectedValueOnce(new Error("encrypted / corrupt"));
    const fakePdf = Buffer.concat([PDF_MAGIC, Buffer.from("\n%EOF")]);
    const out = await extractTextLayer({ bytes: fakePdf, mime: "application/pdf" });
    expect(out.status).toBe("extract_failed");
    expect(out.page_count).toBe(0);          // degraded, but no throw
  });
});
