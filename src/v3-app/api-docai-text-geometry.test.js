// @vitest-environment node
//
// Runs in node, not the project-default jsdom: unpdf/pdf.js needs real Node
// binary + module APIs, and under jsdom it fails to parse at all (which is why
// the pre-existing text-layer tests only ever covered the fail-soft paths and
// never caught the Buffer defect below).
//
// Evidence-highlight geometry: the three defects that made the hover/click
// overlay dead on every document.
//
//   1. unpdf rejects a Node Buffer, and `bytes instanceof Uint8Array` is TRUE
//      for a Buffer — so L1 returned extract_failed on effectively every PDF.
//   2. bbox_norm was read but never computed anywhere, and the UI drops any
//      evidence lacking it — so even OCR'd documents highlighted nothing.
//   3. Evidence was stamped only when an OCR layer existed, but OCR runs only
//      when L1 FAILED — so a healthy digital PO produced no geometry at all.
//
// A real PDF is built with pdf-lib (already a dependency) so these exercise the
// actual unpdf/pdf.js path rather than a mock of it.

import { describe, it, expect, beforeAll } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractTextLayer, extractTextBlocks } from "../api/_lib/docai/text_layer.js";
import { normaliseBbox, buildBlockIndex, stampEvidenceOnLines } from "../api/_lib/docai/bbox-evidence.js";

let pdfBuffer;   // a Node Buffer, matching what the storage download hands us

beforeAll(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  // Enough body text to clear USABLE_TEXT_THRESHOLD (200 chars), otherwise
  // classify() calls the page image_only and the layer never reports has_text.
  page.drawText("MAHINDRA & MAHINDRA LTD - PURCHASE ORDER 0066026562", { x: 40, y: 740, size: 12, font });
  page.drawText("OBARA STD SHANK TWS-092-90-2", { x: 40, y: 700, size: 12, font });
  page.drawText("OBARA FIXED HOLDER X-TB0029-3", { x: 40, y: 660, size: 12, font });
  page.drawText("Need By Date 3/31/2026   Qty 1.00 each   Unit Price 1,000.80", { x: 40, y: 620, size: 12, font });
  page.drawText("Payment Terms D004-30 days from date of receipt", { x: 40, y: 580, size: 12, font });
  const page2 = doc.addPage([612, 792]);
  page2.drawText("OBARA POINT HOLDER X-PH0004", { x: 40, y: 500, size: 12, font });
  page2.drawText("Sub Total 1,546,831.80   Grand Total 1,825,261.52", { x: 40, y: 460, size: 12, font });
  pdfBuffer = Buffer.from(await doc.save());
});

