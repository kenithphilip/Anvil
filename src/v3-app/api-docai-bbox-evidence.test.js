// Unit tests for src/api/_lib/docai/bbox-evidence.js (Wave 4.3).

import { describe, it, expect } from "vitest";
import {
  buildBlockIndex, findEvidenceForLine, stampEvidenceOnLines, __test,
} from "../api/_lib/docai/bbox-evidence.js";

const mockOcrLayer = () => ({
  raw_pages: [
    {
      index: 0,
      blocks: [
        { text: "Bend Adapter THB-1", bbox: [10, 20, 100, 40], confidence: 0.92 },
        { text: "Point Holder PH-9", bbox: [10, 50, 100, 70], confidence: 0.88 },
        { text: "Random gizmo", bbox: [10, 80, 100, 100], confidence: 0.80 },
      ],
    },
    {
      index: 1,
      blocks: [
        { text: "Tail end note", bbox: [10, 20, 200, 30], confidence: 0.70 },
      ],
    },
  ],
});

describe("__test.significantTokens", () => {
  it("strips short words and stop tokens", () => {
    expect(__test.significantTokens("the bend adapter")).toEqual(["bend", "adapter"]);
  });
  it("returns [] on null", () => {
    expect(__test.significantTokens(null)).toEqual([]);
  });
});

describe("buildBlockIndex", () => {
  it("flattens raw_pages into one block list", () => {
    const blocks = buildBlockIndex(mockOcrLayer());
    expect(blocks.length).toBe(4);
    expect(blocks[0].page).toBe(1);
    expect(blocks[3].page).toBe(2);
  });
  it("returns [] when no ocr", () => {
    expect(buildBlockIndex(null)).toEqual([]);
  });
  it("skips blocks without bbox or text", () => {
    const layer = { raw_pages: [{ blocks: [{ text: null, bbox: [1, 2, 3, 4] }, { text: "ok", bbox: null }] }] };
    expect(buildBlockIndex(layer)).toEqual([]);
  });
});

describe("findEvidenceForLine", () => {
  const blocks = buildBlockIndex(mockOcrLayer());

  it("matches a line to its best-fit block via token overlap", () => {
    const ev = findEvidenceForLine({ partNumber: "THB-1", description: "Bend Adapter" }, blocks);
    expect(ev).not.toBeNull();
    expect(ev.page).toBe(1);
    expect(ev.bbox).toEqual([10, 20, 100, 40]);
    expect(ev.score).toBeGreaterThanOrEqual(1);
  });

  it("returns null when no significant tokens", () => {
    expect(findEvidenceForLine({ description: "the for nos" }, blocks)).toBeNull();
  });

  it("returns null when no block has any overlap", () => {
    expect(findEvidenceForLine({ description: "unknown stuff" }, blocks)).toBeNull();
  });

  it("picks the highest-confidence block on overlap tie", () => {
    const blocks2 = [
      { page: 1, text: "Bend Adapter X", bbox: [1, 2, 3, 4], confidence: 0.7 },
      { page: 1, text: "Bend Adapter X", bbox: [5, 6, 7, 8], confidence: 0.9 },
    ];
    const ev = findEvidenceForLine({ description: "Bend Adapter X" }, blocks2);
    expect(ev.bbox).toEqual([5, 6, 7, 8]);
  });
});

describe("stampEvidenceOnLines", () => {
  it("decorates each matched line with _evidence", () => {
    const normalized = {
      lines: [
        { partNumber: "THB-1", description: "Bend Adapter" },
        { partNumber: "PH-9", description: "Point Holder" },
        { partNumber: "Z", description: "unknown stuff" },
      ],
    };
    const count = stampEvidenceOnLines(normalized, mockOcrLayer());
    expect(count).toBe(2);
    expect(normalized.lines[0]._evidence).toBeDefined();
    expect(normalized.lines[1]._evidence).toBeDefined();
    expect(normalized.lines[2]._evidence).toBeUndefined();
  });

  it("returns 0 when no lines / no ocr", () => {
    expect(stampEvidenceOnLines({ lines: [] }, mockOcrLayer())).toBe(0);
    expect(stampEvidenceOnLines({ lines: [{ description: "x" }] }, null)).toBe(0);
  });
});
