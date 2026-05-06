// Unit tests for the customer-PO format pre-check. Pins the
// behaviour of every layer (required-fields, regex pattern, fuzzy
// alias, cross-field arithmetic, fingerprint drift) plus the
// orchestrator's severity sort + summary.

import { describe, it, expect } from "vitest";
import { __test } from "../api/format_profile/check.js";

const {
  levenshtein, normalisePart, closeEnough, headerFingerprint,
  checkRequired, checkPatterns, resolveAliases, checkArithmetic,
  checkFingerprint, runChecks,
} = __test;

describe("levenshtein", () => {
  it("identical strings are 0", () => {
    expect(levenshtein("foo", "foo")).toBe(0);
  });

  it("single edit is 1", () => {
    expect(levenshtein("foo", "fou")).toBe(1);
    expect(levenshtein("foo", "fo")).toBe(1);
    expect(levenshtein("foo", "foox")).toBe(1);
  });

  it("threshold short-circuit returns Infinity past budget", () => {
    expect(levenshtein("aaaa", "bbbb", 1)).toBe(Infinity);
  });

  it("normalisePart casefolds and strips spaces/dashes/slashes", () => {
    expect(normalisePart("BR-6204 ZZ")).toBe("br6204zz");
    expect(normalisePart("br/6204_zz")).toBe("br6204zz");
  });
});

describe("closeEnough", () => {
  it("respects absolute tolerance", () => {
    expect(closeEnough(100, 100.005)).toBe(true);
    expect(closeEnough(100, 102)).toBe(false);
  });
  it("respects relative tolerance for big numbers", () => {
    expect(closeEnough(10000, 10080, { rel: 0.01 })).toBe(true);
    expect(closeEnough(10000, 10500, { rel: 0.01 })).toBe(false);
  });
  it("rejects non-finite inputs", () => {
    expect(closeEnough("x", 5)).toBe(false);
  });
});

describe("headerFingerprint", () => {
  it("is stable under key reordering", () => {
    expect(headerFingerprint({ a: 1, b: 2 })).toBe(headerFingerprint({ b: 2, a: 1 }));
  });
  it("changes when keys change", () => {
    const a = headerFingerprint({ po_number: "x", buyer_email: "y" });
    const b = headerFingerprint({ po_number: "x", buyer_phone: "y" });
    expect(a).not.toBe(b);
  });
});

describe("checkRequired", () => {
  it("flags missing keys as high severity", () => {
    const issues = checkRequired({ po_number: "1" }, { required_headers: ["po_number", "buyer_gst"] });
    expect(issues.length).toBe(1);
    expect(issues[0].field_path).toBe("header.buyer_gst");
    expect(issues[0].severity).toBe("high");
  });
  it("blank string counts as missing", () => {
    const issues = checkRequired({ po_number: "" }, { required_headers: ["po_number"] });
    expect(issues.length).toBe(1);
  });
  it("returns no issues when all present", () => {
    const issues = checkRequired({ po_number: "X" }, { required_headers: ["po_number"] });
    expect(issues.length).toBe(0);
  });
});

describe("checkPatterns", () => {
  it("flags mismatch as medium", () => {
    const issues = checkPatterns(
      { po_number: "abc" },
      { field_patterns: { po_number: "^PO-\\d+$" } },
    );
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe("medium");
  });
  it("passes when pattern matches", () => {
    const issues = checkPatterns(
      { po_number: "PO-123" },
      { field_patterns: { po_number: "^PO-\\d+$" } },
    );
    expect(issues.length).toBe(0);
  });
  it("ignores missing values (handled by checkRequired)", () => {
    const issues = checkPatterns({}, { field_patterns: { po_number: "^PO-\\d+$" } });
    expect(issues.length).toBe(0);
  });
  it("ignores invalid regex without throwing", () => {
    expect(() => checkPatterns({ x: "y" }, { field_patterns: { x: "(unbalanced" } })).not.toThrow();
  });
});

describe("resolveAliases", () => {
  const aliases = { "BRG 6204": "BR-6204-ZZ", "Bearing 6204 ZZ": "BR-6204-ZZ" };

  it("direct alias returns confidence 1.0", () => {
    const out = resolveAliases([{ part_number: "BRG 6204" }], { aliases });
    expect(out.suggestions.length).toBe(1);
    expect(out.suggestions[0].method).toBe("alias_direct");
    expect(out.suggestions[0].suggested_value).toBe("BR-6204-ZZ");
  });

  it("fuzzy alias within threshold suggests the canonical", () => {
    const out = resolveAliases([{ part_number: "BRG6205" }], { aliases }, { aliasThreshold: 2 });
    expect(out.suggestions.length).toBe(1);
    expect(out.suggestions[0].method).toBe("alias_fuzzy");
    expect(out.suggestions[0].edit_distance).toBeGreaterThan(0);
    expect(out.suggestions[0].edit_distance).toBeLessThanOrEqual(2);
  });

  it("does not suggest when already canonical", () => {
    const out = resolveAliases([{ part_number: "BR-6204-ZZ" }], { aliases });
    expect(out.suggestions.length).toBe(0);
  });

  it("does not suggest beyond threshold", () => {
    const out = resolveAliases([{ part_number: "completelyDifferent" }], { aliases }, { aliasThreshold: 2 });
    expect(out.suggestions.length).toBe(0);
  });
});

