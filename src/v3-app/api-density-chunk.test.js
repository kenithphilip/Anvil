// densityChunkedExtract: split a dense text layer into row windows, extract
// each (dispatchExtract mocked), and merge the line arrays.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ calls: [] }));
vi.mock("../api/_lib/docai/index.js", () => ({
  // One extracted line per item row present in the window's bodyText.
  dispatchExtract: vi.fn(async ({ hints }) => {
    const body = hints?.bodyText || "";
    const items = body.split(/\r?\n/).filter((l) => /^\s*\d{1,4}[.)]?\s+\S/.test(l));
    H.calls.push({ bodyText: body, escalate: !!hints?.escalate, window: hints?.density_window });
    return {
      ok: true,
      selected_model: "claude-sonnet-4-6",
      model_selection_reason: "escalate_quality",
      normalized: { classification: "quote", customer: { name: "Fiat India Automobiles Limited" }, lines: items.map((_l, i) => ({ partNumber: "P" + i })) },
      confidences: { overall: 0.9 },
      confidence_overall: 0.9,
      attempts: [{ adapter: "claude", status: "ok" }],
    };
  }),
}));

const { densityChunkedExtract, isDensityKind, DENSITY_KINDS } = await import("../api/_lib/docai/density-chunk.js");

// A dense single-row table with preamble + header (see the row-chunker test).
const dense = (n = 50) => {
  const pre = ["PRICE QUOTATION", "No : OIQTLC-260327-FIAT-CONSUMABLES-ARC", "TO: Fiat India Automobiles Limited"];
  const header = [" Item   Part Name   PARTS NO.   HSN CODE   Qty Unit   Unit Price   Amount"];
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(`  ${i}   ADAPTER   TNA-16-04-${i}   85159000   5 Nos 660 3300`);
  return [...pre, "", ...header, "", ...rows, "", "", "Terms: ex-works"].join("\n");
};

beforeEach(() => { H.calls = []; });

describe("densityChunkedExtract", () => {
  it("splits a dense table into windows and merges every window's lines", async () => {
    const out = await densityChunkedExtract({
      source: { mime: "application/pdf" }, settings: {}, hints: { bodyText: dense(50), expectedKind: "quote" },
      opts: { maxItemsPerWindow: 20 },
    });
    expect(out.skip).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.density_chunked).toBe(true);
    expect(out.density_window_count).toBe(3); // ceil(50/20)
    // all 50 lines recovered across the 3 windows
    expect(out.normalized.lines.length).toBe(50);
    expect(out.normalized.customer?.name).toContain("Fiat");
  });

  it("sends each window at the generation tier with a WINDOWED body (not the full text)", async () => {
    const full = dense(50);
    await densityChunkedExtract({ source: {}, settings: {}, hints: { bodyText: full }, opts: { maxItemsPerWindow: 20 } });
    expect(H.calls.length).toBe(3);
    for (const c of H.calls) {
      expect(c.escalate).toBe(true);              // generation tier per window
      expect(c.bodyText.length).toBeLessThan(full.length); // a window, not the whole doc
      expect(c.bodyText).toContain("PARTS NO.");  // header replicated into the window
      expect(c.bodyText).toContain("Fiat India"); // preamble/context carried
    }
  });

  it("skips (caller keeps its result) when there is no body text", async () => {
    const out = await densityChunkedExtract({ source: {}, settings: {}, hints: {} });
    expect(out.skip).toBe(true);
    expect(out.reason).toBe("no_body_text");
  });

  it("skips when the table is not dense enough to be worth extra calls", async () => {
    const out = await densityChunkedExtract({ source: {}, settings: {}, hints: { bodyText: dense(8) } });
    expect(out.skip).toBe(true);
    expect(out.reason).toBe("not_dense_enough");
  });

  it("skips a single-window table (nothing gained over single-shot)", async () => {
    // 50 items but a big window -> one window
    const out = await densityChunkedExtract({ source: {}, settings: {}, hints: { bodyText: dense(50) }, opts: { maxItemsPerWindow: 500 } });
    expect(out.skip).toBe(true);
    expect(out.reason).toBe("single_window");
  });

  it("honours the runCost cap: stops after the breaching window, reports it", async () => {
    let checks = 0;
    const runCost = { hasExceeded: () => checks++ > 0 }; // false once, then true
    const out = await densityChunkedExtract({
      source: {}, settings: {}, hints: { bodyText: dense(50) }, runCost, opts: { maxItemsPerWindow: 20 },
    });
    expect(H.calls.length).toBe(1);
    expect(out.density_windows_run).toBe(1);
    expect(out.over_run_budget).toBe(true);
  });
});

