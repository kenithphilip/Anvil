// Unit tests for src/api/_lib/docai/field-voter.js (Wave 3.2).

import { describe, it, expect } from "vitest";
import {
  groupNumericByTolerance,
  voteNumericField,
  augmentVoterOutput,
  __test,
} from "../api/_lib/docai/field-voter.js";

describe("groupNumericByTolerance", () => {
  it("groups values within 1% of each other", () => {
    const cands = [
      { value: 100.0, confidence: 0.9, adapter: "a" },
      { value: 100.5, confidence: 0.9, adapter: "b" },
      { value: 100.0, confidence: 0.9, adapter: "c" },
    ];
    const buckets = groupNumericByTolerance(cands);
    expect(buckets.length).toBe(1);
    expect(buckets[0].members.length).toBe(3);
  });

  it("splits values outside tolerance", () => {
    const cands = [
      { value: 100, confidence: 0.9, adapter: "a" },
      { value: 200, confidence: 0.9, adapter: "b" },
    ];
    const buckets = groupNumericByTolerance(cands);
    expect(buckets.length).toBe(2);
  });

  it("respects custom tolerance_pct", () => {
    const cands = [
      { value: 100, confidence: 0.9, adapter: "a" },
      { value: 110, confidence: 0.9, adapter: "b" },
    ];
    const tight = groupNumericByTolerance(cands, 0.01, 0.05);
    expect(tight.length).toBe(2);
    const loose = groupNumericByTolerance(cands, 0.15, 0.05);
    expect(loose.length).toBe(1);
  });
});

describe("__test.median", () => {
  it("returns the middle on odd length", () => {
    expect(__test.median([1, 5, 3])).toBe(3);
  });
  it("averages two middle values on even length", () => {
    expect(__test.median([1, 2, 3, 4])).toBe(2.5);
  });
  it("returns null on empty", () => {
    expect(__test.median([])).toBeNull();
  });
});

describe("voteNumericField", () => {
  it("returns 'single' when one adapter contributed", () => {
    const out = voteNumericField([{ value: 100, confidence: 0.9, adapter: "claude" }]);
    expect(out.mode).toBe("single");
    expect(out.value).toBe(100);
    expect(out.agreement_count).toBe(1);
  });

  it("returns 'majority' when two adapters agree within tolerance", () => {
    const out = voteNumericField([
      { value: 100.0, confidence: 0.9, adapter: "claude" },
      { value: 100.5, confidence: 0.85, adapter: "gemini" },
    ]);
    expect(out.mode).toBe("majority");
    expect(out.agreement_count).toBe(2);
    expect(out.confidence_boosted).toBe(true);
    expect(out.confidence).toBeGreaterThan(0.9);
  });

  it("returns 'median' when no agreement", () => {
    const out = voteNumericField([
      { value: 100, confidence: 0.9, adapter: "claude" },
      { value: 200, confidence: 0.8, adapter: "gemini" },
      { value: 110, confidence: 0.7, adapter: "reducto" },
    ]);
    expect(out.mode).toBe("median");
    expect(out.value).toBe(110);
  });

  it("returns 'none' on no numeric candidates", () => {
    const out = voteNumericField([
      { value: null, confidence: 0.9, adapter: "claude" },
      { value: "abc", confidence: 0.9, adapter: "gemini" },
    ]);
    expect(out.mode).toBe("none");
    expect(out.value).toBeNull();
  });
});

describe("augmentVoterOutput", () => {
  it("re-votes per-line numeric fields", () => {
    const merged = {
      lines: [
        { unitPrice: 100, quantity: 10, amount: 1000 },
      ],
    };
    const adapterResults = [
      { ok: true, adapter_used: "a", confidence_overall: 0.9, normalized: { lines: [{ unitPrice: 100, quantity: 10, amount: 1000 }] } },
      { ok: true, adapter_used: "b", confidence_overall: 0.8, normalized: { lines: [{ unitPrice: 100.5, quantity: 10, amount: 1005 }] } },
      { ok: true, adapter_used: "c", confidence_overall: 0.7, normalized: { lines: [{ unitPrice: 99.9, quantity: 10, amount: 999 }] } },
    ];
    const out = augmentVoterOutput(merged, adapterResults);
    expect(out.adjusted).toBeGreaterThan(0);
    // Three adapters within 1% of each other -> majority; merged unitPrice is the running mean.
    expect(merged.lines[0].unitPrice).toBeGreaterThan(99);
    expect(merged.lines[0].unitPrice).toBeLessThan(101);
    expect(out.fieldProvenance.some((fp) => fp.field === "lines[0].unitPrice" && fp.mode === "majority")).toBe(true);
  });

  it("returns adjusted=0 when fewer than 2 ok adapters", () => {
    const merged = { lines: [] };
    const adapterResults = [
      { ok: true, adapter_used: "a", confidence_overall: 0.9, normalized: { lines: [] } },
    ];
    const out = augmentVoterOutput(merged, adapterResults);
    expect(out.adjusted).toBe(0);
  });

  it("handles totals fields", () => {
    const merged = { totals: { subtotal: 1000, tax_amount: 180, grand_total: 1180 } };
    const adapterResults = [
      { ok: true, adapter_used: "a", confidence_overall: 0.9, normalized: { totals: { subtotal: 1000, tax_amount: 180, grand_total: 1180 } } },
      { ok: true, adapter_used: "b", confidence_overall: 0.85, normalized: { totals: { subtotal: 1000.5, tax_amount: 180.09, grand_total: 1180.59 } } },
    ];
    const out = augmentVoterOutput(merged, adapterResults);
    expect(out.fieldProvenance.some((fp) => fp.field === "totals.grand_total")).toBe(true);
  });
});
