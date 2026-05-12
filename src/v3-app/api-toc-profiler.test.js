// Unit tests for src/api/_lib/docai/toc-profiler.js.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/anthropic.js", () => ({
  callAnthropic: vi.fn(),
  cacheableSystem: (s) => s == null ? null : [{ type: "text", text: String(s) }],
  cacheableTools: (t) => t,
}));

import { callAnthropic } from "../api/_lib/anthropic.js";
import { profileDocument, __test } from "../api/_lib/docai/toc-profiler.js";

const TENANT = "00000000-0000-0000-0000-0000000000aa";

const toolResponse = (input) => ({
  ok: true,
  data: {
    content: [
      { type: "tool_use", name: "classify_document_pages", input },
    ],
  },
});

beforeEach(() => { vi.clearAllMocks(); });

describe("__test.sanitiseLineItemPages", () => {
  it("dedupes and sorts", () => {
    expect(__test.sanitiseLineItemPages([3, 1, 2, 2], 10)).toEqual([1, 2, 3]);
  });
  it("drops out-of-range entries", () => {
    expect(__test.sanitiseLineItemPages([0, 1, 5, 11], 10)).toEqual([1, 5]);
  });
  it("returns [] on non-arrays", () => {
    expect(__test.sanitiseLineItemPages(null, 10)).toEqual([]);
    expect(__test.sanitiseLineItemPages("nope", 10)).toEqual([]);
  });
});

describe("profileDocument", () => {
  it("returns ok=true on a confident PO classification", async () => {
    callAnthropic.mockResolvedValueOnce(toolResponse({
      classification: "po",
      confidence: 0.92,
      page_count: 70,
      page_categories: [
        { page: 1, kind: "header" },
        { page: 2, kind: "line_items" },
        { page: 3, kind: "line_items" },
        { page: 4, kind: "terms" },
        { page: 5, kind: "signature" },
      ],
      line_item_pages: [2, 3],
      reason: null,
    }));
    const out = await profileDocument({
      source: { bytes: Buffer.from("%PDF-1.4 fake") },
      tenantId: TENANT,
    });
    expect(out.ok).toBe(true);
    expect(out.classification).toBe("po");
    expect(out.line_item_pages).toEqual([2, 3]);
    expect(out.page_count).toBe(70);
  });

  it("returns ok=false when confidence is below threshold so caller falls back to all-pages", async () => {
    callAnthropic.mockResolvedValueOnce(toolResponse({
      classification: "po",
      confidence: 0.4,
      page_count: 10,
      page_categories: [],
      line_item_pages: [3],
      reason: "layout ambiguous",
    }));
    const out = await profileDocument({
      source: { bytes: Buffer.from("%PDF") },
      tenantId: TENANT,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("low_confidence");
  });

  it("flags ok=false when the model returns no line-item pages", async () => {
    callAnthropic.mockResolvedValueOnce(toolResponse({
      classification: "non_po",
      confidence: 0.95,
      page_count: 4,
      page_categories: [{ page: 1, kind: "drawing" }],
      line_item_pages: [],
      reason: "engineering drawing only",
    }));
    const out = await profileDocument({
      source: { bytes: Buffer.from("%PDF") },
      tenantId: TENANT,
    });
    expect(out.ok).toBe(false);
    expect(out.classification).toBe("non_po");
  });

  it("returns ok=false when callAnthropic fails", async () => {
    callAnthropic.mockResolvedValueOnce({ ok: false, status: 502, error: "upstream" });
    const out = await profileDocument({
      source: { bytes: Buffer.from("%PDF") },
      tenantId: TENANT,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("upstream");
  });

  it("rejects sources without bytes or url", async () => {
    const out = await profileDocument({ source: {}, tenantId: TENANT });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("no_source");
  });

  it("returns ok=false when the model does not emit a tool_use block", async () => {
    callAnthropic.mockResolvedValueOnce({ ok: true, data: { content: [{ type: "text", text: "hi" }] } });
    const out = await profileDocument({
      source: { bytes: Buffer.from("%PDF") },
      tenantId: TENANT,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("no_tool_use");
  });

  it("clamps confidence to [0, 1] and dedupes line_item_pages", async () => {
    callAnthropic.mockResolvedValueOnce(toolResponse({
      classification: "po",
      confidence: 1.5,
      page_count: 5,
      page_categories: [],
      line_item_pages: [3, 1, 1, 7, 2],
      reason: null,
    }));
    const out = await profileDocument({
      source: { bytes: Buffer.from("%PDF") },
      tenantId: TENANT,
    });
    expect(out.confidence).toBe(1);
    expect(out.line_item_pages).toEqual([1, 2, 3]); // 7 is dropped (> page_count)
  });
});
