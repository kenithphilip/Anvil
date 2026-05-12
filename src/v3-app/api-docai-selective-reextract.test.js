// Unit tests for src/api/_lib/docai/selective-reextract.js (Wave 4.4).

import { describe, it, expect, vi } from "vitest";
import {
  selectiveReextract, mergeSelectiveUpdates, __test,
} from "../api/_lib/docai/selective-reextract.js";

describe("__test.buildSubsetPrompt", () => {
  it("returns the prior values for the indicated indices", () => {
    const prior = {
      lines: [
        { partNumber: "A", description: "Alpha", quantity: 1, unitPrice: 10 },
        { partNumber: "B", description: "Beta", quantity: 2, unitPrice: 20 },
        { partNumber: "C", description: "Gamma", quantity: 3, unitPrice: 30 },
      ],
    };
    const out = __test.buildSubsetPrompt(prior, [0, 2]);
    expect(out.length).toBe(2);
    expect(out[0].line_index).toBe(0);
    expect(out[1].part_number).toBe("C");
  });
  it("filters out invalid indices", () => {
    const prior = { lines: [{ partNumber: "A" }] };
    expect(__test.buildSubsetPrompt(prior, [0, 99, -1])).toHaveLength(1);
  });
});

describe("selectiveReextract", () => {
  it("returns ok=false on missing inputs", async () => {
    expect((await selectiveReextract({ bodyText: null })).ok).toBe(false);
    expect((await selectiveReextract({ bodyText: "x", priorNormalized: {}, lineIndices: [] })).ok).toBe(false);
  });

  it("returns ok=false when callAnthropic is not provided", async () => {
    const out = await selectiveReextract({
      bodyText: "doc",
      priorNormalized: { lines: [{}] },
      lineIndices: [0],
    });
    expect(out.ok).toBe(false);
  });

  it("parses returned lines from the tool_use block", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        content: [{
          type: "tool_use",
          name: "return_lines",
          input: { lines: [{ line_index: 1, unitPrice: 110, confidence: 0.95 }] },
        }],
      },
    });
    const out = await selectiveReextract({
      bodyText: "doc",
      priorNormalized: { lines: [{}, { unitPrice: 100 }] },
      lineIndices: [1],
      callAnthropic,
    });
    expect(out.ok).toBe(true);
    expect(out.updated_lines[0].unitPrice).toBe(110);
  });

  it("returns ok=false when callAnthropic fails", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({ ok: false, error: "upstream" });
    const out = await selectiveReextract({
      bodyText: "doc",
      priorNormalized: { lines: [{}] },
      lineIndices: [0],
      callAnthropic,
    });
    expect(out.ok).toBe(false);
  });

  it("returns ok=false when the model omits the tool_use block", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({ ok: true, data: { content: [{ type: "text", text: "hi" }] } });
    const out = await selectiveReextract({
      bodyText: "doc",
      priorNormalized: { lines: [{}] },
      lineIndices: [0],
      callAnthropic,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("no_tool_use");
  });
});

describe("mergeSelectiveUpdates", () => {
  it("overwrites only the specified fields on the indicated lines", () => {
    const prior = {
      lines: [
        { partNumber: "A", quantity: 10, unitPrice: 100 },
        { partNumber: "B", quantity: 5, unitPrice: 50 },
      ],
    };
    const updated = mergeSelectiveUpdates(prior, [
      { line_index: 1, unitPrice: 55, confidence: 0.93 },
    ]);
    expect(updated.lines[0]).toEqual({ partNumber: "A", quantity: 10, unitPrice: 100 });
    expect(updated.lines[1].unitPrice).toBe(55);
    expect(updated.lines[1].quantity).toBe(5);
    expect(updated.lines[1]._reextract_confidence).toBe(0.93);
    expect(updated.lines[1]._reextracted_at).toBeDefined();
  });

  it("ignores out-of-range indices", () => {
    const prior = { lines: [{ unitPrice: 100 }] };
    const updated = mergeSelectiveUpdates(prior, [{ line_index: 99, unitPrice: 999 }]);
    expect(updated.lines[0].unitPrice).toBe(100);
  });

  it("is a no-op on empty updates", () => {
    const prior = { lines: [{ unitPrice: 100 }] };
    const before = JSON.stringify(prior);
    mergeSelectiveUpdates(prior, []);
    expect(JSON.stringify(prior)).toBe(before);
  });
});
