// Phase F.6: tally reconciler unit tests.
//
// Pure logic tests for the comparison + finding builders. The DB-
// touching driftCheck path is covered by the integration test in
// api-tally-reconcile-endpoint.test.js with an in-memory svc.

import { describe, it, expect } from "vitest";
import { __test__ } from "../api/_lib/tally-reconciler.js";

describe("tally-reconciler / expectedTotalFromOrder", () => {
  it("reads grand_total under salesOrder", () => {
    expect(__test__.expectedTotalFromOrder({ result: { salesOrder: { grand_total: 12500 } } })).toBe(12500);
  });
  it("falls back to total then amount", () => {
    expect(__test__.expectedTotalFromOrder({ result: { salesOrder: { total: 9999 } } })).toBe(9999);
    expect(__test__.expectedTotalFromOrder({ result: { amount: 5000 } })).toBe(5000);
  });
  it("returns null when no total present", () => {
    expect(__test__.expectedTotalFromOrder({ result: { salesOrder: {} } })).toBeNull();
  });
});

describe("tally-reconciler / expectedLineCount", () => {
  it("counts lineItems in salesOrder", () => {
    expect(__test__.expectedLineCount({ result: { salesOrder: { lineItems: [{}, {}, {}] } } })).toBe(3);
  });
  it("returns 0 when no lines", () => {
    expect(__test__.expectedLineCount({ result: { salesOrder: {} } })).toBe(0);
  });
});

describe("tally-reconciler / totalMismatchFinding", () => {
  it("returns null within tolerance", () => {
    const f = __test__.totalMismatchFinding({
      tenantId: "t1", runId: "r1",
      vrec: { id: "v1", order_id: "o1", voucher_no: "VN1" },
      expected: 10000,
      actual: 10049,                    // 0.49% diff
      tolerancePct: 0.5,
    });
    expect(f).toBeNull();
  });

  it("flags warn when diff > tolerance but <= 5%", () => {
    const f = __test__.totalMismatchFinding({
      tenantId: "t1", runId: "r1",
      vrec: { id: "v1", order_id: "o1", voucher_no: "VN1" },
      expected: 10000,
      actual: 10300,                    // 3% diff
      tolerancePct: 0.5,
    });
    expect(f).toBeTruthy();
    expect(f.severity).toBe("warn");
    expect(f.diff_pct).toBe(3);
  });

  it("flags error when diff > 5%", () => {
    const f = __test__.totalMismatchFinding({
      tenantId: "t1", runId: "r1",
      vrec: { id: "v1", order_id: "o1", voucher_no: "VN1" },
      expected: 10000,
      actual: 11000,
      tolerancePct: 0.5,
    });
    expect(f.severity).toBe("error");
    expect(f.diff_pct).toBe(10);
  });
});

describe("tally-reconciler / lineCountMismatchFinding", () => {
  it("flags when expected != actual", () => {
    const f = __test__.lineCountMismatchFinding({
      tenantId: "t1", runId: "r1",
      vrec: { id: "v1", order_id: "o1", voucher_no: "VN1" },
      expected: 5, actual: 4,
    });
    expect(f).toBeTruthy();
    expect(f.finding_kind).toBe("line_count_mismatch");
    expect(f.expected.line_count).toBe(5);
    expect(f.actual.line_count).toBe(4);
  });
  it("returns null when match", () => {
    expect(__test__.lineCountMismatchFinding({ vrec: {}, expected: 3, actual: 3 })).toBeNull();
  });
});

describe("tally-reconciler / compareOne", () => {
  const baseVrec = { id: "v1", order_id: "o1", voucher_no: "VN1" };

  it("emits missing_in_tally when no Tally state", () => {
    const findings = __test__.compareOne({
      tenantId: "t1", runId: "r1",
      vrec: baseVrec, order: null, tallyState: null, tolerancePct: 0.5,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].finding_kind).toBe("missing_in_tally");
  });

  it("emits voucher_cancelled when Tally reports cancelled", () => {
    const findings = __test__.compareOne({
      tenantId: "t1", runId: "r1",
      vrec: baseVrec,
      order: { result: { salesOrder: { grand_total: 10000, lineItems: [{}] } } },
      tallyState: { cancelled: true, total: 10000, line_count: 1 },
      tolerancePct: 0.5,
    });
    expect(findings.some((f) => f.finding_kind === "voucher_cancelled_in_tally")).toBe(true);
  });

  it("emits voucher_altered when altered but not cancelled", () => {
    const findings = __test__.compareOne({
      tenantId: "t1", runId: "r1",
      vrec: baseVrec,
      order: { result: { salesOrder: { grand_total: 10000, lineItems: [{}] } } },
      tallyState: { altered: true, total: 10000, line_count: 1 },
      tolerancePct: 0.5,
    });
    expect(findings.some((f) => f.finding_kind === "voucher_altered_in_tally")).toBe(true);
  });

  it("does not emit altered when also cancelled (cancelled is the higher signal)", () => {
    const findings = __test__.compareOne({
      tenantId: "t1", runId: "r1",
      vrec: baseVrec,
      order: { result: { salesOrder: { grand_total: 10000, lineItems: [{}] } } },
      tallyState: { altered: true, cancelled: true, total: 10000, line_count: 1 },
      tolerancePct: 0.5,
    });
    expect(findings.find((f) => f.finding_kind === "voucher_altered_in_tally")).toBeUndefined();
    expect(findings.find((f) => f.finding_kind === "voucher_cancelled_in_tally")).toBeTruthy();
  });

  it("emits multiple findings when multiple drifts occur", () => {
    const findings = __test__.compareOne({
      tenantId: "t1", runId: "r1",
      vrec: baseVrec,
      order: { result: { salesOrder: { grand_total: 10000, lineItems: [{}, {}, {}] } } },
      tallyState: { altered: true, total: 11000, line_count: 2, party_gstin: "DIFFERENT" },
      tolerancePct: 0.5,
    });
    const kinds = findings.map((f) => f.finding_kind);
    expect(kinds).toContain("voucher_altered_in_tally");
    expect(kinds).toContain("total_mismatch");
    expect(kinds).toContain("line_count_mismatch");
  });

  it("emits no findings when everything matches within tolerance", () => {
    const findings = __test__.compareOne({
      tenantId: "t1", runId: "r1",
      vrec: baseVrec,
      order: { result: { salesOrder: { grand_total: 10000, lineItems: [{}, {}], customer: { gstin: "27ABCDE1234F1Z5" } } } },
      tallyState: { total: 10025, line_count: 2, party_gstin: "27ABCDE1234F1Z5" },     // 0.25% diff, in tolerance
      tolerancePct: 0.5,
    });
    expect(findings).toHaveLength(0);
  });
});

describe("tally-reconciler / DEFAULT_TOLERANCE_PCT", () => {
  it("is set to 0.50%", () => {
    expect(__test__.DEFAULT_TOLERANCE_PCT).toBe(0.50);
  });
});
