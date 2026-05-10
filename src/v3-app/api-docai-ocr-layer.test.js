// Phase B: L2 OCR layer tests.
//
// Covers the parts that don't need a real Mistral round-trip:
//   - block-to-text reading order
//   - per-page summary
//   - status classification (ok/partial/failed)
//   - threshold table is exported
//   - extractOcrLayer fail-soft on empty bytes / OCR throw

import { describe, it, expect, vi } from "vitest";
import { extractOcrLayer, OCR_LAYER_THRESHOLDS, __test__ } from "../api/_lib/docai/ocr_layer.js";

describe("ocr_layer / blocksToText", () => {
  it("orders blocks top-to-bottom then left-to-right by bbox", () => {
    const blocks = [
      { text: "lower", bbox: [10, 200, 100, 220] },
      { text: "upper-right", bbox: [200, 50, 300, 70] },
      { text: "upper-left", bbox: [10, 50, 100, 70] },
    ];
    expect(__test__.blocksToText(blocks)).toBe("upper-left\nupper-right\nlower");
  });

  it("falls back to insertion order when bboxes are missing", () => {
    const blocks = [{ text: "first" }, { text: "second" }, { text: "third" }];
    expect(__test__.blocksToText(blocks)).toBe("first\nsecond\nthird");
  });

  it("drops empty / whitespace-only blocks", () => {
    const blocks = [{ text: "real" }, { text: "   " }, { text: "" }];
    expect(__test__.blocksToText(blocks)).toBe("real");
  });
});

describe("ocr_layer / summarisePages", () => {
  it("counts blocks + chars + has_text per page", () => {
    const summary = __test__.summarisePages([
      { index: 0, blocks: [{ text: "hello" }, { text: "world" }] },
      { index: 1, blocks: [] },
    ]);
    expect(summary).toEqual([
      { page: 1, blocks: 2, chars: "hello\nworld".length, has_text: false },
      { page: 2, blocks: 0, chars: 0, has_text: false },
    ]);
  });

  it("flags has_text when chars >= 30", () => {
    const longText = "x".repeat(40);
    const summary = __test__.summarisePages([{ index: 0, blocks: [{ text: longText }] }]);
    expect(summary[0].has_text).toBe(true);
  });
});

describe("ocr_layer / classifyOcr", () => {
  it("returns failed on no usable text", () => {
    expect(__test__.classifyOcr(0, [])).toBe("failed");
  });

  it("returns ok when every page has text", () => {
    expect(__test__.classifyOcr(500, [
      { has_text: true }, { has_text: true },
    ])).toBe("ok");
  });

  it("returns partial when some pages lack text", () => {
    expect(__test__.classifyOcr(500, [
      { has_text: true }, { has_text: false },
    ])).toBe("partial");
  });
});

describe("ocr_layer / thresholds", () => {
  it("exposes the constants", () => {
    expect(OCR_LAYER_THRESHOLDS.perPage).toBeGreaterThan(0);
    expect(OCR_LAYER_THRESHOLDS.bodyTextBytes).toBeGreaterThan(0);
  });
});

describe("ocr_layer / fail-soft paths", () => {
  it("returns failed when no bytes", async () => {
    const out = await extractOcrLayer({ buffer: null });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/no bytes/);
  });

  it("returns failed when ocrDocument throws", async () => {
    // The mistral.js module reads MISTRAL_API_KEY at call time.
    // Without it the helper throws synchronously, which our wrapper
    // catches and surfaces as status='failed'.
    const saved = process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    try {
      const out = await extractOcrLayer({
        buffer: Buffer.from([0x25, 0x50, 0x44, 0x46]),       // "%PDF"
        filename: "test.pdf",
        mimeType: "application/pdf",
      });
      expect(out.ok).toBe(false);
      expect(out.status).toBe("failed");
      expect(out.body_text).toBeNull();
    } finally {
      if (saved) process.env.MISTRAL_API_KEY = saved;
    }
  });
});

describe("ocr_layer / shape contract", () => {
  it("matches the contract documented in the module", async () => {
    const out = await extractOcrLayer({ buffer: null });
    // Even on the failure path the shape stays stable so the
    // dispatcher / pipeline can read it without conditionals.
    expect(out).toMatchObject({
      ok: false,
      status: expect.any(String),
      page_count: expect.any(Number),
      char_count: expect.any(Number),
      body_text: null,
      page_breakdown: expect.any(Array),
      bbox_count: expect.any(Number),
      provider: "mistral",
      latency_ms: expect.any(Number),
    });
  });
});
