// CM P4: the operator-corrected defect rate (DPMO / sigma). Verifies the
// six-sigma math and the tenant-scoped aggregation (shipped runs × CTQ fields =
// opportunities; distinct corrections = defects).

import { describe, it, expect } from "vitest";
import { computeExtractionQuality, sigmaFromDpmo, CORE_LINE_FIELDS, CORE_HEADER_FIELDS } from "../api/eval/quality.js";

describe("sigmaFromDpmo", () => {
  it("maps the canonical six-sigma DPMO landmarks", () => {
    expect(sigmaFromDpmo(3.4)).toBeCloseTo(6, 1);       // world-class
    expect(sigmaFromDpmo(6210)).toBeCloseTo(4, 1);
    expect(sigmaFromDpmo(66807)).toBeCloseTo(3, 1);
    expect(sigmaFromDpmo(308537)).toBeCloseTo(2, 1);
  });
  it("caps at 6 for zero defects and floors at 0", () => {
    expect(sigmaFromDpmo(0)).toBe(6);
    expect(sigmaFromDpmo(1e6)).toBe(0);
  });
  it("returns null for invalid input", () => {
    expect(sigmaFromDpmo(null)).toBeNull();
    expect(sigmaFromDpmo(-5)).toBeNull();
  });
});

const makeSvc = ({ runs, corrections }) => ({
  from(table) {
    const b = {
      select() { return b; }, eq() { return b; }, gte() { return b; }, limit() { return b; },
      then(resolve) {
        if (table === "extraction_runs") return Promise.resolve({ data: runs, error: null }).then(resolve);
        if (table === "extraction_corrections") return Promise.resolve({ data: corrections, error: null }).then(resolve);
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return b;
  },
});

describe("computeExtractionQuality", () => {
  const runs = [
    { id: "A", status_reason: "ok", field_confidences: { overall: 0.9, "lines[0]": 0.8, "lines[1]": 0.8, "lines[2]": 0.8 } }, // 3 lines
    { id: "B", status_reason: "ok", field_confidences: { overall: 0.9, "lines[0]": 0.8, "lines[1]": 0.8 } },                    // 2 lines
    { id: "C", status_reason: "empty_lines", field_confidences: { overall: 0.9 } },                                            // excluded (reason)
    { id: "D", status_reason: "ok", field_confidences: { overall: 0.9 } },                                                     // skipped (0 lines)
  ];
  const corrections = [
    { extraction_run_id: "A", field_path: "lines[0].partNumber" },
    { extraction_run_id: "A", field_path: "lines[0].partNumber" }, // re-edit → deduped
    { extraction_run_id: "A", field_path: "customer.gstin" },
    { extraction_run_id: "B", field_path: "lines[1].quantity" },
    { extraction_run_id: "X", field_path: "whatever" },            // not a shipped run → ignored
  ];

  it("counts opportunities = H + L*F over shipped runs and distinct defects", async () => {
    const q = await computeExtractionQuality(makeSvc({ runs, corrections }), { tenantId: "t1" });
    const H = CORE_HEADER_FIELDS.length, F = CORE_LINE_FIELDS.length;
    expect(q.available).toBe(true);
    expect(q.shipped_runs).toBe(2);                 // A, B (C excluded, D 0-line)
    expect(q.units).toBe(5);                        // 3 + 2 lines
    expect(q.opportunities).toBe((H + 3 * F) + (H + 2 * F)); // 20 + 15 = 35
    expect(q.defects).toBe(3);                      // dedup A/partNumber, A/gstin, B/quantity; X ignored
    expect(q.corrected_runs).toBe(2);
    expect(q.escape_rate).toBeCloseTo(3 / 35, 6);
    expect(q.dpmo).toBeCloseTo((3 / 35) * 1e6, 0);
    expect(q.sigma).toBeGreaterThan(0);
    expect(q.caveat).toMatch(/lower bound/i);
  });

  it("reports zero defects as a clean run (no corrections)", async () => {
    const q = await computeExtractionQuality(makeSvc({ runs, corrections: [] }), { tenantId: "t1" });
    expect(q.defects).toBe(0);
    expect(q.escape_rate).toBe(0);
    expect(q.dpmo).toBe(0);
    expect(q.sigma).toBe(6);
  });

  it("degrades to available:false when the runs query errors", async () => {
    const svc = { from: () => ({ select() { return this; }, eq() { return this; }, gte() { return this; }, limit() { return this; }, then(r) { return Promise.resolve({ data: null, error: { message: "42P01" } }).then(r); } }) };
    const q = await computeExtractionQuality(svc, { tenantId: "t1" });
    expect(q.available).toBe(false);
    expect(q.reason).toContain("42P01");
  });
});