describe("isDensityKind", () => {
  it("covers the line-table kinds and nothing else (matches ESCALATABLE_KINDS)", () => {
    expect(DENSITY_KINDS).toEqual(["po", "rfq", "quote"]);
    expect(isDensityKind("quote")).toBe(true);
    expect(isDensityKind("po")).toBe(true);
    expect(isDensityKind("rfq")).toBe(true);
    expect(isDensityKind("invoice")).toBe(false);
    expect(isDensityKind(undefined)).toBe(false);
  });
});

describe("completeness + source safety (adversarial-review fixes)", () => {
  it("marks a run COMPLETE only when every planned window ran and succeeded", async () => {
    const out = await densityChunkedExtract({
      source: {}, settings: {}, hints: { bodyText: dense(50) }, opts: { maxItemsPerWindow: 20 },
    });
    expect(out.density_complete).toBe(true);
    expect(out.density_windows_ok).toBe(3);
  });

  it("is NOT complete when a window fails, even though ok (okAny) is true", async () => {
    const dispatcher = await import("../api/_lib/docai/index.js");
    const good = dispatcher.dispatchExtract.getMockImplementation();
    dispatcher.dispatchExtract
      .mockImplementationOnce(good)
      .mockImplementationOnce(async () => ({ ok: false, reason: "upstream_error", normalized: { classification: null, customer: null, lines: [] }, confidences: {}, attempts: [] }))
      .mockImplementationOnce(good);
    const out = await densityChunkedExtract({
      source: {}, settings: {}, hints: { bodyText: dense(50) }, opts: { maxItemsPerWindow: 20 },
    });
    expect(out.ok).toBe(true);              // okAny -- a partial looks "ok"
    expect(out.density_complete).toBe(false); // ...but is NOT complete
    expect(out.density_windows_ok).toBe(2);
  });

  it("is NOT complete when the deadline cuts the walk short", async () => {
    const out = await densityChunkedExtract({
      source: {}, settings: {}, hints: { bodyText: dense(50) },
      opts: { maxItemsPerWindow: 20, deadlineAt: Date.now() - 1 },
    });
    // no window ran -> skip signal, caller keeps its own result
    expect(out.skip).toBe(true);
  });

  it("STRIPS source bytes so a byte-consuming adapter can't extract the whole document per window", async () => {
    const dispatcherMod = await import("../api/_lib/docai/index.js");
    dispatcherMod.dispatchExtract.mockClear();   // assert only THIS test's calls
    const pdfBytes = Buffer.from("%PDF-1.4 whole document");
    await densityChunkedExtract({
      source: { bytes: pdfBytes, url: "https://x/y.pdf", mime: "application/pdf", filename: "q.pdf" },
      settings: {}, hints: { bodyText: dense(50) }, opts: { maxItemsPerWindow: 20 },
    });
    expect(dispatcherMod.dispatchExtract.mock.calls.length).toBe(3);
    for (const [arg] of dispatcherMod.dispatchExtract.mock.calls) {
      expect(arg.source.bytes).toBeNull();
      expect(arg.source.url).toBeNull();
      expect(arg.source.filename).toBe("q.pdf"); // identity kept for diagnostics
    }
  });
});