describe("checkArithmetic", () => {
  it("flags line-total mismatch beyond tolerance", () => {
    const issues = checkArithmetic({
      header: {},
      lines: [{ qty: 3, unit_price: 100, line_total: 250 }], // expected 300
    });
    const layers = issues.map((i) => i.layer);
    expect(layers).toContain("line_arithmetic");
  });

  it("accepts penny rounding", () => {
    const issues = checkArithmetic({
      header: {},
      lines: [{ qty: 1, unit_price: 99.995, line_total: 100.00 }],
    });
    expect(issues.length).toBe(0);
  });

  it("flags subtotal != Σ line totals", () => {
    const issues = checkArithmetic({
      header: { subtotal: 999 },
      lines: [
        { qty: 2, unit_price: 100, line_total: 200 },
        { qty: 1, unit_price: 100, line_total: 100 },
      ],
    });
    expect(issues.some((i) => i.layer === "subtotal_sum")).toBe(true);
  });

  it("flags GST != subtotal * gst_rate", () => {
    const issues = checkArithmetic({
      header: { subtotal: 1000, gst_rate: 0.18, gst: 100 },
      lines: [{ qty: 1, unit_price: 1000, line_total: 1000 }],
    });
    expect(issues.some((i) => i.layer === "gst_consistency")).toBe(true);
  });

  it("flags grand_total != subtotal + gst", () => {
    const issues = checkArithmetic({
      header: { subtotal: 1000, gst: 180, grand_total: 1500 },
      lines: [{ qty: 1, unit_price: 1000, line_total: 1000 }],
    });
    expect(issues.some((i) => i.layer === "grand_total")).toBe(true);
  });
});

describe("checkFingerprint", () => {
  it("returns a low-severity issue when fingerprint drifted", () => {
    const issues = checkFingerprint(
      { header: { po_number: 1, new_field: 2 } },
      { fingerprint: { headers: "deadbeef" } },
    );
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe("low");
  });
  it("returns nothing when no expected fingerprint", () => {
    expect(checkFingerprint({ header: { x: 1 } }, {})).toEqual([]);
  });
});

describe("runChecks orchestrator", () => {
  const profile = {
    fingerprint: { headers: headerFingerprint({ po_number: "", buyer_gst: "" }) },
    recipe: {
      required_headers: ["po_number", "buyer_gst"],
      field_patterns: { po_number: "^PO-\\d+$" },
    },
    learned_rules: {
      aliases: { "BRG 6204": "BR-6204-ZZ" },
    },
  };

  it("ok=false when any high-severity issue", () => {
    const out = runChecks({ header: { po_number: "PO-1" }, lines: [] }, profile);
    expect(out.ok).toBe(false);
    expect(out.summary.high).toBeGreaterThan(0);
  });

  it("orders issues by severity descending", () => {
    const out = runChecks({
      header: { po_number: "abc" },
      lines: [{ qty: 1, unit_price: 100, line_total: 200 }],
    }, profile);
    const levels = out.issues.map((i) => i.severity);
    const rank = (s) => ({ high: 0, medium: 1, low: 2 }[s]);
    for (let i = 1; i < levels.length; i++) {
      expect(rank(levels[i])).toBeGreaterThanOrEqual(rank(levels[i - 1]));
    }
  });

  it("includes alias suggestions in the result", () => {
    const out = runChecks({
      header: { po_number: "PO-1", buyer_gst: "X" },
      lines: [{ part_number: "BRG 6204" }],
    }, profile);
    expect(out.suggestions.length).toBe(1);
    expect(out.suggestions[0].suggested_value).toBe("BR-6204-ZZ");
  });

  it("ok=true and summary.high===0 with a clean payload", () => {
    const out = runChecks({
      header: { po_number: "PO-9", buyer_gst: "29ABCDE1234F1Z5" },
      lines: [{ qty: 2, unit_price: 50, line_total: 100 }],
    }, profile);
    expect(out.summary.high).toBe(0);
    expect(out.ok).toBe(true);
  });

  it("works without a profile (no checks fail; fingerprint stable)", () => {
    const out = runChecks({ header: {}, lines: [] }, null);
    expect(out.ok).toBe(true);
    expect(out.summary.total).toBe(0);
  });
});
