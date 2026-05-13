// Unit tests for src/api/_lib/fuzzy-match.js (Wave CM 2.4).

import { describe, it, expect } from "vitest";
import {
  normaliseToken, significantWords, jaro, jaroWinkler,
  metaphone, nGrams, jaccardNgrams, blockingKey, compositeScore,
} from "../api/_lib/fuzzy-match.js";

describe("normaliseToken", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normaliseToken("  Bend, ADAPTER!  ")).toBe("bend adapter");
  });
  it("returns '' on null", () => {
    expect(normaliseToken(null)).toBe("");
  });
});

describe("significantWords", () => {
  it("filters out stop words and short tokens", () => {
    expect(significantWords("the BIG BEND adapter for nos")).toEqual(["big", "bend", "adapter"]);
  });
});

describe("jaro", () => {
  it("returns 1 on identical strings", () => {
    expect(jaro("MARTHA", "MARTHA")).toBe(1);
  });
  it("returns 0 on empty mismatch", () => {
    expect(jaro("", "x")).toBe(0);
  });
  it("returns the classic MARTHA / MARHTA score", () => {
    expect(jaro("MARTHA", "MARHTA")).toBeCloseTo(0.9444, 3);
  });
  it("returns the classic DIXON / DICKSONX score", () => {
    expect(jaro("DIXON", "DICKSONX")).toBeCloseTo(0.7667, 3);
  });
});

describe("jaroWinkler", () => {
  it("boosts score for shared prefix vs plain Jaro", () => {
    const a = jaro("MARTHA", "MARHTA");
    const b = jaroWinkler("MARTHA", "MARHTA");
    expect(b).toBeGreaterThan(a);
  });
  it("returns 0 when Jaro returns 0", () => {
    expect(jaroWinkler("", "x")).toBe(0);
  });
  it("returns 1 on identical strings", () => {
    expect(jaroWinkler("THB-001", "THB-001")).toBe(1);
  });
  it("scores typos in long part numbers high enough to match", () => {
    expect(jaroWinkler("THB-L1-70B-2-GA", "THB-L1-70B-2-G")).toBeGreaterThan(0.95);
  });
});

describe("metaphone", () => {
  it("collapses sound-alikes", () => {
    expect(metaphone("smith")).toBe(metaphone("smyth"));
  });
  it("returns '' on null / empty", () => {
    expect(metaphone(null)).toBe("");
    expect(metaphone("")).toBe("");
  });
  it("encodes 'th' as 0", () => {
    expect(metaphone("through")).toContain("0");
  });
  it("handles silent letters", () => {
    expect(metaphone("knight").startsWith("N")).toBe(true);
  });
  it("uppercases input", () => {
    expect(metaphone("Bend")).toBe(metaphone("BEND"));
  });
});

describe("nGrams / jaccardNgrams", () => {
  it("produces sliding 3-grams", () => {
    const out = nGrams("BEND", 3);
    expect(out.has("ben")).toBe(true);
    expect(out.has("end")).toBe(true);
  });
  it("returns 1 on identical strings", () => {
    expect(jaccardNgrams("BEND ADAPTER", "BEND ADAPTER")).toBe(1);
  });
  it("returns higher score on overlapping tokens", () => {
    const a = jaccardNgrams("BEND ADAPTER", "BEND ADAPTER X1");
    const b = jaccardNgrams("BEND ADAPTER", "POINT HOLDER");
    expect(a).toBeGreaterThan(b);
  });
});

describe("blockingKey", () => {
  it("composes part-no prefix + metaphone of first word", () => {
    const k = blockingKey({ partNo: "THB-L1-70B-2-GA", description: "Bend adapter" });
    // First 3 normalised chars of "thbl1...": "thb" -> upper "THB".
    expect(k.startsWith("THB|")).toBe(true);
    expect(k.length).toBeGreaterThan(4);
  });
  it("groups same-block lines", () => {
    const a = blockingKey({ partNo: "THB-001", description: "Bend adapter" });
    const b = blockingKey({ partNo: "THB-002", description: "Bend Adapter X" });
    expect(a).toBe(b);
  });
  it("splits different families", () => {
    const a = blockingKey({ partNo: "THB-001", description: "Bend adapter" });
    const b = blockingKey({ partNo: "ABC-001", description: "Bolt M8" });
    expect(a).not.toBe(b);
  });
});

describe("compositeScore", () => {
  it("scores an exact match at the top of the range", () => {
    const s = compositeScore(
      { partNumber: "THB-001", description: "Bend adapter" },
      { part_no: "THB-001", description: "Bend adapter" },
    );
    expect(s).toBeGreaterThan(0.9);
  });

  it("scores a noisy near-match above ambiguous candidates", () => {
    const close = compositeScore(
      { partNumber: "THB-001A", description: "Bend adapter X1" },
      { part_no: "THB-001",  description: "Bend adapter" },
    );
    const far = compositeScore(
      { partNumber: "THB-001A", description: "Bend adapter X1" },
      { part_no: "ZZZ-999",  description: "Random gizmo" },
    );
    expect(close).toBeGreaterThan(far);
  });

  it("returns 0 on missing inputs", () => {
    expect(compositeScore({}, {})).toBe(0);
  });
});
