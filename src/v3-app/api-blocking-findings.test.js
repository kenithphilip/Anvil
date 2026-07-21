// CM P3b: the hard push-block on an unresolved blocking finding (line-count
// shortfall). Tests the shared predicate/projection helpers AND that the shared
// ERP guard (requireApprovedOrder) refuses a blocked order — the single choke
// point every connector inherits.

import { describe, it, expect } from "vitest";
import {
  isUnresolvedBlocker,
  firstUnresolvedBlocker,
  hasUnresolvedBlocker,
  projectAnomaliesToFindings,
  mergeBlockersForward,
  resolveFinding,
} from "../api/_lib/blocking-findings.js";
import { requireApprovedOrder } from "../api/_lib/erp-runner.js";

const blocker = () => ({ code: "line_count_shortfall", rule_id: "line_count_shortfall", severity: "ERROR", blocks: true, resolved: false, source: "extraction", detail: "PO declares 190; extracted 6" });

describe("blocking-findings predicate", () => {
  it("treats a blocks:true / known-code finding as an unresolved blocker", () => {
    expect(isUnresolvedBlocker(blocker())).toBe(true);
    expect(isUnresolvedBlocker({ code: "line_count_shortfall" })).toBe(true);
  });
  it("does NOT block on advisory findings (high/medium, or plain ERROR without blocks)", () => {
    expect(isUnresolvedBlocker({ key: "totals", severity: "high" })).toBe(false);
    expect(isUnresolvedBlocker({ code: "gst_pct_out_of_range", severity: "ERROR" })).toBe(false);
  });
  it("a resolved blocker no longer blocks", () => {
    expect(isUnresolvedBlocker({ ...blocker(), resolved: true })).toBe(false);
  });
  it("firstUnresolvedBlocker / hasUnresolvedBlocker scan an array", () => {
    const arr = [{ severity: "WARNING" }, blocker()];
    expect(hasUnresolvedBlocker(arr)).toBe(true);
    expect(firstUnresolvedBlocker(arr).code).toBe("line_count_shortfall");
    expect(hasUnresolvedBlocker([{ severity: "WARNING" }])).toBe(false);
    expect(hasUnresolvedBlocker([])).toBe(false);
  });
});

describe("projectAnomaliesToFindings", () => {
  it("projects only blocking anomaly codes into canonical blocks:true findings", () => {
    const out = projectAnomaliesToFindings([
      { code: "line_count_shortfall", severity: "error", detail: "short by 184", actual: 6, expected: 190 },
      { code: "grand_total_mismatch", severity: "error" },   // not a blocking code → ignored
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: "line_count_shortfall", severity: "ERROR", blocks: true, resolved: false, source: "extraction", actual: 6, expected: 190 });
  });
});

describe("mergeBlockersForward", () => {
  it("carries a prior unresolved extraction blocker forward when an overwrite drops it", () => {
    const merged = mergeBlockersForward([{ key: "totals", severity: "high" }], [blocker()]);
    expect(hasUnresolvedBlocker(merged)).toBe(true);   // the block survives a validation overwrite
  });
  it("does not duplicate or re-add a resolved blocker", () => {
    const merged = mergeBlockersForward([blocker()], [blocker()]);
    expect(merged.filter((f) => f.code === "line_count_shortfall")).toHaveLength(1);
    const afterResolve = mergeBlockersForward([{ severity: "high" }], [{ ...blocker(), resolved: true }]);
    expect(hasUnresolvedBlocker(afterResolve)).toBe(false);
  });
});

describe("resolveFinding", () => {
  it("marks the matching finding resolved with audit fields", () => {
    const { findings, resolved } = resolveFinding([blocker()], "line_count_shortfall", { by: "u1", at: "2026-07-21T00:00:00Z", note: "declared count wrong" });
    expect(resolved).toBe(true);
    expect(findings[0]).toMatchObject({ resolved: true, resolved_by: "u1", resolution_note: "declared count wrong" });
    expect(hasUnresolvedBlocker(findings)).toBe(false);
  });
  it("returns resolved:false when no such unresolved finding exists", () => {
    expect(resolveFinding([], "line_count_shortfall").resolved).toBe(false);
  });
});

describe("requireApprovedOrder refuses a blocked order (fleet-wide choke point)", () => {
  const approved = { approval: { payloadHash: "ph" }, payload_hash: "ph" };
  it("returns 409 ORDER_HAS_UNRESOLVED_BLOCKER when the order carries a blocker", () => {
    const guard = requireApprovedOrder({ ...approved, rule_findings: [blocker()] }, "ph");
    expect(guard).not.toBeNull();
    expect(guard.status).toBe(409);
    expect(guard.body.error.code).toBe("ORDER_HAS_UNRESOLVED_BLOCKER");
  });
  it("passes (null) once the blocker is resolved", () => {
    expect(requireApprovedOrder({ ...approved, rule_findings: [{ ...blocker(), resolved: true }] }, "ph")).toBeNull();
  });
  it("passes when there are no blocking findings", () => {
    expect(requireApprovedOrder({ ...approved, rule_findings: [{ severity: "WARNING" }] }, "ph")).toBeNull();
  });
  it("still refuses an unapproved order first (approval check unchanged)", () => {
    const guard = requireApprovedOrder({ rule_findings: [] }, "ph");
    expect(guard.body.error.code).toBe("ORDER_NOT_APPROVED");
  });
});