describe("normaliseBbox", () => {
  it("normalises absolute page coordinates to 0..1", () => {
    expect(normaliseBbox([61.2, 79.2, 306, 396], 612, 792)).toEqual([0.1, 0.1, 0.5, 0.5]);
  });

  it("passes through a box already in the unit square (no double-division)", () => {
    expect(normaliseBbox([0.1, 0.2, 0.3, 0.4], 612, 792)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("orders inverted corners and clamps overflow", () => {
    const out = normaliseBbox([306, 396, 61.2, 79.2], 612, 792);
    expect(out).toEqual([0.1, 0.1, 0.5, 0.5]);
    expect(normaliseBbox([0, 0, 1224, 1584], 612, 792)).toEqual([0, 0, 1, 1]);
  });

  it("returns null without usable page dimensions or coordinates", () => {
    expect(normaliseBbox([10, 20, 100, 40], 0, 0)).toBeNull();
    expect(normaliseBbox([10, 20], 612, 792)).toBeNull();
    expect(normaliseBbox(null, 612, 792)).toBeNull();
  });
});

describe("buildBlockIndex derives bbox_norm (bug 2)", () => {
  it("computes bbox_norm from page dimensions when the provider omits it", () => {
    const layer = {
      raw_pages: [{
        index: 0, width: 612, height: 792,
        blocks: [{ text: "Bend Adapter THB-1", bbox: [61.2, 79.2, 306, 396], confidence: 0.9 }],
      }],
    };
    const [block] = buildBlockIndex(layer);
    // Previously `b.bbox_norm || null` — always null, so the UI dropped it.
    expect(block.bbox_norm).toEqual([0.1, 0.1, 0.5, 0.5]);
  });

  it("keeps an explicit bbox_norm when the provider supplies one", () => {
    const layer = {
      raw_pages: [{
        index: 0, width: 612, height: 792,
        blocks: [{ text: "x", bbox: [0, 0, 10, 10], bbox_norm: [0.7, 0.7, 0.8, 0.8] }],
      }],
    };
    expect(buildBlockIndex(layer)[0].bbox_norm).toEqual([0.7, 0.7, 0.8, 0.8]);
  });
});

describe("extractTextLayer accepts a Node Buffer (bug 1)", () => {
  it("reads text from a Buffer instead of failing with extract_failed", async () => {
    const layer = await extractTextLayer({ bytes: pdfBuffer, mime: "application/pdf" });
    expect(layer.status).toBe("has_text");
    expect(layer.error).toBeNull();
    expect(layer.char_count).toBeGreaterThan(0);
    expect(layer.page_count).toBe(2);
  });

  it("does not detach the caller's bytes (run.js reuses them for the LLM call)", async () => {
    const before = pdfBuffer.length;
    await extractTextLayer({ bytes: pdfBuffer, mime: "application/pdf" });
    await extractTextBlocks({ bytes: pdfBuffer });
    expect(pdfBuffer.length).toBe(before);
    expect(pdfBuffer.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});

describe("extractTextBlocks yields OCR-shaped geometry (bug 3)", () => {
  it("returns per-page line boxes without any OCR", async () => {
    const geo = await extractTextBlocks({ bytes: pdfBuffer });
    expect(geo).not.toBeNull();
    expect(geo.source).toBe("text_layer");
    expect(geo.raw_pages).toHaveLength(2);
    const p1 = geo.raw_pages[0];
    expect(p1.width).toBeCloseTo(612, 0);
    expect(p1.height).toBeCloseTo(792, 0);
    expect(p1.blocks.length).toBeGreaterThan(0);
    for (const b of p1.blocks) {
      expect(b.bbox).toHaveLength(4);
      expect(b.bbox.every(Number.isFinite)).toBe(true);
    }
  });

  it("uses a top-left origin, so y grows downward from the page top", async () => {
    const geo = await extractTextBlocks({ bytes: pdfBuffer });
    const p1 = geo.raw_pages[0];
    const upper = p1.blocks.find((b) => /SHANK/.test(b.text));   // drawn at y=700 (PDF, bottom-left)
    const lower = p1.blocks.find((b) => /HOLDER/.test(b.text));  // drawn at y=660 — lower on the page
    expect(upper).toBeTruthy();
    expect(lower).toBeTruthy();
    // Flipped correctly => the visually-higher line has the SMALLER y.
    expect(upper.bbox[1]).toBeLessThan(lower.bbox[1]);
    expect(upper.bbox[1]).toBeGreaterThan(0);
  });

  it("returns null for non-PDF or empty input rather than throwing", async () => {
    expect(await extractTextBlocks({ bytes: Buffer.from("not a pdf") })).toBeNull();
    expect(await extractTextBlocks({ bytes: null })).toBeNull();
  });
});

describe("end-to-end: a digital PDF stamps line evidence with no OCR", () => {
  it("stamps normalised evidence on the right page for each line", async () => {
    const geo = await extractTextBlocks({ bytes: pdfBuffer });
    const normalized = {
      lines: [
        { partNumber: "A1", description: "OBARA STD SHANK TWS-092-90-2" },
        { partNumber: "A2", description: "OBARA POINT HOLDER X-PH0004" },
      ],
    };
    const stamped = stampEvidenceOnLines(normalized, geo);
    expect(stamped).toBe(2);

    const [first, second] = normalized.lines;
    expect(first._evidence.page).toBe(1);
    expect(second._evidence.page).toBe(2);   // matched onto the correct page

    for (const ln of normalized.lines) {
      const n = ln._evidence.bbox_norm;
      // The UI requires Array.isArray(bbox_norm) with 0..1 coords, or it
      // discards the evidence and renders no highlight at all.
      expect(Array.isArray(n)).toBe(true);
      expect(n).toHaveLength(4);
      expect(n.every((v) => v >= 0 && v <= 1)).toBe(true);
      expect(n[0]).toBeLessThan(n[2]);
      expect(n[1]).toBeLessThan(n[3]);
    }
  });
});
